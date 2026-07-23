// Location notes: bitchat's persistent per-geohash bulletin board, as a self-
// contained relay client. Notes are stored (non-ephemeral) nostr kind-1 events
// tagged to a geohash, so unlike the live chat firehose they accrue on relays
// and can be fetched on demand. This module owns its own sockets to the geo-
// nearest relays for one channel at a time - independent of the main chat pool
// and of assist mode, exactly like the DM client - and exposes open/post/remove.
//
// A channel shows the notes of its whole neighborhood: everything nested under
// it at any depth (#9q surfaces notes posted in #9qh5, #9q5cc, ...) PLUS the 8
// surrounding cells at the same precision - native bitchat's semantics, because
// a note pinned one block over is still "here" for a reader near a cell edge.
// Since `#g` filters can't prefix-match, notes are gathered in additive passes:
//   0. the persistent local cache: every note this client has ever verified,
//      any channel, seeds the sheet instantly (and keeps it usable offline);
//   1. a deliberate `#g` request for the channel + its 8 neighbors (native's
//      exact filter shape), over the geo-nearest relays AND a few high-traffic
//      anchor relays - other nostr clients post geo-tagged notes to the big
//      relays without ever touching the geo directory, so a purely geo-nearest
//      reader misses them (measured, not hypothetical);
//   2. a firehose scan of recent kind-1 events - drop anything without a `g`
//      tag, keep whatever's tagged in the neighborhood. Steps 1+2 run over our
//      own relay sockets and stand alone with no server dependency;
//   3. (only with server assist on) a backfill from the API's long-lived note
//      cache. Purely additive - ingest() dedups across all passes.
// Everything shown is capped at the newest MAX_NOTES.
//
// Relay selection: the nearest-N DISTINCT relay hosts (the directory CSV spells
// some relays two ways; treating those as two slots silently narrowed coverage),
// with the rest of the sorted list kept as spares - a relay that won't connect
// is swapped for the next-nearest instead of being retried forever.
//
// createNotesClient({ getIdentity, getRelays, onChange, assist })
//   getIdentity() -> { sk, pk }   (glub's single global identity; notes are not
//                                   per-geohash-derived the way native bitchat is)
//   getRelays(geohash) -> [wssUrl] nearest-first
//   onChange({ state, notes, geohash }) fires on every state/notes change

import { verifyEvent, NOTE_KIND, makeNote, makeDeleteEvent, noteExpiration, getName, getClient, geohashNeighbors } from "./protocol.js";

const MAX_NOTES = 100; // hard cap on notes we hold/show; we cut off past this
const CELLS_LIMIT = 200; // the neighborhood #g request's limit (native parity)
const SAMPLE_LIMIT = 300; // recent kind-1 events the broad filter samples per relay
const SAMPLE_LOOKBACK_SECS = 365 * 24 * 60 * 60; // don't sample notes older than ~a year
const GEO_RELAYS = 10; // distinct-host geo-nearest relays held open for a channel
const PRUNE_INTERVAL_MS = 60_000; // NIP-40 notes can lapse while the sheet is open
const ASSIST_REFETCH_MS = 20_000; // re-pull the assist cache while the sheet is open
const MAX_BACKOFF_MS = 30_000;

// high-traffic relays most nostr clients (Amethyst, Wherostr, ...) publish to by
// default. geo-tagged notes from those clients live ONLY here - never on the geo
// directory relays - so notes coverage needs both worlds. same set native
// bitchat uses as its defaults.
const ANCHOR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

// "host", "host:443", "host/" are one endpoint - dedupe key for relay slots.
const relayHost = (url) =>
	String(url)
		.replace(/^wss?:\/\//, "")
		.replace(/\/+$/, "")
		.replace(/:443$/, "");

// --- persistent note cache ---------------------------------------------------
// every verified note we ever ingest, any channel, flat by id in localStorage.
// opening a sheet seeds instantly from here (then live results merge in), and
// with zero reachable relays the sheet still shows what this client has seen.
// shared by all client instances (the channel sheet and the map's pin sweeper
// feed one another). capped to the newest CACHE_MAX, expired notes pruned.
const CACHE_KEY = "glub_notes_v1";
const CACHE_MAX = 400;
const CACHE_SAVE_DELAY_MS = 800;
let cachePending = new Map(); // id -> record awaiting the debounced save
let cacheSaveTimer = null;

function cacheLoad() {
	try {
		const o = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
		return o && typeof o === "object" ? o : {};
	} catch {
		return {};
	}
}

function cacheFlush() {
	cacheSaveTimer = null;
	if (!cachePending.size) return;
	try {
		const cur = cacheLoad();
		for (const [id, rec] of cachePending) {
			if (rec === null) delete cur[id]; // tombstone (our own NIP-09 delete)
			else cur[id] = rec;
		}
		cachePending = new Map();
		const now = Math.floor(Date.now() / 1000);
		const list = Object.values(cur)
			.filter((r) => r && r.id && (!r.expiresAt || r.expiresAt > now))
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, CACHE_MAX);
		const out = {};
		for (const r of list) out[r.id] = r;
		localStorage.setItem(CACHE_KEY, JSON.stringify(out));
	} catch {} // quota/private-mode failures just mean no persistence
}

