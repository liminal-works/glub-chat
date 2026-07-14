import WebSocket from "ws";
import { fetchRelayList } from "../public/js/nostr/relayList.js";
import { createMessageRateLimiter, createPresenceRateLimiter } from "../public/js/ratelimit.js";
import {
	CHAT_KIND,
	PRESENCE_KIND,
	NOTE_KIND,
	DELETE_KIND,
	getGeohash,
	getName,
	noteExpiration,
	deletionTargets,
	verifyEvent,
} from "./nostr.mjs";
import { geohashToLatLon, haversineKm } from "./geo.mjs";

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
// location notes (kind 1) are persistent, so unlike presence we do want history -
// but bounded, so a relay's kind-1 backlog can't dump unbounded work at connect.
// (non-geohash notes are dropped before signature verification, so the verify
// cost is limited to actual geohash notes.)
const NOTES_SINCE_SECS = 180 * 24 * 60 * 60; // ignore notes older than ~6 months
const NOTES_REPLAY_LIMIT = 500; // per-relay backlog cap on connect
const NOTES_PRUNE_MS = 5 * 60_000; // sweep expired/overflow notes this often

// The relay aggregator: subscribes to every relay it can, signature-verifies
// events, and stores geohash chat events. Unlike the browser client (which caps
// its own connections to save the device), the server casts as wide a net as
// possible and self-heals - reconnecting dropped relays with exponential backoff
// and periodically re-fetching the list to add newly-listed relays.
// `onStored(ev, geo)` fires once per newly-stored event so the http layer can fan
// it out to live SSE subscribers.
// `onChat(ev, geo)` (optional) fires for each accepted LIVE chat event - the global
// bot subscribes to it to track activity/language and serve commands.
const BOT_FANOUT = 16; // how many geo-nearest relays a bot reply is broadcast to

