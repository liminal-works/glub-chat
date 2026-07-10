// Location notes: bitchat's persistent per-geohash bulletin board, as a self-
// contained relay client. Notes are stored (non-ephemeral) nostr kind-1 events
// tagged to a geohash, so unlike the live chat firehose they accrue on relays
// and can be fetched on demand. This module owns its own sockets to the geo-
// nearest relays for one channel at a time - independent of the main chat pool
// and of assist mode, exactly like the DM client - and exposes open/post/remove.
//
// createNotesClient({ getIdentity, getRelays, onChange })
//   getIdentity() -> { sk, pk }   (glub's single global identity; notes are not
//                                   per-geohash-derived the way native bitchat is)
//   getRelays(geohash) -> [wssUrl] nearest-first
//   onChange({ state, notes, geohash }) fires on every state/notes change

import { verifyEvent, NOTE_KIND, makeNote, makeDeleteEvent, noteExpiration, geohashNeighbors, getName } from "./protocol.js";

const REQ_LIMIT = 200; // matches native's relay-side cap
const MAX_NOTES = 500; // defensive in-memory cap
const MAX_RELAYS = 6; // how many geo-nearest relays we hold open for a channel
const PRUNE_INTERVAL_MS = 60_000; // NIP-40 notes can lapse while the sheet is open
const MAX_BACKOFF_MS = 30_000;

export function createNotesClient({ getIdentity, getRelays, onChange }) {
	const sockets = new Map(); // url -> WebSocket
	let gen = 0; // bumped on open/close; stale sockets & timers no-op
	let geohash = null; // the channel we're showing notes for (lowercased)
	let cells = new Set(); // valid g-tag values: center + 8 neighbors, lowercased
	let notes = []; // reverse-chron [{ id, pubkey, content, createdAt, name, geohash, expiresAt, mine }]
	const seen = new Set(); // note ids (dedupe + tombstone so deletes can't resurrect)
	let state = "idle"; // idle | loading | ready | empty | no_relays
	let subId = null;
	let pruneTimer = null;
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

	function ingest(ev) {
		if (ev.kind !== NOTE_KIND) return;
		if (seen.has(ev.id)) return;
		// accept a note tagged to any of our 9 cells (a neighbor edge post counts)
		const gTag = (ev.tags || []).find(
			(t) => Array.isArray(t) && String(t[0]).toLowerCase() === "g" && cells.has(String(t[1]).toLowerCase()),
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
		const added = insert({
			id: ev.id,
			pubkey: ev.pubkey,
			content: ev.content || "",
			createdAt: ev.created_at,
			name: getName(ev) || "",
			geohash: String(gTag[1]).toLowerCase(),
			expiresAt: noteExpiration(ev),
			mine,
		});
		if (added) {
			if (state === "loading" || state === "empty") setState("ready");
			emit();
		}
	}

	function filter() {
		return { kinds: [NOTE_KIND], "#g": [...cells], limit: REQ_LIMIT };
	}

	function connect(url, attempt = 0) {
		const myGen = gen;
		let ws;
		try {
			ws = new WebSocket(url);
		} catch {
			return;
		}
		sockets.set(url, ws);

		ws.addEventListener("open", () => {
			if (myGen !== gen) return;
			ws.send(JSON.stringify(["REQ", subId, filter()]));
		});

		ws.addEventListener("close", () => {
			if (sockets.get(url) === ws) sockets.delete(url);
			if (myGen !== gen) return;
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
			if (frame[0] === "CLOSED" && frame[1] === subId) {
				ws.close();
				return;
			}
			if (frame[0] === "EOSE" && frame[1] === subId) {
				// first end-of-stored-events: if nothing landed, it's genuinely empty
				if (!eosed) {
					eosed = true;
					if (notes.length === 0 && state === "loading") setState("empty");
					else if (state === "loading") setState("ready");
					emit();
				}
				return;
			}
			if (frame[0] !== "EVENT" || frame[1] !== subId) return;
			const ev = frame[2];
			if (ev?.id && ev?.pubkey) ingest(ev);
		});
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

	// open the notes stream for a geohash channel. safe to call repeatedly; each
	// call retargets (closes the old sockets, resubscribes to the new cell).
	function open(gh) {
		gen++;
		closeAll();
		clearInterval(pruneTimer);
		geohash = String(gh).toLowerCase();
		cells = new Set([geohash, ...geohashNeighbors(geohash)].map((c) => c.toLowerCase()));
		notes = [];
		seen.clear();
		eosed = false;
		subId = `glub-notes-${Math.random().toString(36).slice(2, 10)}`;

		const relays = (getRelays(geohash) || []).slice(0, MAX_RELAYS);
		if (relays.length === 0) {
			setState("no_relays");
			emit();
			return;
		}
		setState("loading");
		emit();
		for (const url of relays) connect(url, 0);
		pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
	}

	function close() {
		gen++;
		closeAll();
		clearInterval(pruneTimer);
		pruneTimer = null;
		setState("idle");
	}

	// publish a note to the current channel. content pre-validated by the caller.
	// expiresInSecs falsy = never expires. returns { ok, event, relays } - ok is
	// false only when signing failed; a note with zero live relays still echoes
	// locally and ships as sockets come up is out of scope (native drops it too),
	// so we surface relays===0 to let the caller warn.
	function post({ content, name, expiresInSecs }) {
		if (!geohash) return { ok: false, relays: 0 };
		const { sk, pk } = getIdentity();
		const expiresAt = expiresInSecs ? nowSecs() + expiresInSecs : null;
		let event;
		try {
			event = makeNote({ content, geohash, name, expiresAt, sk, pk });
		} catch {
			return { ok: false, relays: 0 };
		}
		const relays = broadcast(event);
		// optimistic local echo so the note appears instantly
		if (
			insert({
				id: event.id,
				pubkey: pk,
				content,
				createdAt: event.created_at,
				name: name || "",
				geohash,
				expiresAt,
				mine: true,
			})
		) {
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
			broadcast(del);
		} catch {
			return false;
		}
		notes = notes.filter((n) => n.id !== noteId);
		if (notes.length === 0 && eosed) setState("empty");
		emit();
		return true;
	}

	function getState() {
		return { state, notes: notes.slice(), geohash };
	}

	return { open, close, post, remove, getState };
}
