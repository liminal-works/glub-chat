import { fetchRelayList } from "../public/js/nostr/relayList.js";
import { CHAT_KIND, getGeohash, verifyEvent } from "./nostr.mjs";

const SUB_ID = "glub-api";
const MAX_GEOHASH_LEN = 32; // ignore absurd geohashes (anti-flood, mirrors the client)
const MAX_FUTURE_SECS = 120; // drop events timestamped more than this far in the future
const MAX_BACKOFF_MS = 60_000;
const REQ_LIMIT = 500; // backlog asked of each relay on (re)connect
const REFRESH_MS = 24 * 60 * 60_000; // re-scrape the relay list daily to pick up list changes
const RETRY_MS = 5 * 60_000; // until we have any relays (e.g. a failed startup fetch), retry sooner

// The relay aggregator: subscribes to every relay it can, signature-verifies
// events, and stores geohash chat events. Unlike the browser client (which caps
// its own connections to save the device), the server casts as wide a net as
// possible and self-heals - reconnecting dropped relays with exponential backoff
// and periodically re-fetching the list to add newly-listed relays.
// `onStored(ev, geo)` fires once per newly-stored event so the http layer can fan
// it out to live SSE subscribers.
export function createAggregator(store, { onStored } = {}) {
	const sockets = new Map(); // url -> WebSocket (live attempts)
	const managed = new Set(); // every url we're keeping connected (incl. mid-backoff)

	// validate + store a single event. Exposed for unit tests (no live relay
	// needed): only signed kind-20000 chat events with a sane geohash are kept,
	// and we reject far-future timestamps (skewed/forged clocks).
	function ingest(ev) {
		if (!ev || ev.kind !== CHAT_KIND) return false;
		if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return false;
		if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return false;
		const geo = getGeohash(ev);
		if (!geo || geo.length > MAX_GEOHASH_LEN) return false;
		if (!verifyEvent(ev)) return false;

		const inserted = store.insert(ev, geo);
		if (inserted && onStored) onStored(ev, geo);
		return inserted;
	}

	function handleFrame(raw) {
		let frame;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!Array.isArray(frame) || frame[0] !== "EVENT") return;
		ingest(frame[2]);
	}

	function connectRelay(url, attempt = 0) {
		let ws;
		try {
			ws = new WebSocket(url);
		} catch {
			scheduleReconnect(url, attempt);
			return;
		}
		sockets.set(url, ws);

		let reconnected = false;
		const retry = () => {
			if (reconnected) return;
			reconnected = true;
			if (sockets.get(url) === ws) sockets.delete(url);
			scheduleReconnect(url, attempt);
		};

		ws.addEventListener("open", () => {
			ws.send(JSON.stringify(["REQ", SUB_ID, { kinds: [CHAT_KIND], limit: REQ_LIMIT }]));
		});
		ws.addEventListener("message", (msg) => handleFrame(msg.data));
		ws.addEventListener("error", () => {});
		ws.addEventListener("close", retry);
	}

	function scheduleReconnect(url, attempt) {
		const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt + 1, 6));
		setTimeout(() => connectRelay(url, attempt + 1), delay);
	}

	// fetch the relay list and start connecting to any relays we aren't already
	// managing. Safe to call repeatedly - existing connections are left alone.
	async function loadAndConnect() {
		let relays;
		try {
			relays = await fetchRelayList();
		} catch (err) {
			console.error(`[aggregator] could not fetch relay list: ${err.message}`);
			return;
		}
		let added = 0;
		for (const { url } of relays) {
			if (managed.has(url)) continue;
			managed.add(url);
			connectRelay(url);
			added++;
		}
		if (added) console.log(`[aggregator] connecting to ${added} relays (${managed.size} total)`);
	}

	// re-scrape on the long (daily) cycle once we're up, but back off to a short
	// retry while we still have zero relays (e.g. the startup fetch failed), so a
	// transient hiccup doesn't leave the api dead until tomorrow.
	function scheduleRefresh() {
		const delay = managed.size > 0 ? REFRESH_MS : RETRY_MS;
		setTimeout(async () => {
			await loadAndConnect();
			scheduleRefresh();
		}, delay).unref();
	}

	async function start() {
		await loadAndConnect();
		scheduleRefresh();
	}

	function stats() {
		let connected = 0;
		for (const ws of sockets.values()) {
			if (ws.readyState === WebSocket.OPEN) connected++;
		}
		return { monitored: managed.size, connected };
	}

	return { start, stats, ingest, handleFrame };
}
