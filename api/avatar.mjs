import { lookup } from "node:dns/promises";
import net from "node:net";

// Proxies a profile's avatar through the api so the browser never hits the image
// host directly (keeps the viewer's IP private - the whole point of routing this
// server-side). Because the picture url comes from an untrusted profile, this is
// an outbound proxy and must be guarded against SSRF: http(s) only, no private/
// loopback targets (checked after DNS resolution, and on every redirect hop),
// image content-types only, and a hard size cap. gifs (image/gif) pass fine.
const MAX_BYTES = 5 * 1024 * 1024; // generous enough for real avatars incl. animated gifs
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

// is this a resolved IP we must never proxy to? (loopback, private, link-local,
// unique-local, CGNAT, multicast/reserved, v4-mapped v6).
export function isPrivateIp(ip) {
	if (net.isIPv4(ip)) {
		const p = ip.split(".").map(Number);
		if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
		const [a, b] = p;
		if (a === 0 || a === 127 || a === 10) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 169 && b === 254) return true; // link-local
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		if (a >= 224) return true; // multicast / reserved
		return false;
	}
	const ip6 = ip.toLowerCase();
	if (ip6 === "::1" || ip6 === "::") return true;
	if (ip6.startsWith("::ffff:")) return isPrivateIp(ip6.slice(7)); // v4-mapped
	if (ip6.startsWith("fe80")) return true; // link-local
	if (ip6[0] === "f" && (ip6[1] === "c" || ip6[1] === "d")) return true; // unique-local fc00::/7
	return false;
}

// http(s) + non-private resolved target, else throws.
async function assertPublicUrl(rawUrl) {
	const url = new URL(rawUrl); // throws on garbage
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad scheme");
	if (net.isIP(url.hostname) && isPrivateIp(url.hostname)) throw new Error("private host");
	const { address } = await lookup(url.hostname);
	if (isPrivateIp(address)) throw new Error("private host");
	return url;
}

export async function proxyAvatar(rawUrl, res) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	timer.unref();
	res.on("close", () => clearTimeout(timer));

	try {
		let current = rawUrl;
		let upstream;
		for (let hop = 0; ; hop++) {
			await assertPublicUrl(current); // re-validate every hop (redirects included)
			upstream = await fetch(current, { signal: controller.signal, redirect: "manual" });
			const loc = upstream.headers.get("location");
			if (upstream.status >= 300 && upstream.status < 400 && loc) {
				if (hop >= MAX_REDIRECTS) {
					res.status(502).end();
					return;
				}
				current = new URL(loc, current).toString();
				continue;
			}
			break;
		}

		const type = upstream.headers.get("content-type") || "";
		if (!upstream.ok || !type.startsWith("image/")) {
			res.status(415).end();
			return;
		}
		const declared = Number(upstream.headers.get("content-length") || 0);
		if (declared && declared > MAX_BYTES) {
			res.status(413).end();
			return;
		}
		if (!upstream.body) {
			res.end();
			return;
		}

		// buffer with a hard cap: an over-cap image fails cleanly (broken <img> ->
		// no avatar) instead of streaming a truncated, corrupt body.
		const reader = upstream.body.getReader();
		const chunks = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > MAX_BYTES) {
				await reader.cancel();
				res.status(413).end();
				return;
			}
			chunks.push(Buffer.from(value));
		}

		res.set("Content-Type", type);
		res.set("Cache-Control", "public, max-age=86400");
		res.end(Buffer.concat(chunks));
	} catch {
		if (!res.headersSent) res.status(502).end();
	}
}