export function createAggregator(store, { onStored, onChat } = {}) {
	const sockets = new Map(); // url -> WebSocket (live attempts)
	const managed = new Set(); // every url we're keeping connected (incl. mid-backoff)
	const relayCoords = new Map(); // url -> { lat, lon } from the relay list (bot fan-out targeting)
	const presence = new Map(); // geo -> Map<pubkey, { name, teleport, lastSeen }>
	const seenIds = new Set(); // event ids already processed from relays - skip re-verifying duplicates
	const SEEN_MAX = 50_000; // bound the dedup set; cleared wholesale when it grows past this

	// live-traffic rate buckets (same module + constants the client runs; see
	// public/js/ratelimit.js). the store is a rolling most-recent-N buffer, so an
	// unmetered flood doesn't just spam subscribers - it EVICTS real history.
	// only live events are metered: each relay's stored backlog (pre-EOSE) is a
	// compressed replay of hours, and store.insert dedups it anyway.
	const chatLimiter = createMessageRateLimiter();
	const presenceLimiter = createPresenceRateLimiter();
	const noteLimiter = createMessageRateLimiter(); // notes are low-volume; reuse the chat bucket shape
	const spamDrops = { chat: 0, presence: 0, note: 0 };

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
	// relays resending the same event don't double-fire. `live` = arrived after
	// its source socket's EOSE (backlog replays bypass the rate buckets).
	function ingest(ev, live = true) {
		const geo = acceptableGeo(ev);
		if (!geo) return false;
		if (live && !chatLimiter.allow("nostr:" + ev.pubkey.toLowerCase(), ev.content)) {
			spamDrops.chat++;
			return false;
		}
		const inserted = store.insert(ev, geo);
		if (inserted && onStored) onStored(ev, geo);
		// feed the global bot every fresh live chat event (activity/language/commands).
		// only on first insert + live, so backlog replays and cross-relay duplicates
		// don't double-count or trigger stale command replies.
		if (inserted && live && onChat) onChat(ev, geo);
		return inserted;
	}

	// record a presence (kind-20001) heartbeat. Like chat events these are signed
	// and carry a geohash; we keep only the latest sighting per pubkey per channel
	// and let prunePresence() age them out.
	function trackPresence(ev, live = true) {
		if (!ev || ev.kind !== PRESENCE_KIND) return false;
		if (typeof ev.pubkey !== "string") return false;
		if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return false;
		const geo = getGeohash(ev);
		if (!geo || geo.length > MAX_GEOHASH_LEN) return false;
		if (!verifyEvent(ev)) return false;
		// bucket only after the signature proves the sender: a forged heartbeat
		// must never be able to drain a real user's bucket and mute their presence
		if (live && !presenceLimiter.allow("nostr:" + ev.pubkey.toLowerCase())) {
			spamDrops.presence++;
			return false;
		}

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

	// store a location note (kind 1). Only signed notes with a sane geohash and a
	// non-past NIP-40 expiry are cached; non-geohash kind-1 (the bulk of the global
	// text-note firehose) is dropped BEFORE the signature check, so verify cost is
	// bounded to actual geohash notes.
	function ingestNote(ev, live = true) {
		if (!ev || ev.kind !== NOTE_KIND) return false;
		if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return false;
		if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return false;
		const geo = getGeohash(ev);
		if (!geo || geo.length > MAX_GEOHASH_LEN) return false; // not a geohash note - ignore
		const expiresAt = noteExpiration(ev);
		if (expiresAt != null && expiresAt <= Math.floor(Date.now() / 1000)) return false; // already expired
		if (!verifyEvent(ev)) return false;
		if (live && !noteLimiter.allow("nostr:" + ev.pubkey.toLowerCase(), ev.content)) {
			spamDrops.note++;
			return false;
		}
		return store.insertNote(ev, geo.toLowerCase(), expiresAt);
	}

	// honor a NIP-09 deletion (kind 5): drop any cached note it references, but only
	// notes authored by the deletion's signer (store.deleteNote enforces this too).
	function handleDeletion(ev, _live = true) {
		if (!ev || ev.kind !== DELETE_KIND) return false;
		if (typeof ev.pubkey !== "string") return false;
		const targets = deletionTargets(ev);
		if (targets.length === 0) return false;
		if (!verifyEvent(ev)) return false;
		let removed = 0;
		for (const id of targets) removed += store.deleteNote(id, ev.pubkey);
		return removed > 0;
	}

	// publish a client-signed event on the client's behalf (assist mode holds no
	// relay sockets of its own): validate and fan it out to every connected relay.
	// Accepts chat (stored + streamed to subscribers), presence (tracked), location
	// notes (cached), and note deletions (applied to the cache). Returns the relay
	// count, or -1 if the event is invalid.
	function publish(ev) {
		if (!ev || typeof ev.id !== "string" || typeof ev.pubkey !== "string") return -1;
		if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return -1;

		if (ev.kind === CHAT_KIND || ev.kind === PRESENCE_KIND) {
			const geo = getGeohash(ev);
			if (!geo || geo.length > MAX_GEOHASH_LEN) return -1;
			if (!verifyEvent(ev)) return -1;
			if (ev.kind === CHAT_KIND) {
				const inserted = store.insert(ev, geo); // idempotent
				if (inserted && onStored) onStored(ev, geo);
				// assist-mode clients send here instead of to relays, so this is the
				// bot's only sight of their chat + commands. Gate on `inserted` so the
				// relay echo of this same event (via handleFrame->ingest) can't re-fire.
				if (inserted && onChat) onChat(ev, geo);
			} else {
				trackPresence(ev); // record our own presence like any relay-sourced one
			}
		} else if (ev.kind === NOTE_KIND) {
			const geo = getGeohash(ev);
			if (!geo || geo.length > MAX_GEOHASH_LEN) return -1;
			const expiresAt = noteExpiration(ev);
			if (expiresAt != null && expiresAt <= Math.floor(Date.now() / 1000)) return -1;
			if (!verifyEvent(ev)) return -1;
			store.insertNote(ev, geo.toLowerCase(), expiresAt); // idempotent
		} else if (ev.kind === DELETE_KIND) {
			const targets = deletionTargets(ev);
			if (targets.length === 0) return -1;
			if (!verifyEvent(ev)) return -1;
			for (const id of targets) store.deleteNote(id, ev.pubkey); // NIP-09, author-scoped
		} else {
			return -1;
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

	// the N connected relays nearest a geohash's center, for bounded bot fan-out.
	// A non-geocodable channel (word-channel) or missing coords falls back to the
	// first N connected relays in whatever order.
	function nearestConnectedRelays(geo, count) {
		const open = [];
		for (const [url, ws] of sockets) if (ws.readyState === WebSocket.OPEN) open.push(url);

		const center = geohashToLatLon(geo);
		if (!center) return open.slice(0, count);

		return open
			.map((url) => {
				const c = relayCoords.get(url);
				const km = c ? haversineKm(center.lat, center.lon, c.lat, c.lon) : Infinity;
				return { url, km };
			})
			.sort((a, b) => a.km - b.km)
			.slice(0, count)
			.map((x) => x.url);
	}

	// broadcast a server-originated (bot) chat event: store + stream it so it shows
	// in glub's own feed like any message, then fan it out to the geo-nearest relays
	// (bounded, so the bot isn't a network-wide amplifier). Returns the relay count.
	function broadcast(ev, geo, count = BOT_FANOUT) {
		if (!ev || typeof ev.id !== "string") return 0;
		if (ev.kind === CHAT_KIND && geo) {
			if (store.insert(ev, geo) && onStored) onStored(ev, geo); // idempotent; surface locally
		}
		const payload = JSON.stringify(["EVENT", ev]);
		let sent = 0;
		for (const url of nearestConnectedRelays(geo, count)) {
			const ws = sockets.get(url);
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(payload);
				sent++;
			}
		}
		return sent;
	}

	// `conn` is the per-socket state ({ eosed }); direct callers (tests, one-off
	// frames) default to live, the stricter path.
	function handleFrame(raw, conn = { eosed: true }) {
		let frame;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!Array.isArray(frame)) return;

		// end of this relay's stored backlog - everything after arrives live and
		// is subject to the rate buckets.
		if (frame[0] === "EOSE" && frame[1] === SUB_ID) {
			conn.eosed = true;
			return;
		}

		if (frame[0] !== "EVENT") return;
		const ev = frame[2];
		if (!ev || typeof ev.id !== "string") return;

		// the same event is relayed by many relays; verify it only on first sight.
		// (publish() takes its own path, so client re-sends still re-confirm.)
		if (seenIds.has(ev.id)) return;
		if (seenIds.size >= SEEN_MAX) seenIds.clear();
		seenIds.add(ev.id);

		if (ev.kind === PRESENCE_KIND) trackPresence(ev, conn.eosed);
		else if (ev.kind === NOTE_KIND) ingestNote(ev, conn.eosed);
		else if (ev.kind === DELETE_KIND) handleDeletion(ev, conn.eosed);
		else ingest(ev, conn.eosed);
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
			const now = Math.floor(Date.now() / 1000);
			const since = now - PRESENCE_SINCE_SECS;
			ws.send(
				JSON.stringify([
					"REQ",
					SUB_ID,
					{ kinds: [CHAT_KIND] },
					{ kinds: [PRESENCE_KIND], since, limit: PRESENCE_REPLAY_LIMIT },
					// location notes + their NIP-09 deletions, bounded history
					{ kinds: [NOTE_KIND, DELETE_KIND], since: now - NOTES_SINCE_SECS, limit: NOTES_REPLAY_LIMIT },
				])
			);
		});
		const conn = { eosed: false }; // per-socket backlog/live phase (see handleFrame)
		ws.on("message", (data) => handleFrame(data.toString(), conn));
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
		for (const { url, lat, lon } of relays) {
			if (Number.isFinite(lat) && Number.isFinite(lon)) relayCoords.set(url, { lat, lon });
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
		store.pruneNotes(); // sweep any expired notes carried across a restart
		setInterval(() => store.pruneNotes(), NOTES_PRUNE_MS).unref();
	}

	function stats() {
		let connected = 0;
		for (const ws of sockets.values()) {
			if (ws.readyState === WebSocket.OPEN) connected++;
		}
		return { monitored: managed.size, connected, spamDrops: { ...spamDrops } };
	}

	return { start, stats, ingest, ingestNote, handleDeletion, publish, broadcast, handleFrame, trackPresence, presenceFor };
}
