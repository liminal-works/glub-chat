import { DatabaseSync } from "node:sqlite";

// SQLite-backed event store for the (optional) history API. We keep only what
// the client needs to render backlog: signed kind-20000 chat events that carry
// a geohash. The full event JSON is stored verbatim so we can hand it back
// unchanged for the client to re-verify.
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
	`);

	const insertStmt = db.prepare(
		`INSERT OR IGNORE INTO events (id, pubkey, created_at, geohash, json) VALUES (?, ?, ?, ?, ?)`
	);
	const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM events`);
	const oldestStmt = db.prepare(`SELECT MIN(created_at) AS t FROM events`);

	return {
		db,

		// returns true if a new row was inserted (false if we'd already seen the id)
		insert(ev, geohash) {
			const info = insertStmt.run(ev.id, ev.pubkey, ev.created_at, geohash, JSON.stringify(ev));
			return info.changes > 0;
		},

		// newest-first page of stored events, optionally scoped to one geohash and
		// to events older than `before` (for paging deeper into history).
		history({ geo, before, limit }) {
			const lim = Math.min(Math.max(1, limit | 0 || 200), 500);
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

		stats() {
			return { events: countStmt.get().n, oldest: oldestStmt.get().t ?? null };
		},
	};
}