function cachePut(rec) {
	cachePending.set(rec.id, rec);
	if (!cacheSaveTimer) cacheSaveTimer = setTimeout(cacheFlush, CACHE_SAVE_DELAY_MS);
}

function cacheDelete(id) {
	cachePending.set(id, null);
	if (!cacheSaveTimer) cacheSaveTimer = setTimeout(cacheFlush, CACHE_SAVE_DELAY_MS);
}

// `assist` (optional) routes reads/writes through the server-assist API instead
// of relays when active: { isActive(), fetchNotes(geohash) -> [event], publish(event) }.
// The API keeps a persistent cache and answers a geohash PREFIX query, so in
// assist mode a channel gets every note nested under it (any depth) - the thing
// relays can't filter. When assist is off we fall back to the direct-relay path.
export function createNotesClient({ getIdentity, getRelays, onChange, assist } = {}) {
	const sockets = new Map(); // url -> WebSocket
	let gen = 0; // bumped on open/close; stale sockets & timers no-op
	let geohash = null; // the channel we're showing notes for (lowercased)
	let cells = []; // channel + its 8 neighbors; a note counts if its g-tag starts with any
	let relaySpares = []; // sorted distinct relays beyond the initial picks (failover pool)
	let notes = []; // reverse-chron [{ id, pubkey, content, createdAt, name, geohash, expiresAt, mine }]
	const seen = new Set(); // note ids (dedupe + tombstone so deletes can't resurrect)
	let state = "idle"; // idle | loading | ready | empty | no_relays
	// two subscriptions per socket: an exact #g filter so the channel's OWN notes
	// + neighbors are always guaranteed, and a broad recent-kind-1 sample we
	// filter client-side for depth-agnostic nested notes (relays can't prefix-match #g).
	let subExact = null;
	let subBroad = null;
	let pruneTimer = null;
	let assistTimer = null; // periodic re-fetch while assist mode is serving notes
	let eosed = false;

	const nowSecs = () => Math.floor(Date.now() / 1000);
	const emit = () => onChange?.({ state, notes: notes.slice(), geohash });

	function setState(s) {
		if (state === s) return;
		state = s;
	}

	function prune() {
		const now = nowSecs();
		const before = notes.length;
		notes = notes.filter((n) => !n.expiresAt || n.expiresAt > now);
		if (notes.length !== before) emit();
	}

	// insert if new + unexpired; keep reverse-chron and capped. returns true if added.
	function insert(note) {
		if (seen.has(note.id)) return false;
		if (note.expiresAt && note.expiresAt <= nowSecs()) return false;
		seen.add(note.id);
		notes.push(note);
		notes.sort((a, b) => b.createdAt - a.createdAt);
		if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);
		return true;
	}

	// a note belongs to this sheet if its g-tag starts with the channel (nested
	// under it, any depth) or with any of the 8 neighbor cells - the neighborhood.
	function inNeighborhood(tag) {
		return cells.some((c) => tag.startsWith(c));
	}

	function ingest(ev) {
		if (ev.kind !== NOTE_KIND) return;
		if (seen.has(ev.id)) return;
		const gTag = (ev.tags || []).find(
			(t) => Array.isArray(t) && String(t[0]).toLowerCase() === "g" && inNeighborhood(String(t[1]).toLowerCase()),
		);
		if (!gTag) return;
		// relays are untrusted transport - verify the signature ourselves
		let ok = false;
		try {
			ok = verifyEvent(ev);
		} catch {
			ok = false;
		}
		if (!ok) return;
		const mine = ev.pubkey.toLowerCase() === getIdentity().pk.toLowerCase();
		const rec = {
			id: ev.id,
			pubkey: ev.pubkey,
			content: ev.content || "",
			createdAt: ev.created_at,
			name: getName(ev) || "",
			client: getClient(ev), // ["client",…] tag if the sender stamped one
			geohash: String(gTag[1]).toLowerCase(),
			expiresAt: noteExpiration(ev),
		};
		const added = insert({ ...rec, mine });
		if (added) {
			cachePut(rec); // verified once, remembered for every future open
			if (state === "loading" || state === "empty") setState("ready");
			emit();
		}
	}

	// the neighborhood's own notes (channel + 8 neighbors), relay-filtered and
	// guaranteed regardless of firehose volume - native's exact filter shape
	function cellsFilter() {
		return { kinds: [NOTE_KIND], "#g": cells, limit: CELLS_LIMIT };
	}
	// a bounded sample of recent notes; we prefix-filter these client-side so a
	// note nested any number of levels under the channel still surfaces, without a
	// depth cap. `limit` is what bounds the pull - we then keep the newest MAX_NOTES.
	function broadFilter() {
		return { kinds: [NOTE_KIND], since: nowSecs() - SAMPLE_LOOKBACK_SECS, limit: SAMPLE_LIMIT };
	}

	function connect(url, attempt = 0) {
		const myGen = gen;
		let ws;
		try {
			ws = new WebSocket(url);
		} catch {
			failover(myGen);
			return;
		}
		sockets.set(url, ws);
		let everOpened = false;

		ws.addEventListener("open", () => {
			if (myGen !== gen) return;
			everOpened = true;
			ws.send(JSON.stringify(["REQ", subExact, cellsFilter()]));
			ws.send(JSON.stringify(["REQ", subBroad, broadFilter()]));
		});

		ws.addEventListener("close", () => {
			if (sockets.get(url) === ws) sockets.delete(url);
			if (myGen !== gen) return;
			// a relay that never opened after two tries is likely dead or blocked:
			// hand its slot to the next-nearest spare instead of retrying forever.
			// one that HAD opened gets the usual backoff reconnect (transient drop).
			if (!everOpened && attempt >= 1) {
				failover(myGen);
				return;
			}
			const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt + 1, 5));
			setTimeout(() => {
				if (myGen !== gen) return;
				connect(url, attempt + 1);
			}, delay);
		});

		ws.addEventListener("error", () => {});

		ws.addEventListener("message", (msg) => {
			if (myGen !== gen) return;
			let frame;
			try {
				frame = JSON.parse(msg.data);
			} catch {
				return;
			}
			if (!Array.isArray(frame)) return;
			const sub = frame[1];
			if (sub !== subExact && sub !== subBroad) return;
			// a relay may reject the broad open-kind-1 filter; just let that sub lapse
			// (the exact #g floor still runs) instead of tearing down the socket.
			if (frame[0] === "CLOSED") return;
			if (frame[0] === "EOSE") {
				// first end-of-stored-events: if nothing landed, it's genuinely empty
				if (!eosed) {
					eosed = true;
					if (notes.length === 0 && state === "loading") setState("empty");
					else if (state === "loading") setState("ready");
					emit();
				}
				return;
			}
			if (frame[0] !== "EVENT") return;
			const ev = frame[2];
			if (ev?.id && ev?.pubkey) ingest(ev);
		});
	}

	// swap a dead relay slot for the next-nearest unused spare
	function failover(myGen) {
		if (myGen !== gen) return;
		const next = relaySpares.shift();
		if (next) connect(next, 0);
	}

	function closeAll() {
		for (const ws of sockets.values()) {
			try {
				ws.close();
			} catch {}
		}
		sockets.clear();
	}

	function broadcast(event) {
		const payload = JSON.stringify(["EVENT", event]);
		let sent = 0;
		for (const ws of sockets.values()) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(payload);
				sent++;
			}
		}
		return sent;
	}

	// --- public ----------------------------------------------------------------

	// step 3 (server assist only): backfill from the server's long-lived cache -
	// notes it caught over time that our live scan missed. Runs on open and on a
	// timer; ingest() dedups so it's purely additive on top of the relay scan.
	// The server already prefix-scoped the result; we re-verify + prefix-check each.
	async function assistRefresh() {
		const myGen = gen;
		let events = [];
		try {
			events = (await assist.fetchNotes(geohash)) || [];
		} catch {
			events = [];
		}
		if (myGen !== gen) return; // channel switched while the fetch was in flight
		eosed = true;
		for (const ev of events) if (ev?.id && ev?.pubkey) ingest(ev);
		if (state === "loading") setState(notes.length ? "ready" : "empty");
		else if (state === "empty" && notes.length) setState("ready");
		emit();
	}

	// open the notes stream for a geohash channel. safe to call repeatedly; each
	// call retargets (closes the old sockets/timers, refetches for the new cell).
	function open(gh) {
		gen++;
		closeAll();
		clearInterval(pruneTimer);
		clearInterval(assistTimer);
		geohash = String(gh).toLowerCase();
		// the neighborhood this sheet covers: the channel itself + its 8 same-depth
		// neighbors (native parity - a note pinned one block over is still "here")
		let neighbors = [];
		try {
			neighbors = geohashNeighbors(geohash);
		} catch {}
		cells = [geohash, ...neighbors];
		notes = [];
		seen.clear();
		eosed = false;
		setState("loading");
		emit();
		pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);

		// step 0: seed from the persistent cache - everything this client has ever
		// verified for this neighborhood renders immediately, before any socket.
		try {
			const pk = String(getIdentity()?.pk || "").toLowerCase();
			let seeded = false;
			for (const r of Object.values(cacheLoad())) {
				if (!r || !r.id || typeof r.geohash !== "string") continue;
				if (!inNeighborhood(r.geohash)) continue;
				if (insert({ ...r, mine: r.pubkey?.toLowerCase() === pk })) seeded = true;
			}
			if (seeded) setState("ready");
		} catch {}
		emit();

		// steps 1 + 2 (always, standalone): the neighborhood #g request plus a
		// firehose scan of recent kind-1 we filter client-side. relays are the
		// nearest GEO_RELAYS distinct hosts + the anchor relays; everything further
		// down the sorted list waits as failover spares.
		const suffix = Math.random().toString(36).slice(2, 10);
		subExact = `glub-notes-x-${suffix}`;
		subBroad = `glub-notes-b-${suffix}`;
		const distinct = [];
		const hosts = new Set();
		for (const url of getRelays(geohash) || []) {
			const h = relayHost(url);
			if (!h || hosts.has(h)) continue;
			hosts.add(h);
			distinct.push(url);
		}
		const geoPicks = distinct.slice(0, GEO_RELAYS);
		const geoHosts = new Set(geoPicks.map(relayHost));
		const anchors = ANCHOR_RELAYS.filter((a) => !geoHosts.has(relayHost(a)));
		const anchorHosts = new Set(anchors.map(relayHost));
		relaySpares = distinct.slice(GEO_RELAYS).filter((u) => !anchorHosts.has(relayHost(u)));
		const picks = [...geoPicks, ...anchors];
		for (const url of picks) connect(url, 0);

		// step 3 (with server assist): additively backfill from the server cache and
		// keep topping up while the sheet is open.
		const assisting = !!assist?.isActive?.();
		if (assisting) {
			assistRefresh();
			assistTimer = setInterval(assistRefresh, ASSIST_REFETCH_MS);
		}

		// nothing to read from at all (no relays, no assist) - though anything the
		// cache already seeded stays visible; the state only reads no_relays when
		// there's truly nothing to show or fetch.
		if (picks.length === 0 && !assisting && notes.length === 0) {
			setState("no_relays");
			emit();
		}
	}

	function close() {
		gen++;
		closeAll();
		clearInterval(pruneTimer);
		clearInterval(assistTimer);
		pruneTimer = null;
		assistTimer = null;
		setState("idle");
	}

	// publish a note to the current channel. content pre-validated by the caller.
	// expiresInSecs falsy = never expires. returns { ok, event, relays } - ok is
	// false only when signing failed; a note with zero live relays still echoes
	// locally and ships as sockets come up is out of scope (native drops it too),
	// so we surface relays===0 to let the caller warn.
	function post({ content, name, expiresInSecs, client }) {
		if (!geohash) return { ok: false, relays: 0 };
		const { sk, pk } = getIdentity();
		const expiresAt = expiresInSecs ? nowSecs() + expiresInSecs : null;
		let event;
		try {
			event = makeNote({ content, geohash, name, expiresAt, sk, pk, client });
		} catch {
			return { ok: false, relays: 0 };
		}
		// always broadcast on our own sockets (geo + anchor relays); with assist on,
		// also hand it to the API for a wider fan-out and so the server caches it.
		const relays = broadcast(event);
		if (assist?.isActive?.()) assist.publish(event);
		// optimistic local echo so the note appears instantly; cached like any
		// ingested note so it survives reloads even if every relay dropped it
		const rec = {
			id: event.id,
			pubkey: pk,
			content,
			createdAt: event.created_at,
			name: name || "",
			client: client || "",
			geohash,
			expiresAt,
		};
		if (insert({ ...rec, mine: true })) {
			cachePut(rec);
			setState("ready");
			emit();
		}
		return { ok: true, event, relays };
	}

	// NIP-09 delete one of our own notes: emit a kind-5 and drop it locally. the
	// id stays in `seen` so a relay replay can't bring it back.
	function remove(noteId) {
		const note = notes.find((n) => n.id === noteId);
		if (!note || !note.mine) return false;
		const { sk, pk } = getIdentity();
		try {
			const del = makeDeleteEvent({ eventId: noteId, sk, pk });
			broadcast(del); // always on our own sockets
			if (assist?.isActive?.()) assist.publish(del); // + wider fan-out via the API
		} catch {
			return false;
		}
		notes = notes.filter((n) => n.id !== noteId);
		cacheDelete(noteId); // the cache must not resurrect a deleted note next open
		if (notes.length === 0 && eosed) setState("empty");
		emit();
		return true;
	}

	function getState() {
		return { state, notes: notes.slice(), geohash };
	}

	return { open, close, post, remove, getState };
}
