// A short-lived audit trail for everything uploaded through /api/media.
//
// This exists for one reason: if something illegal is hosted here, the operator has
// to be able to take it down, identify what it was, and hand a factual account to
// the authorities. That is not a thing you can reconstruct after the fact from a
// 24h media directory that has already emptied itself, so the record is written at
// upload time, whether or not anything ever comes of it.
//
// Deliberately NOT a permanent archive. Retention is short (two weeks by default)
// and enforced by a sweep, because the log holds IP addresses and user agents -
// keeping those beyond the window in which they are useful is its own harm. The
// stored media itself still expires in 24h (media.mjs); nothing here extends it.
// So a report drawn from this log is: hashes, timing, the requesting client, and
// the signed event that published it - not the file, which is already gone.
//
// It owns its own sqlite file, like patrons.mjs and for the same reason: the
// history db is a rolling cache with a prune loop pointed at it and is safe to
// delete, and this is not.
//
// What it CANNOT see, stated plainly because a log you misread is worse than none:
//   - DM images. NIP-17 gift-wraps the content, so no event this api ever sees
//     names the url. The upload row stands alone, with no pubkey attached to it.
//   - Note/geotag images. Those upload to nostr.build, not here, so there is no
//     upload row at all - only the event, if it happens to be one we cache.
//   - Anyone who takes a url and re-posts it somewhere we don't read.
// The upload row is the reliable half; the event join is enrichment.

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const DAY = 86_400;
const SWEEP_MS = 60 * 60_000; // hourly: the window is measured in days
// media.mjs hands out `${16 hex}.${ext}`, and the url the client shares is
// `<origin>/api/media/<that>`. This is how an event gets tied back to an upload.
const MEDIA_URL_RE = /\/api\/media\/([0-9a-f]{16}\.[a-z0-9]{1,5})\b/g;
const MAX_URLS_PER_EVENT = 8; // a chat line carrying more than this is not a real post

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// A coarse bucket for scanning ("everything from ios/safari in this hour"), kept
// alongside the raw string rather than instead of it - the bucket is for reading,
// the user agent is the evidence. Order matters: Edge and Opera both claim to be
// Chrome, and Chrome claims to be Safari.
export function deviceOf(ua) {
	const s = String(ua || "");
	if (!s) return "";
	let os = "other";
	if (/iPhone|iPad|iPod/i.test(s)) os = "ios";
	else if (/Android/i.test(s)) os = "android";
	else if (/Mac OS X|Macintosh/i.test(s)) os = "macos";
	else if (/Windows/i.test(s)) os = "windows";
	else if (/Linux|X11/i.test(s)) os = "linux";
	let browser = "other";
	if (/Edge?A?\//i.test(s)) browser = "edge";
	else if (/OPR\/|Opera/i.test(s)) browser = "opera";
	else if (/Firefox\//i.test(s)) browser = "firefox";
	else if (/Chrome\//i.test(s)) browser = "chrome";
	else if (/Safari\//i.test(s)) browser = "safari";
	return `${os}/${browser}`;
}

// Everything the request itself tells us about who sent it. Nothing here is
// trustworthy - headers are attacker-controlled - but that is exactly why it is
// recorded verbatim rather than interpreted.
export function requestFacts(req) {
	const h = (req && req.headers) || {};
	const one = (v) => (Array.isArray(v) ? v[0] : v) || "";
	return {
		ip: String((req && req.ip) || "").slice(0, 64),
		ua: String(one(h["user-agent"])).slice(0, 512),
		lang: String(one(h["accept-language"])).slice(0, 128),
		origin: String(one(h.origin) || one(h.referer)).slice(0, 256),
		// present when the api sits behind a proxy chain we don't control; kept raw
		// because the hop order is the part that matters when reading it back
		forwarded: String(one(h["x-forwarded-for"])).slice(0, 256),
	};
}

export function createMediaLog({ dbPath, retentionDays = 14 } = {}) {
	const db = new DatabaseSync(dbPath);
	const ttl = Math.max(1, Number(retentionDays) || 14) * DAY;
	const now = () => Math.floor(Date.now() / 1000);

	db.exec(`
		PRAGMA journal_mode = WAL;

		-- One row per POST, accepted or not. Rejections are kept too: a stream of
		-- them is somebody probing the sanitizers, which is worth being able to see.
		CREATE TABLE IF NOT EXISTS uploads (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			at         INTEGER NOT NULL,
			file       TEXT,             -- NULL when rejected; the join key otherwise
			ok         INTEGER NOT NULL, -- 1 stored, 0 refused
			reason     TEXT,             -- why, when refused
			mime       TEXT NOT NULL,
			bytes_in   INTEGER NOT NULL,
			bytes_out  INTEGER,
			-- Two hashes, because the file we serve is NOT the file that was sent:
			-- media.mjs rebuilds it. sha256_out is what a hash-matching service would
			-- be given and what identifies a re-upload; sha256_in is what the uploader
			-- actually put on the wire, which is the one that ties to their own copy.
			sha256_in  TEXT NOT NULL,
			sha256_out TEXT,
			ip         TEXT,
			ua         TEXT,
			device     TEXT,
			lang       TEXT,
			origin     TEXT,
			forwarded  TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_uploads_at ON uploads (at DESC);
		CREATE INDEX IF NOT EXISTS idx_uploads_file ON uploads (file);
		CREATE INDEX IF NOT EXISTS idx_uploads_hash ON uploads (sha256_out);
		CREATE INDEX IF NOT EXISTS idx_uploads_ip ON uploads (ip);

		-- One row per (signed event, url it carried). A single upload can appear in
		-- several events - reposts, an edit, the same link pasted twice - and each is
		-- a separate act of publishing, so each gets its own row.
		CREATE TABLE IF NOT EXISTS publications (
			event_id TEXT NOT NULL,
			file     TEXT NOT NULL,
			at       INTEGER NOT NULL,  -- when WE saw it, not the event's own claim
			pubkey   TEXT NOT NULL,
			kind     INTEGER NOT NULL,
			geohash  TEXT,
			-- the signed event exactly as it arrived. Verbatim on purpose: a
			-- re-serialized copy is no longer the thing whose signature verifies,
			-- and "here is the event, check it yourself" is the whole value of it.
			json     TEXT NOT NULL,
			PRIMARY KEY (event_id, file)
		);
		CREATE INDEX IF NOT EXISTS idx_pub_file ON publications (file);
		CREATE INDEX IF NOT EXISTS idx_pub_at ON publications (at DESC);
		CREATE INDEX IF NOT EXISTS idx_pub_pubkey ON publications (pubkey);
	`);

	const q = {
		insertUpload: db.prepare(`
			INSERT INTO uploads (at, file, ok, reason, mime, bytes_in, bytes_out, sha256_in, sha256_out,
			                     ip, ua, device, lang, origin, forwarded)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		`),
		insertPub: db.prepare(`
			INSERT OR IGNORE INTO publications (event_id, file, at, pubkey, kind, geohash, json)
			VALUES (?,?,?,?,?,?,?)
		`),
		uploadByFile: db.prepare(`SELECT * FROM uploads WHERE file = ?`),
		uploadsByHash: db.prepare(`SELECT * FROM uploads WHERE sha256_out = ? OR sha256_in = ? ORDER BY at DESC`),
		uploadsByIp: db.prepare(`SELECT * FROM uploads WHERE ip = ? ORDER BY at DESC LIMIT ?`),
		recentUploads: db.prepare(`SELECT * FROM uploads ORDER BY at DESC LIMIT ?`),
		pubsForFile: db.prepare(`SELECT * FROM publications WHERE file = ? ORDER BY at ASC`),
		pubsByPubkey: db.prepare(`SELECT * FROM publications WHERE pubkey = ? ORDER BY at DESC LIMIT ?`),
		pubByEvent: db.prepare(`SELECT * FROM publications WHERE event_id = ?`),
		pruneUploads: db.prepare(`DELETE FROM uploads WHERE at < ?`),
		prunePubs: db.prepare(`DELETE FROM publications WHERE at < ?`),
		countUploads: db.prepare(`SELECT COUNT(*) AS n FROM uploads`),
		countStored: db.prepare(`SELECT COUNT(*) AS n FROM uploads WHERE ok = 1`),
		countPubs: db.prepare(`SELECT COUNT(*) AS n FROM publications`),
		oldest: db.prepare(`SELECT MIN(at) AS at FROM uploads`),
	};

	// Both tables age out on their own timestamp rather than the publication
	// following its upload: an event can turn up days after the upload it names, and
	// dropping it early would lose the only thing that ties a file to a person.
	function prune() {
		const cutoff = now() - ttl;
		const a = q.pruneUploads.run(cutoff);
		const b = q.prunePubs.run(cutoff);
		return { uploads: Number(a.changes || 0), publications: Number(b.changes || 0) };
	}

	// Nothing in here may break an upload. A failed audit write is worth a loud log
	// line, but refusing the request instead would turn a disk hiccup into an outage,
	// and a thrown error inside the ingest path would drop events wholesale.
	function guard(label, fn) {
		try {
			return fn();
		} catch (e) {
			console.error(`[medialog] ${label} failed: ${e.message}`);
			return null;
		}
	}

	// Record an upload that was stored. `file` is what media.mjs returned, which is
	// also the last path segment of the url the client is about to share.
	function recordUpload({ file, mime, bytesIn, bytesOut, sha256In, sha256Out, req }) {
		return guard("recordUpload", () => {
			const f = requestFacts(req);
			q.insertUpload.run(now(), String(file), 1, null, String(mime || ""), Number(bytesIn) || 0,
				Number(bytesOut) || 0, String(sha256In || ""), String(sha256Out || ""),
				f.ip, f.ua, deviceOf(f.ua), f.lang, f.origin, f.forwarded);
			return true;
		});
	}

	// Record a POST we refused. No file and no output hash, because there is no
	// output - but the bytes that were offered still hashed to something.
	function recordRejection({ mime, bytesIn, sha256In, reason, req }) {
		return guard("recordRejection", () => {
			const f = requestFacts(req);
			q.insertUpload.run(now(), null, 0, String(reason || ""), String(mime || ""), Number(bytesIn) || 0,
				null, String(sha256In || ""), null,
				f.ip, f.ua, deviceOf(f.ua), f.lang, f.origin, f.forwarded);
			return true;
		});
	}

	// Tie a signed event to any upload whose url it carries. Called for every event
	// the api accepts; the overwhelming majority mention no media and cost one
	// `includes` miss.
	//
	// Matched on the FILE, not the host: a url only makes a row if its last segment
	// is an upload this api actually issued. So a link to some other server's
	// /api/media/ path is ignored (we know nothing about it), while a url that names
	// one of ours is recorded wherever it points - somebody rehosting our file under
	// a different domain is precisely the case worth being able to see.
	function noteEvent(ev, geo) {
		if (!ev || typeof ev.content !== "string" || typeof ev.id !== "string") return 0;
		if (!ev.content.includes("/api/media/")) return 0; // cheap gate before the regex
		return (
			guard("noteEvent", () => {
				const files = new Set();
				MEDIA_URL_RE.lastIndex = 0;
				for (const m of ev.content.matchAll(MEDIA_URL_RE)) {
					files.add(m[1]);
					if (files.size >= MAX_URLS_PER_EVENT) break;
				}
				let n = 0;
				const json = JSON.stringify(ev);
				for (const file of files) {
					if (!q.uploadByFile.get(file)) continue; // not one of ours
					const r = q.insertPub.run(ev.id, file, now(), String(ev.pubkey || ""),
						Number(ev.kind) || 0, String(geo || ""), json);
					n += Number(r.changes || 0);
				}
				return n;
			}) || 0
		);
	}

	// --- reading it back --------------------------------------------------------
	// One upload with every event that published it. This is the shape a takedown or
	// a report is actually written from, so it is the shape the query returns.
	function forFile(file) {
		const upload = q.uploadByFile.get(String(file || ""));
		if (!upload) return null;
		return { upload, publications: q.pubsForFile.all(upload.file) };
	}

	function byHash(hash) {
		const h = String(hash || "").toLowerCase();
		return q.uploadsByHash.all(h, h).map((u) => ({ upload: u, publications: u.file ? q.pubsForFile.all(u.file) : [] }));
	}

	function byIp(ip, limit = 100) {
		return q.uploadsByIp.all(String(ip || ""), Math.min(1000, Math.max(1, limit)));
	}

	function byPubkey(pubkey, limit = 100) {
		return q.pubsByPubkey.all(String(pubkey || "").toLowerCase(), Math.min(1000, Math.max(1, limit)));
	}

	function byEvent(eventId) {
		return q.pubByEvent.all(String(eventId || "").toLowerCase());
	}

	function recent(limit = 50) {
		return q.recentUploads.all(Math.min(1000, Math.max(1, limit)));
	}

	function stats() {
		const oldest = q.oldest.get()?.at || null;
		return {
			uploads: Number(q.countUploads.get()?.n || 0),
			stored: Number(q.countStored.get()?.n || 0),
			publications: Number(q.countPubs.get()?.n || 0),
			retentionDays: ttl / DAY,
			oldestAt: oldest,
		};
	}

	prune(); // a process that was down past the window must not serve stale records
	const timer = setInterval(prune, SWEEP_MS);
	timer.unref?.();

	return {
		recordUpload,
		recordRejection,
		noteEvent,
		forFile,
		byHash,
		byIp,
		byPubkey,
		byEvent,
		recent,
		prune,
		stats,
		close: () => {
			clearInterval(timer);
			try {
				db.close();
			} catch {}
		},
	};
}
