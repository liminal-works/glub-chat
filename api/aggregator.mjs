import { fetchRelayList } from "../public/js/nostr/relayList.js";
import { CHAT_KIND, getGeohash, verifyEvent } from "./nostr.mjs";

const SUB_ID = "glub-api";
const MAX_RELAYS = 200; // bound how many sockets the aggregator holds open
const MAX_GEOHASH_LEN = 32; // ignore absurd geohashes (anti-flood, mirrors the client)
const MAX_BACKOFF_MS = 60_000;
const REQ_LIMIT = 500; // backlog asked of each relay on (re)connect

// The relay aggregator: subscribes broadly to relays, signature-verifies events,
// and stores geohash chat events. `onStored(ev, geo)` fires once per newly-stored
// event so the http layer can fan it out to live SSE subscribers.
export function createAggregator(store, { onStored } = {}) {
	const sockets = new Map(); // url -> WebSocket (live attempts)
	let relayUrls = []; // the set we cycle through, length is the "monitored" count

	// validate + store a single event. Exposed for unit tests (no live relay
	// needed): only signed kind-20000 chat events with a sane geohash are kept.
	function ingest(ev) {
		if (!ev || ev.kind !== CHAT_KIND) return false;
		if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return false;
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

	async function start() {
		let relays;
		try {
			relays = await fetchRelayList();
		} catch (err) {
			console.error(`[aggregator] could not fetch relay list: ${err.message}`);
			return;
		}
		relayUrls = relays.map((r) => r.url).slice(0, MAX_RELAYS);
		console.log(`[aggregator] subscribing to ${relayUrls.length} relays`);
		for (const url of relayUrls) connectRelay(url);
	}

	function stats() {
		let connected = 0;
		for (const ws of sockets.values()) {
			if (ws.readyState === WebSocket.OPEN) connected++;
		}
		return { monitored: relayUrls.length, connected };
	}

	return { start, stats, ingest, handleFrame };
}
