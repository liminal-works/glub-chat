import WebSocket from "ws";
import { fetchRelayList } from "../public/js/nostr/relayList.js";
import { CHAT_KIND, PRESENCE_KIND, getGeohash, getName, verifyEvent } from "./nostr.mjs";

// Use the `ws` library (not Node's built-in/undici WebSocket): it's the
// battle-tested standard the nostr ecosystem relies on and holds far more
// simultaneous relay connections reliably (the undici one tops out / drops).

const SUB_ID = "glub-api";
const MAX_GEOHASH_LEN = 32; // ignore absurd geohashes (anti-flood, mirrors the client)
const MAX_FUTURE_SECS = 120; // drop events timestamped more than this far in the future
const MAX_BACKOFF_MS = 60_000;
const REFRESH_MS = 24 * 60 * 60_000; // re-scrape the relay list daily to pick up list changes
const RETRY_MS = 5 * 60_000; // until we have any relays (e.g. a failed startup fetch), retry sooner
const PRESENCE_FRESH_MS = 5 * 60_000; // a presence is "live" if seen within this window
const PRESENCE_PRUNE_MS = 60_000; // sweep stale presences this often
// presence (kind 20001) is a high-volume heartbeat and we only ever keep the
// live window, so we must NOT let relays replay their whole presence history on
// connect: signature-verifying that backlog (~3ms each, single-threaded) across
// hundreds of relays starves the event loop and freezes the http server. Scope
// the presence subscription to just the recent window + a hard replay cap.
const PRESENCE_SINCE_SECS = PRESENCE_FRESH_MS / 1000;
const PRESENCE_REPLAY_LIMIT = 200;

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
	const presence = new Map(); // geo -> Map<pubkey, { name, teleport, lastSeen }>
	const seenIds = new Set(); // event ids already processed from relays - skip re-verifying duplicates
	const SEEN_MAX = 50_000; // bound the dedup set; cleared wholesale when it grows past this

	// returns an event's geohash if it's acceptable to store/relay, else "".
	// Only signed kind-20000 chat events with a sane geohash and a non-future
	// timestamp (skewed/forged clocks) pass.
	function acceptableGeo(ev) {
		if (!ev || ev.kind !== CHAT_KIND) return "";
		if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return "";
		if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return "";
		const geo = getGeohash(ev);
		if (!geo || geo.length > MAX_GEOHASH_LEN) return "";
		if (!verifyEvent(ev)) return "";
		return geo;
	}

	// validate + store a single event arriving from a relay. Exposed for unit
	// tests (no live relay needed). Streams to subscribers only when it's new, so
	// relays resending the same event don't double-fire.
	function ingest(ev) {
		const geo = acceptableGeo(ev);
		if (!geo) return false;
		const inserted = store.insert(ev, geo);
		if (inserted && onStored) onStored(ev, geo);
		return inserted;
	}

	// record a presence (kind-20001) heartbeat. Like chat events these are signed
	// and carry a geohash; we keep only the latest sighting per pubkey per channel
	// and let prunePresence() age them out.
	function trackPresence(ev) {
		if (!ev || ev.kind !== PRESENCE_KIND) return false;
		if (typeof ev.pubkey !== "string") return false;
		if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return false;
		const geo = getGeohash(ev);
		if (!geo || geo.length > MAX_GEOHASH_LEN) return false;
		if (!verifyEvent(ev)) return false;

		let chan = presence.get(geo);
		if (!chan) presence.set(geo, (chan = new Map()));
		const teleport = Array.isArray(ev.tags) && ev.tags.some((t) => t[0] === "t" && t[1] === "teleport");
		// lastSeen (receipt time) drives freshness/pruning; createdAt (the event's
		// own timestamp) is what the client renders as "x ago".
		chan.set(ev.pubkey, { name: getName(ev), teleport, createdAt: ev.created_at, lastSeen: Date.now() });
		return true;
	}

	// live presences for a channel, freshest first. Stale entries are skipped here
	// too so a snapshot is never stale even between prune sweeps.
	function presenceFor(geo) {
		const chan = presence.get(geo);
		if (!chan) return [];
		const cutoff = Date.now() - PRESENCE_FRESH_MS;
		const out = [];
		for (const [pubkey, p] of chan) {
			if (p.lastSeen < cutoff) continue;
			out.push({ pubkey, name: p.name, teleport: p.teleport, createdAt: p.createdAt });
		}
		out.sort((a, b) => b.createdAt - a.createdAt);
		return out;
	}

	function prunePresence() {
		const cutoff = Date.now() - PRESENCE_FRESH_MS;
		for (const [geo, chan] of presence) {
			for (const [pubkey, p] of chan) {
				if (p.lastSeen < cutoff) chan.delete(pubkey);
			}
			if (chan.size === 0) presence.delete(geo);
		}
	}

	// publish a client-signed event on the client's behalf (assist mode holds no
	// relay sockets of its own): validate and fan it out to every connected relay.
	// Accepts chat (stored + streamed to subscribers, always, so a re-publish can
	// re-confirm) and presence (tracked, so we and other assist clients see it).
	// Returns the relay count, or -1 if the event is invalid.
	function publish(ev) {
		if (!ev || (ev.kind !== CHAT_KIND && ev.kind !== PRESENCE_KIND)) return -1;
		if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return -1;
		if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return -1;
		const geo = getGeohash(ev);
		if (!geo || geo.length > MAX_GEOHASH_LEN) return -1;
		if (!verifyEvent(ev)) return -1;

		if (ev.kind === CHAT_KIND) {
			store.insert(ev, geo); // idempotent
			if (onStored) onStored(ev, geo);
		} else {
			trackPresence(ev); // record our own presence like any relay-sourced one
		}

		const payload = JSON.stringify(["EVENT", ev]);
		let sent = 0;
		for (const ws of sockets.values()) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(payload);
				sent++;
			}
		}
		return sent;
	}

	function handleFrame(raw) {
		let frame;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!Array.isArray(frame) || frame[0] !== "EVENT") return;
		const ev = frame[2];
		if (!ev || typeof ev.id !== "string") return;

		// the same event is relayed by many relays; verify it only on first sight.
		// (publish() takes its own path, so client re-sends still re-confirm.)
		if (seenIds.has(ev.id)) return;
		if (seenIds.size >= SEEN_MAX) seenIds.clear();
		seenIds.add(ev.id);

		if (ev.kind === PRESENCE_KIND) trackPresence(ev);
		else ingest(ev);
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

		// ws EventEmitter API. The error handler is required - an unhandled "error"
		// event would crash the process. No `limit` on the REQ, matching what the
		// prototype subscribed with.
		ws.on("open", () => {
			// two filters in one REQ: full chat history (unchanged), but presence
			// scoped to the live window so we don't ingest a giant heartbeat backlog.
			const since = Math.floor(Date.now() / 1000) - PRESENCE_SINCE_SECS;
			ws.send(
				JSON.stringify([
					"REQ",
					SUB_ID,
					{ kinds: [CHAT_KIND] },
					{ kinds: [PRESENCE_KIND], since, limit: PRESENCE_REPLAY_LIMIT },
				])
			);
		});
		ws.on("message", (data) => handleFrame(data.toString()));
		ws.on("error", () => {});
		ws.on("close", retry);
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
		setInterval(prunePresence, PRESENCE_PRUNE_MS).unref();
	}

	function stats() {
		let connected = 0;
		for (const ws of sockets.values()) {
			if (ws.readyState === WebSocket.OPEN) connected++;
		}
		return { monitored: managed.size, connected };
	}

	return { start, stats, ingest, publish, handleFrame, trackPresence, presenceFor };
}
