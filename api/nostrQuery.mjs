// General-purpose live nostr fetch for the bot: open short-lived sockets to a set
// of big general relays, REQ a filter, collect signature-verified events until we
// have enough (or time out), then close. Unlike the aggregator (which only caches
// geohash-tagged events) this reaches the whole kind-1 firehose, so commands like
// !nostr aren't limited to bitchat/geohash notes. Modeled on the one-shot pattern
// in nostr/profileEdit.js.

import { verifyEvent } from "./nostr.mjs";

export const NOSTR_RELAYS = [
	"wss://relay.damus.io",
	"wss://nos.lol",
	"wss://relay.primal.net",
	"wss://relay.snort.social",
	"wss://relay.nostr.band",
];

// image URLs are recognised by extension (same heuristic the old bot used).
const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg"];

export function extractImageUrls(text) {
	const matches = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
	return matches
		.map((url) => url.replace(/[.,!?;:]+$/g, ""))
		.filter((url) => {
			try {
				const path = new URL(url).pathname.toLowerCase();
				return IMAGE_EXTS.some((ext) => path.endsWith("." + ext));
			} catch {
				return false;
			}
		});
}

// image URLs from a nostr event: its content plus any url-bearing tags (imeta etc).
export function extractImageUrlsFromEvent(ev) {
	const urls = new Set();
	for (const u of extractImageUrls(ev.content)) urls.add(u);
	if (Array.isArray(ev.tags)) {
		for (const tag of ev.tags) {
			if (!Array.isArray(tag)) continue;
			for (const part of tag) {
				if (typeof part !== "string") continue;
				const src = part.startsWith("url ") ? part.slice(4) : part;
				for (const u of extractImageUrls(src)) urls.add(u);
			}
		}
	}
	return [...urls];
}

export function normalizeNostrTag(s) {
	return String(s || "").trim().replace(/^#/, "").toLowerCase();
}

// tests can point this at a local relay via GLUB_NOSTR_RELAYS (comma-separated).
function defaultRelays() {
	const env = (process.env.GLUB_NOSTR_RELAYS || "").trim();
	if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
	return NOSTR_RELAYS;
}

// open every relay; onOpen(ws) per connection, onFrame(frame) per array frame.
// returns close(). errors swallowed - a dead relay just never contributes.
function openPool(relays, { onOpen, onFrame }) {
	const sockets = [];
	for (const url of relays) {
		let ws;
		try {
			ws = new WebSocket(url);
		} catch {
			continue;
		}
		sockets.push(ws);
		ws.addEventListener("open", () => onOpen?.(ws));
		ws.addEventListener("error", () => {});
		ws.addEventListener("message", (msg) => {
			let frame;
			try {
				frame = JSON.parse(typeof msg.data === "string" ? msg.data : msg.data.toString());
			} catch {
				return;
			}
			if (Array.isArray(frame)) onFrame?.(frame, ws);
		});
	}
	return () => {
		for (const ws of sockets) {
			try {
				ws.close();
			} catch {}
		}
	};
}

// run a REQ across the relays and resolve the accepted events (signature-verified,
// deduped by id). Resolves early once `want` are collected, else on timeout.
// `accept(ev)` filters which events count (default: all). Never rejects.
export function queryNostr(filter, { timeoutMs = 6000, want = 12, accept = () => true, relays = defaultRelays() } = {}) {
	return new Promise((resolve) => {
		const subId = "glub-q-" + Math.random().toString(36).slice(2, 8);
		const found = [];
		const seen = new Set();
		let done = false;

		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			close();
			resolve(found);
		};

		const close = openPool(relays, {
			onOpen: (ws) => ws.send(JSON.stringify(["REQ", subId, filter])),
			onFrame: (frame) => {
				const [type, sid, ev] = frame;
				if (sid !== subId || type !== "EVENT" || !ev?.id) return;
				if (seen.has(ev.id)) return;
				seen.add(ev.id);
				if (!verifyEvent(ev)) return; // relay data is untrusted
				if (!accept(ev)) return;
				found.push(ev);
				if (found.length >= want) finish();
			},
		});

		const timer = setTimeout(finish, timeoutMs);
	});
}
