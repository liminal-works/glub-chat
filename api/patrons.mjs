// Patronage: a lightning donation buys a NIP-05 identity under glub's domain.
//
// The `backend` is either lightning.mjs (LNbits) or cashu.mjs (a mint). Nothing in
// here knows which: both mint an invoice and answer whether it was paid. A mint also
// needs a third step - the ecash has to be ISSUED after payment - which it exposes as
// collect(), and which is deliberately kept OFF the path that grants the identity.
//
// This owns its OWN sqlite file, deliberately not the history db. That one is a
// rolling cache with a prune loop pointed at it, and is safe to delete to reclaim
// disk; this one is the only record that someone paid. Mixing the two would put
// paid identities one `rm glub-history.db` away from being gone.
//
// Authentication is a non-problem here and it's worth saying why: every command
// arrives as a nostr event whose signature the aggregator has already verified
// (aggregator.mjs), so `ev.pubkey` is proof of the key, not a claim about it. There
// are no tokens to issue, steal, or expire - a request to rename `pubkey` that
// isn't signed by `pubkey` cannot reach this module at all.

import { DatabaseSync } from "node:sqlite";

const NAME_MAX = 32; // long enough for a handle, short enough to read in a profile
// NIP-05 local parts are restricted to this set, so a glub display name ("carson 🐟")
// cannot be used verbatim - it gets folded down to what the spec permits.
const NAME_OK = /^[a-z0-9\-_.]+$/;
// "_" is NIP-05's root identifier: `_@glub.chat` renders as bare "glub.chat" in
// clients, so handing it to a patron would let them impersonate the domain itself.
// The rest are the names an operator or an official account would want later.
const RESERVED = new Set([
	"_", "admin", "administrator", "api", "bot", "glub", "glubchat", "glub-chat", "glubbot",
	"help", "info", "mod", "moderator", "no-reply", "noreply", "official", "operator",
	"owner", "root", "security", "staff", "support", "system", "webmaster",
]);

const now = () => Math.floor(Date.now() / 1000);

// Fold a display name down to something NIP-05 permits. Returns "" when nothing
// usable survives (a name that is entirely emoji, say), which callers treat as
// "pick one for them" rather than as an error.
export function sanitizeNip05Name(raw) {
	return String(raw || "")
		.toLowerCase()
		.replace(/[^a-z0-9\-_.]+/g, "") // drop, rather than substitute: "a b" -> "ab", not "a-b"
		.replace(/^[-_.]+|[-_.]+$/g, "") // no leading/trailing punctuation
		.slice(0, NAME_MAX);
}

