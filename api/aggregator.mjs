import { fetchRelayList } from "../public/js/nostr/relayList.js";
import { CHAT_KIND, getGeohash, verifyEvent } from "./nostr.mjs";

const SUB_ID = "glub-api";
const MAX_RELAYS = 200; // bound how many sockets the aggregator holds open
const MAX_GEOHASH_LEN = 32; // ignore absurd geohashes (anti-flood, mirrors the client)
const MAX_BACKOFF_MS = 60_000;
const REQ_LIMIT = 500; // backlog asked of each relay on (re)connect

// validate + store a single event. Exported so it's unit-testable without a
// live relay: only signed kind-20000 chat events carrying a sane geohash are
// kept, and the signature is verified before anything touches the store.
export function ingestEvent(store, ev) {
	if (!ev || ev.kind !== CHAT_KIND) return false;
	if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return false;
	const geo = getGeohash(ev);
	if (!geo || geo.length > MAX_GEOHASH_LEN) return false;
	if (!verifyEvent(ev)) return false;
	return store.insert(ev, geo);
}

export function handleFrame(store, raw) {
	let frame;
	try {
		frame = JSON.parse(raw);
	} catch {
		return;
	}
	if (!Array.isArray(frame) || frame[0] !== "EVENT") return;
	ingestEvent(store, frame[2]);
}

export async function startAggregator(store) {
	let relays;
	try {
		relays = await fetchRelayList();
	} catch (err) {
		console.error(`[aggregator] could not fetch relay list: ${err.message}`);
		return;
	}

	const urls = relays.map((r) => r.url).slice(0, MAX_RELAYS);
	console.log(`[aggregator] subscribing to ${urls.length} relays`);
	for (const url of urls) connectRelay(store, url);
}

function connectRelay(store, url, attempt = 0) {
	let ws;
	try {
		ws = new WebSocket(url);
	} catch {
		scheduleReconnect(store, url, attempt);
		return;
	}

	let reconnected = false;
	const retry = () => {
		if (reconnected) return;
		reconnected = true;
		scheduleReconnect(store, url, attempt);
	};

	ws.addEventListener("open", () => {
		ws.send(JSON.stringify(["REQ", SUB_ID, { kinds: [CHAT_KIND], limit: REQ_LIMIT }]));
	});
	ws.addEventListener("message", (msg) => handleFrame(store, msg.data));
	ws.addEventListener("error", () => {});
	ws.addEventListener("close", retry);
}

function scheduleReconnect(store, url, attempt) {
	const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt + 1, 6));
	setTimeout(() => connectRelay(store, url, attempt + 1), delay);
}
