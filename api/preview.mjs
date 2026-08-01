// Link previews: fetch a page and pull its OpenGraph card out of the <head>.
//
// This is an assist-only nicety, and deliberately so. A pure browser client cannot
// read another origin's HTML - CORS forbids it - so the only way to unfurl a general
// link is to have a server do it. That means the server learns which links get
// posted, which is a real cost and the reason the client only asks when server
// assist is already on (see previewUrl in app.js). The same boundary /api/translate
// already crosses, and it crosses it with less: message text, not just a url.
//
// SECURITY: this endpoint takes a url from a stranger and makes the server fetch it.
// Unguarded that is a straight pivot into whatever the server can reach - cloud
// metadata endpoints, admin panels on localhost, the private subnet. Everything
// below exists for that reason:
//   * http/https only. no file:, no gopher:, no data:.
//   * every hop's host is resolved and checked against the private ranges BEFORE the
//     request goes out, so a public hostname with a 127.0.0.1 A record doesn't get a
//     free pass. Redirects are followed by hand for the same reason - `redirect:
//     "follow"` would do the second hop without asking us.
//   * a byte cap, because <head> is all we want and a hostile server will happily
//     stream forever.
//   * a timeout, so one slow host can't tie up a socket indefinitely.
import { lookup } from "node:dns/promises";

const TIMEOUT_MS = 5000;
const MAX_BYTES = 262_144; // 256KB: comfortably past </head> on any real page
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h - og cards are near-static
const CACHE_MAX = 500;

const cache = new Map(); // url -> { at, data }

// Everything that isn't a routable public address. Checked per-hop against the
// RESOLVED ip, which is the only check that actually means anything.
function isPrivateIp(ip) {
	const v = String(ip || "");
	if (v.includes(":")) {
		const s = v.toLowerCase();
		// ipv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10)
		if (s === "::1" || s === "::") return true;
		if (/^f[cd]/.test(s)) return true;
		if (/^fe[89ab]/.test(s)) return true;
		// ipv4-mapped (::ffff:10.0.0.1) has to be unwrapped, not trusted
		const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (m) return isPrivateIp(m[1]);
		return false;
	}
	const p = v.split(".").map(Number);
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable = refuse
	const [a, b] = p;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata at 169.254.169.254
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade nat
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (test-net)
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a >= 224) return true; // multicast + reserved
	return false;
}

async function assertPublic(urlObj) {
	if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") throw new Error("scheme");
	// an ipv6 literal arrives bracketed ("[::1]"), which no resolver accepts - so it
	// would be refused for FAILING DNS rather than for being loopback. Same outcome
	// today, but for the wrong reason, and a resolver that ever obliged would quietly
	// open the hole. Classify literals directly instead of routing them through DNS.
	const host = urlObj.hostname.replace(/^\[|\]$/g, "");
	if (/^[\d.]+$/.test(host) || host.includes(":")) {
		if (isPrivateIp(host)) throw new Error("private");
		return;
	}
	let resolved;
	try {
		resolved = await lookup(host, { all: true });
	} catch {
		throw new Error("dns");
	}
	if (!resolved.length) throw new Error("dns");
	// ALL of them: a host that resolves to one public and one private address is not
	// a host we're willing to talk to.
	for (const r of resolved) if (isPrivateIp(r.address)) throw new Error("private");
}

// read at most MAX_BYTES of the body, then stop pulling. Returns decoded text.
async function readCapped(res) {
	const reader = res.body?.getReader?.();
	if (!reader) return "";
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			chunks.push(total > MAX_BYTES ? value.subarray(0, value.length - (total - MAX_BYTES)) : value);
			if (total >= MAX_BYTES) break;
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
	}
	return Buffer.concat(chunks).toString("utf8");
}

function decodeEntities(s) {
	return String(s || "")
		.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp|#39));/gi, (m, dec, hex, name) => {
			if (dec) return String.fromCodePoint(Number(dec));
			if (hex) return String.fromCodePoint(parseInt(hex, 16));
			return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" }[String(name).toLowerCase()] || m;
		})
		.trim();
}

// pull one meta value. Handles both attribute orders (`property` before or after
// `content`), which real pages use interchangeably.
function meta(html, names) {
	for (const name of names) {
		const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const patterns = [
			new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i"),
			new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, "i"),
		];
		for (const re of patterns) {
			const m = html.match(re);
			if (m && m[1].trim()) return decodeEntities(m[1]);
		}
	}
	return "";
}

function clip(s, n) {
	const v = String(s || "").replace(/\s+/g, " ").trim();
	return v.length > n ? v.slice(0, n - 1) + "…" : v;
}

// Pull the card out of a page's markup. Exported on its own because the fetch path is
// fenced off from every host a test could stand up locally - which is the point - so
// this is the half that can actually be exercised directly.
export function parsePreview(html, currentUrl) {
	const current = typeof currentUrl === "string" ? new URL(currentUrl) : currentUrl;
	return {
		url: current.href,
		title: clip(
			meta(html, ["og:title", "twitter:title"]) ||
				decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""),
			120,
		),
		description: clip(meta(html, ["og:description", "twitter:description", "description"]), 200),
		image: (() => {
			const raw = meta(html, ["og:image", "og:image:url", "twitter:image"]);
			if (!raw) return "";
			try {
				const abs = new URL(raw, current);
				return abs.protocol === "https:" || abs.protocol === "http:" ? abs.href : "";
			} catch {
				return "";
			}
		})(),
		site: clip(meta(html, ["og:site_name"]) || current.hostname.replace(/^www\./, ""), 40),
	};
}

// fetch + parse, following redirects by hand so every hop is re-checked.
export async function fetchPreview(rawUrl) {
	const hit = cache.get(rawUrl);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("bad url");
	}

	let res;
	let current = url;
	for (let hop = 0; ; hop++) {
		await assertPublic(current);
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
		try {
			res = await fetch(current.href, {
				redirect: "manual",
				signal: ctl.signal,
				headers: {
					// plenty of sites serve a bare page to unknown agents; asking as a normal
					// browser is what gets the og tags we're here for.
					"User-Agent": "Mozilla/5.0 (compatible; glub.chat link preview)",
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "en",
				},
			});
		} finally {
			clearTimeout(timer);
		}
		if (res.status < 300 || res.status >= 400) break;
		const loc = res.headers.get("location");
		if (!loc || hop >= MAX_REDIRECTS) break;
		try {
			current = new URL(loc, current);
		} catch {
			break;
		}
	}

	if (!res.ok) throw new Error(`http ${res.status}`);
	const type = String(res.headers.get("content-type") || "");
	if (!/text\/html|application\/xhtml/i.test(type)) throw new Error("not html");

	const html = await readCapped(res);
	const data = parsePreview(html, current);
	// a card with nothing in it is worse than no card - the client shows the bare
	// link instead, which at least doesn't pretend to have unfurled anything.
	if (!data.title && !data.image) throw new Error("nothing to show");

	cache.set(rawUrl, { at: Date.now(), data });
	if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
	return data;
}