export function createPatrons({
	dbPath,
	backend,
	amountSats,
	invoiceTtlSec,
	renameCooldownSec,
	domain = "",
	onSettled = null,
}) {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;

		CREATE TABLE IF NOT EXISTS patrons (
			pubkey     TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			renamed_at INTEGER,
			-- NULL = never expires, which is every row today. The column exists now so
			-- that making patronage renewable later is a policy change rather than a
			-- migration against the one table we can't afford to get wrong.
			expires_at INTEGER
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_patrons_name ON patrons (name);

		CREATE TABLE IF NOT EXISTS invoices (
			payment_hash TEXT PRIMARY KEY,
			pubkey       TEXT NOT NULL,
			name         TEXT NOT NULL,  -- display name captured when it was minted
			geohash      TEXT NOT NULL,  -- where to announce the thank-you when it settles
			bolt11       TEXT NOT NULL,
			amount_sats  INTEGER NOT NULL,
			created_at   INTEGER NOT NULL,
			expires_at   INTEGER NOT NULL,
			settled_at   INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_invoices_pubkey ON invoices (pubkey);
		CREATE INDEX IF NOT EXISTS idx_invoices_open ON invoices (settled_at, expires_at);
	`);

	// A cashu backend has to come back and ISSUE the ecash after payment, so a settled
	// invoice can still have money outstanding at the mint. This column tracks that
	// second half. Added by migration rather than folded into the CREATE above,
	// because CREATE TABLE IF NOT EXISTS silently does nothing to a table that already
	// exists - and this is the one table where "silently did nothing" is expensive.
	const invoiceCols = new Set(db.prepare(`PRAGMA table_info(invoices)`).all().map((c) => c.name));
	if (!invoiceCols.has("collected_at")) {
		db.exec(`ALTER TABLE invoices ADD COLUMN collected_at INTEGER`);
		// nothing predates this column that could have been collected, so backfilling
		// settled rows as collected would be a lie; they are left NULL and swept.
	}

	const q = {
		patron: db.prepare(`SELECT * FROM patrons WHERE pubkey = ?`),
		byName: db.prepare(`SELECT pubkey FROM patrons WHERE name = ?`),
		allNames: db.prepare(
			`SELECT name, pubkey FROM patrons WHERE expires_at IS NULL OR expires_at > ? ORDER BY name`,
		),
		oneName: db.prepare(
			`SELECT name, pubkey FROM patrons WHERE name = ? AND (expires_at IS NULL OR expires_at > ?)`,
		),
		insertPatron: db.prepare(`INSERT INTO patrons (pubkey, name, created_at) VALUES (?, ?, ?)`),
		renamePatron: db.prepare(`UPDATE patrons SET name = ?, renamed_at = ? WHERE pubkey = ?`),
		openInvoice: db.prepare(
			`SELECT * FROM invoices WHERE pubkey = ? AND settled_at IS NULL AND expires_at > ?
			 ORDER BY created_at DESC LIMIT 1`,
		),
		invoiceByHash: db.prepare(`SELECT * FROM invoices WHERE payment_hash = ?`),
		insertInvoice: db.prepare(
			`INSERT INTO invoices (payment_hash, pubkey, name, geohash, bolt11, amount_sats, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		),
		// The WHERE settled_at IS NULL is the whole concurrency story: two sweeps can
		// race to settle the same invoice, and only the one whose UPDATE reports a
		// changed row goes on to create the patron.
		settleInvoice: db.prepare(`UPDATE invoices SET settled_at = ? WHERE payment_hash = ? AND settled_at IS NULL`),
		pending: db.prepare(
			`SELECT * FROM invoices WHERE settled_at IS NULL AND expires_at > ? ORDER BY created_at ASC LIMIT ?`,
		),
		dropExpired: db.prepare(`DELETE FROM invoices WHERE settled_at IS NULL AND expires_at <= ?`),
		// settled, but the ecash was never issued - money sitting at the mint
		uncollected: db.prepare(
			`SELECT * FROM invoices WHERE settled_at IS NOT NULL AND collected_at IS NULL ORDER BY settled_at ASC LIMIT ?`,
		),
		markCollected: db.prepare(`UPDATE invoices SET collected_at = ? WHERE payment_hash = ?`),
		countUncollected: db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE settled_at IS NOT NULL AND collected_at IS NULL`),
		countPatrons: db.prepare(`SELECT COUNT(*) AS n FROM patrons`),
		countOpen: db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE settled_at IS NULL AND expires_at > ?`),
		countSettled: db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE settled_at IS NOT NULL`),
	};

	const nameFree = (name, forPubkey) => {
		if (RESERVED.has(name)) return false;
		const row = q.byName.get(name);
		return !row || row.pubkey === forPubkey;
	};

	// Pick the best available name for someone who just paid. They never chose one -
	// that's the point of auto-claiming - so this must always succeed, and the ladder
	// ends somewhere that cannot collide.
	function resolveName(desired, pubkey) {
		const base = sanitizeNip05Name(desired);
		if (base && nameFree(base, pubkey)) return base;
		if (base) {
			// the same #suffix glub already prints beside a name in chat, so the fallback
			// still reads as the person you were just talking to
			const suffixed = `${base.slice(0, NAME_MAX - 5)}-${pubkey.slice(-4)}`;
			if (nameFree(suffixed, pubkey)) return suffixed;
		}
		return `glub-${pubkey.slice(0, 8)}`; // a pubkey prefix collides only with itself
	}

	function patronOf(pubkey) {
		const row = q.patron.get(pubkey);
		if (!row) return null;
		if (row.expires_at && row.expires_at <= now()) return null;
		return row;
	}

	// --- donating ------------------------------------------------------------
	// One open invoice per pubkey, reused until it expires. That is the anti-abuse
	// rule and it needs no counter: a pubkey cannot hold two invoices at once, so
	// spamming !donate re-reads a row instead of minting anything.
	async function requestInvoice({ pubkey, name, geo }) {
		const existing = patronOf(pubkey);
		if (existing) return { status: "already", patron: existing };

		const open = q.openInvoice.get(pubkey, now());
		if (open) return { status: "reused", invoice: open };

		if (!backend.configured) return { status: "unconfigured" };

		const memo = `glub.chat patron${domain ? ` (${domain} nip-05)` : ""}`;
		const { bolt11, paymentHash, expiresAt } = await backend.createInvoice({
			amountSats,
			memo,
			expirySec: invoiceTtlSec,
		});
		const created = now();
		// A backend that CHOOSES the expiry (a cashu mint does; LNbits takes ours) is
		// believed over our own ttl. Guessing shorter than the mint deletes the row for
		// an invoice someone can still pay - their money arrives against a record we
		// threw away. Guessing longer just leaves a dead row around, so when the two
		// disagree, take whichever is sooner.
		const ourExpiry = created + invoiceTtlSec;
		const expires = Number.isFinite(expiresAt) && expiresAt > created ? Math.min(expiresAt, ourExpiry) : ourExpiry;
		q.insertInvoice.run(paymentHash, pubkey, String(name || ""), String(geo || ""), bolt11, amountSats, created, expires);
		return { status: "created", invoice: q.invoiceByHash.get(paymentHash) };
	}

	// Settle one invoice and mint the patron. Idempotent: the UPDATE claims the row,
	// and a second caller that finds nothing changed reports the existing patron
	// rather than trying to insert a duplicate.
	function settleInvoice(invoice) {
		const claimed = q.settleInvoice.run(now(), invoice.payment_hash).changes > 0;
		if (!claimed) return { status: "already", patron: patronOf(invoice.pubkey) };

		const existing = patronOf(invoice.pubkey);
		if (existing) return { status: "already", patron: existing }; // paid twice; keep the first identity

		const name = resolveName(invoice.name, invoice.pubkey);
		q.insertPatron.run(invoice.pubkey, name, now());
		const patron = q.patron.get(invoice.pubkey);
		try {
			onSettled?.(patron, invoice);
		} catch (e) {
			console.error("[patrons] onSettled failed:", e.message);
		}
		return { status: "settled", patron };
	}

	// Check this pubkey's open invoice right now - what !redeem calls. The background
	// sweep does the same thing unprompted; this exists so nobody has to wait for it,
	// and so a sweep that is failing is visible to the person who paid.
	async function redeem(pubkey) {
		const existing = patronOf(pubkey);
		if (existing) return { status: "already", patron: existing };

		const open = q.openInvoice.get(pubkey, now());
		if (!open) return { status: "none" };
		if (!backend.configured) return { status: "unconfigured" };

		const paid = await backend.isPaid(open.payment_hash);
		if (!paid) return { status: "pending", invoice: open };
		return settleInvoice(open);
	}

	// --- the background sweep -------------------------------------------------
	// Bounded per run: a backlog of open invoices must not turn into an unbounded
	// burst of requests at the lightning node every tick.
	async function sweep(limit = 25) {
		q.dropExpired.run(now()); // nobody is going to pay an expired invoice
		if (!backend.configured) return { checked: 0, settled: 0 };

		const open = q.pending.all(now(), limit);
		let settled = 0;
		for (const invoice of open) {
			try {
				if (!(await backend.isPaid(invoice.payment_hash))) continue;
				if (settleInvoice(invoice).status === "settled") settled++;
			} catch (e) {
				// one unreachable node must not abandon the rest of the sweep
				console.error(`[patrons] check ${invoice.payment_hash.slice(0, 12)} failed:`, e.message);
			}
		}
		const collected = await collectSettled(limit);
		return { checked: open.length, settled, ...collected };
	}

	// Claim the ecash for invoices that are already paid. Deliberately NOT part of
	// settleInvoice: the identity is owed the moment the payment confirms, and hanging
	// it on our ability to issue proofs would mean a mint having a bad minute leaves
	// someone who paid with nothing. So the patron row is written first and the money
	// is fetched afterwards, retried here until it lands.
	//
	// A backend with no collect step (LNbits) marks the row collected on sight - there
	// is nothing outstanding, and leaving it NULL would grow a queue that never drains.
	async function collectSettled(limit = 25) {
		const rows = q.uncollected.all(limit);
		if (!rows.length) return { collected: 0 };
		if (typeof backend.collect !== "function") {
			for (const r of rows) q.markCollected.run(now(), r.payment_hash);
			return { collected: 0 };
		}
		let collected = 0;
		for (const r of rows) {
			try {
				const out = await backend.collect(r.payment_hash, r.amount_sats);
				// "pending" means paid but the mint isn't ready to issue - leave the row
				// alone and try again next tick. "lost" is unrecoverable and retrying it
				// forever would block the queue behind it, so it gets closed out.
				if (out?.status === "collected") {
					q.markCollected.run(now(), r.payment_hash);
					collected++;
				} else if (out?.status === "lost" || out?.status === "unconfigured") {
					q.markCollected.run(now(), r.payment_hash);
				}
			} catch (e) {
				console.error(`[patrons] collect ${r.payment_hash.slice(0, 12)} failed:`, e.message);
			}
		}
		return { collected };
	}

	// --- renaming --------------------------------------------------------------
	function rename(pubkey, requested) {
		const patron = patronOf(pubkey);
		if (!patron) return { status: "not-patron" };

		const name = sanitizeNip05Name(requested);
		if (!name || !NAME_OK.test(name)) return { status: "invalid" };
		if (name === patron.name) return { status: "unchanged", patron };
		if (!nameFree(name, pubkey)) return { status: "taken" };

		// Rate limited per pubkey rather than per IP: the pubkey is the thing we can
		// actually prove, and it is the thing a name belongs to. The first rename is
		// always free - an auto-claimed name may well have been mangled on the way
		// through sanitizeNip05Name, and charging someone a cooldown to fix that
		// would be punishing them for our own transliteration.
		if (patron.renamed_at && now() - patron.renamed_at < renameCooldownSec) {
			return { status: "cooldown", retryAfter: patron.renamed_at + renameCooldownSec - now(), patron };
		}

		q.renamePatron.run(name, now(), pubkey);
		return { status: "ok", patron: q.patron.get(pubkey), previous: patron.name };
	}

	// --- what /.well-known/nostr.json serves ------------------------------------
	function names(only = "") {
		const wanted = sanitizeNip05Name(only);
		const rows = wanted ? q.oneName.all(wanted, now()) : q.allNames.all(now());
		const out = Object.create(null);
		for (const r of rows) out[r.name] = r.pubkey;
		return out;
	}

	return {
		requestInvoice,
		redeem,
		sweep,
		collectSettled,
		rename,
		names,
		patronOf,
		amountSats,
		get configured() {
			return backend.configured;
		},
		stats() {
			return {
				patrons: q.countPatrons.get().n,
				openInvoices: q.countOpen.get(now()).n,
				settled: q.countSettled.get().n,
				uncollected: q.countUncollected.get().n,
				configured: backend.configured,
				backend: backend.kind || "lightning",
				...(backend.stats ? { vault: backend.stats() } : {}),
			};
		},
		close: () => db.close(),
	};
}
