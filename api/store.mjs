import { DatabaseSync } from "node:sqlite";

// SQLite-backed event store for the (optional) history API. The chat buffer is
// bounded fairly (see prune(): a per-channel depth cap so busy channels can't
// starve quiet ones, plus a channel-count cap so unlimited geohashes stay
// bounded). We keep only signed kind-20000 chat events that carry a geohash,
// stored verbatim so we can hand them back unchanged for the client to
// re-verify. SQLite (rather than an in-memory array) just so it survives a
// restart.
const MAX_HISTORY = 5000; // hard ceiling on a single history response
const MAX_NOTES = 20_000; // rolling ceiling on cached location notes
const MAX_NOTES_RESPONSE = 500; // hard ceiling on a single /api/notes response

export function openStore(dbPath) {
	const db = new DatabaseSync(dbPath);

	db.exec(`
		CREATE TABLE IF NOT EXISTS events (
			id         TEXT PRIMARY KEY,
			pubkey     TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			geohash    TEXT NOT NULL,
			json       TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_geo_time ON events (geohash, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_time ON events (created_at DESC);

		-- location notes (kind 1): persistent, unlike the chat rolling buffer. keyed
		-- by geohash so we can answer prefix queries (all notes nested under a
		-- channel) with a range scan on the geohash index - the thing relays can't
		-- do. expires_at is the NIP-40 expiry (or NULL for never).
		CREATE TABLE IF NOT EXISTS notes (
			id         TEXT PRIMARY KEY,
			pubkey     TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			geohash    TEXT NOT NULL,
			expires_at INTEGER,
			json       TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_notes_geo ON notes (geohash);
		CREATE INDEX IF NOT EXISTS idx_notes_time ON notes (created_at DESC);
	`);

	const insertStmt = db.prepare(
		`INSERT OR IGNORE INTO events (id, pubkey, created_at, geohash, json) VALUES (?, ?, ?, ?, ?)`
	);
	const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM events`);
	const oldestStmt = db.prepare(`SELECT MIN(created_at) AS t FROM events`);
	const channelCountStmt = db.prepare(`SELECT COUNT(DISTINCT geohash) AS n FROM events`);
	// two-tier prune (see prune()). tier 1 keeps only the newest perChannelMax
	// events within each geohash, so a busy channel can't hoard depth at a quiet
	// one's expense. the (created_at DESC, id) ordering breaks timestamp ties
	// deterministically so the same rows survive each sweep.
	const prunePerChannelStmt = db.prepare(
		`DELETE FROM events WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY geohash ORDER BY created_at DESC, id DESC) AS rn
				FROM events
			) WHERE rn > ?
		)`
	);
	// tier 2 keeps only the maxChannels most-recently-active geohashes (ranked by
	// their newest event), dropping the rest wholesale - geohashes are effectively
	// unlimited, so we retain the freshest and let long-silent channels fall off.
	const pruneChannelsStmt = db.prepare(
		`DELETE FROM events WHERE geohash IN (
			SELECT geohash FROM (
				SELECT geohash, ROW_NUMBER() OVER (ORDER BY MAX(created_at) DESC, geohash DESC) AS rn
				FROM events GROUP BY geohash
			) WHERE rn > ?
		)`
	);

	const insertNoteStmt = db.prepare(
		`INSERT OR IGNORE INTO notes (id, pubkey, created_at, geohash, expires_at, json) VALUES (?, ?, ?, ?, ?, ?)`
	);
	// prefix query via a range scan on the geohash index: every note whose geohash
	// is >= the prefix and < prefix + a byte above all base32 chars ('z' = 0x7a)
	// starts with the prefix. unexpired only. newest first.
	const notesByPrefixStmt = db.prepare(
		`SELECT json FROM notes
		 WHERE geohash >= ? AND geohash < ?
		   AND (expires_at IS NULL OR expires_at > ?)
		 ORDER BY created_at DESC LIMIT ?`
	);
	// NIP-09: only the author may delete their own note.
	const deleteNoteStmt = db.prepare(`DELETE FROM notes WHERE id = ? AND pubkey = ?`);
	const pruneExpiredStmt = db.prepare(`DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at <= ?`);
	const pruneNotesCountStmt = db.prepare(
		`DELETE FROM notes WHERE id NOT IN (SELECT id FROM notes ORDER BY created_at DESC LIMIT ?)`
	);
	const notesCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM notes`);

	return {
		db,

		// returns true if a new row was inserted (false if we'd already seen the id)
		insert(ev, geohash) {
			const info = insertStmt.run(ev.id, ev.pubkey, ev.created_at, geohash, JSON.stringify(ev));
			return info.changes > 0;
		},

		// fair two-tier trim of the chat buffer. tier 1 caps each channel's depth
		// (newest perChannelMax per geohash) so no channel dominates; tier 2 caps
		// breadth (the maxChannels most-recently-active geohashes) so ~unlimited
		// geohashes can't grow the store without bound. total rows are bounded by
		// perChannelMax * maxChannels. returns how many rows were deleted.
		prune({ perChannelMax, maxChannels }) {
			const per = Math.max(1, perChannelMax | 0);
			const chan = Math.max(1, maxChannels | 0);
			const trimmed = prunePerChannelStmt.run(per).changes; // depth cap first (cheaper tier-2 scan)
			const dropped = pruneChannelsStmt.run(chan).changes; // then breadth cap
			return trimmed + dropped;
		},

		// newest-first page of stored events, optionally scoped to one geohash and
		// to events older than `before` (for paging deeper into history).
		history({ geo, before, limit }) {
			const lim = Math.min(Math.max(1, limit | 0 || 200), MAX_HISTORY);
			const clauses = [];
			const params = [];
			if (geo) {
				clauses.push("geohash = ?");
				params.push(geo);
			}
			if (before) {
				clauses.push("created_at < ?");
				params.push(before | 0);
			}
			const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
			const rows = db
				.prepare(`SELECT json FROM events ${where} ORDER BY created_at DESC LIMIT ?`)
				.all(...params, lim);
			return rows.map((r) => JSON.parse(r.json));
		},

		// --- location notes (kind 1) ---------------------------------------------

		// store a note; returns true if newly inserted. expiresAt is unix secs or null.
		insertNote(ev, geohash, expiresAt) {
			const info = insertNoteStmt.run(ev.id, ev.pubkey, ev.created_at, geohash, expiresAt ?? null, JSON.stringify(ev));
			return info.changes > 0;
		},

		// every cached note nested under `prefix` (the prefix cell itself included),
		// unexpired, newest first. This is the prefix match relays can't do.
		notesByPrefix(prefix, limit) {
			const p = String(prefix).toLowerCase();
			const lim = Math.min(Math.max(1, limit | 0 || 100), MAX_NOTES_RESPONSE);
			const now = Math.floor(Date.now() / 1000);
			const rows = notesByPrefixStmt.all(p, p + "\x7f", now, lim);
			return rows.map((r) => JSON.parse(r.json));
		},

		// NIP-09 delete: drop the note only if it belongs to `pubkey`. Returns count.
		deleteNote(id, pubkey) {
			return deleteNoteStmt.run(id, pubkey).changes;
		},

		// drop expired notes and trim the cache to its most-recent MAX_NOTES.
		pruneNotes() {
			const now = Math.floor(Date.now() / 1000);
			const expired = pruneExpiredStmt.run(now).changes;
			const trimmed = pruneNotesCountStmt.run(MAX_NOTES).changes;
			return expired + trimmed;
		},

		stats() {
			return {
				events: countStmt.get().n,
				channels: channelCountStmt.get().n,
				oldest: oldestStmt.get().t ?? null,
				notes: notesCountStmt.get().n,
			};
		},
	};
}
