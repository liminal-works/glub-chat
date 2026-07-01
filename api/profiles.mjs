import WebSocket from "ws";
import { METADATA_KIND, parseProfile, verifyEvent } from "./nostr.mjs";

// On-demand nostr profile (kind-0) fetcher with caching. The geohash chat relays
// don't carry profile metadata, so this keeps its own small pool of general/
// profile relays and looks a pubkey up when asked. Signature-verified; cached
// aggressively since profiles change rarely. The http layer wraps this so the
// browser never talks to profile relays (or image hosts) directly.
const PROFILE_RELAYS = ["wss://purplepag.es", "wss://relay.damus.io", "wss://relay.nostr.band"];
const CACHE_TTL_MS = 6 * 60 * 60_000; // a resolved profile is good for 6h
const NEG_TTL_MS = 30 * 60_000; // remember "no profile found" for 30m to avoid re-hammering
const LOOKUP_TIMEOUT_MS = 4000; // give up on a lookup after this
const GRACE_MS = 500; // once we have a hit, wait briefly for a newer one from another relay
const MAX_CACHE = 5000;
const RECONNECT_MS = 10_000;

export function createProfiles() {
	const sockets = new Map(); // url -> WebSocket
	const cache = new Map(); // pubkey -> { profile: {...}|null, at }
	const inflight = new Map(); // pubkey -> Promise
	const waiters = new Map(); // subId -> { pubkey, best, resolve, timer, graceTimer }
	let subCounter = 0;

	function connect(url) {
		let ws;
		try {
			ws = new WebSocket(url);
		} catch {
			return;
		}
		sockets.set(url, ws);
		ws.on("message", (data) => onMessage(data.toString()));
		ws.on("error", () => {}); // required - unhandled "error" would crash the process
		ws.on("close", () => {
			if (sockets.get(url) === ws) sockets.delete(url);
			setTimeout(() => connect(url), RECONNECT_MS).unref();
		});
	}

	function start() {
		for (const url of PROFILE_RELAYS) connect(url);
	}

	function onMessage(raw) {
		let frame;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!Array.isArray(frame)) return;
		const [type, subId, ev] = frame;
		const w = waiters.get(subId);
		if (!w) return;

		if (type === "EVENT" && ev && ev.kind === METADATA_KIND && ev.pubkey === w.pubkey) {
			if ((!w.best || ev.created_at > w.best.created_at) && verifyEvent(ev)) {
				w.best = ev;
				if (!w.graceTimer) w.graceTimer = setTimeout(() => finish(subId), GRACE_MS);
			}
		} else if (type === "EOSE" && w.best && !w.graceTimer) {
			// a relay signalled end-of-stored-events and we already have a hit
			w.graceTimer = setTimeout(() => finish(subId), GRACE_MS);
		}
	}

	function finish(subId) {
		const w = waiters.get(subId);
		if (!w) return;
		waiters.delete(subId);
		clearTimeout(w.timer);
		clearTimeout(w.graceTimer);

		const close = JSON.stringify(["CLOSE", subId]);
		for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(close);

		const profile = w.best ? parseProfile(w.best) : null;
		if (cache.size >= MAX_CACHE) cache.clear();
		cache.set(w.pubkey, { profile, at: Date.now() });
		inflight.delete(w.pubkey);
		w.resolve(profile);
	}

	// resolve a pubkey's profile (or null). cached; concurrent calls share one lookup.
	function get(pubkey) {
		if (!/^[0-9a-f]{64}$/.test(pubkey)) return Promise.resolve(null);

		const hit = cache.get(pubkey);
		if (hit && Date.now() - hit.at < (hit.profile ? CACHE_TTL_MS : NEG_TTL_MS)) {
			return Promise.resolve(hit.profile);
		}
		if (inflight.has(pubkey)) return inflight.get(pubkey);

		const promise = new Promise((resolve) => {
			const subId = `p${subCounter++}`;
			const w = { pubkey, best: null, resolve, timer: null, graceTimer: null };
			w.timer = setTimeout(() => finish(subId), LOOKUP_TIMEOUT_MS);
			waiters.set(subId, w);

			const req = JSON.stringify(["REQ", subId, { kinds: [METADATA_KIND], authors: [pubkey], limit: 1 }]);
			let sent = false;
			for (const ws of sockets.values()) {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(req);
					sent = true;
				}
			}
			if (!sent) finish(subId); // no relay connected yet -> resolve null now
		});
		inflight.set(pubkey, promise);
		return promise;
	}

	return { start, get };
}
