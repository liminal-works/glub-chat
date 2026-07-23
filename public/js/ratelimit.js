// inbound anti-spam: the dual token-bucket design native bitchat (iOS) runs on
// public messages, ported constants and all, PLUS a near-duplicate suppressor.
// three checks must all allow a message:
//   sender  - per pubkey: burst of 5, refills 1/s. throttles one loud key.
//   content - per NORMALIZED text: burst of 3, refills 0.5/s. catches fast
//             identical copypasta bursts.
//   repeat  - the same/similar message dripped slowly across many burner keys
//             AND channels (paced under the content bucket's refill) is the shape
//             the token buckets miss. this counts near-duplicates (>=85% word
//             overlap) over a longer rolling window and drops copies past a cap.
// purely a view-side filter: nothing is sent, nothing is stored, a legit
// sender who trips it just has that burst collapsed on this client.

const SENDER_CAPACITY = 5;
const SENDER_REFILL_PER_SEC = 1.0;
const CONTENT_CAPACITY = 3;
const CONTENT_REFILL_PER_SEC = 0.5;

// --- near-duplicate suppressor tunables ---
const DUP_WINDOW_MS = 90_000; // rolling window copies are counted over
const DUP_SIM = 0.85; // word-set (jaccard) similarity that counts as "the same message"
const DUP_MAX = 4; // allow this many near-copies in the window; drop the (MAX+1)th on
const DUP_MIN_TOKENS = 6; // ignore short messages (gm / reactions / one-liners collide too easily)
const DUP_RING = 80; // recent messages a newcomer is compared against

// word set of a message, for fuzzy compare: lowercase, fold width/accents, drop
// urls (a rotating slug shouldn't defeat the match) and punctuation, keep 2+ char
// tokens. two messages that share most of these words are "the same message".
function tokenSet(text) {
	const words = String(text || "")
		.toLowerCase()
		.normalize("NFKC")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter((w) => w.length >= 2);
	return new Set(words);
}

// jaccard overlap of two word sets: |A∩B| / |A∪B|, in [0,1].
function jaccard(a, b) {
	if (!a.size || !b.size) return 0;
	const [small, big] = a.size <= b.size ? [a, b] : [b, a];
	let inter = 0;
	for (const w of small) if (big.has(w)) inter++;
	return inter / (a.size + b.size - inter);
}

// safety bound: a flood of unique keys/contents can't grow the maps forever.
// clearing wholesale on overflow briefly re-admits everyone - acceptable for an
// advisory filter, and simpler than LRU bookkeeping.
const MAX_TRACKED = 2000;

// fold trivial mutations (case, spacing, punctuation, zero-width junk) so they
// share one content bucket. returns "" for content with no letters/digits -
// callers skip the content bucket for those rather than lumping all emoji-only
// messages together.
export function normalizeContent(text) {
	return String(text || "")
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function makeBucket(capacity, now) {
	return { tokens: capacity, last: now };
}

function drain(bucket, capacity, refillPerSec, now) {
	const elapsed = Math.max(0, now - bucket.last) / 1000;
	bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
	bucket.last = now;
	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return true;
	}
	return false;
}

export function createMessageRateLimiter() {
	const senders = new Map(); // senderKey -> bucket
	const contents = new Map(); // normalized content -> bucket
	const recent = []; // { tokens:Set, at } ring of recent messages, for near-dup detection
	const stats = { allowed: 0, senderDrops: 0, contentDrops: 0, repeatDrops: 0 };

	// count how many recent messages this one is >=DUP_SIM similar to (globally,
	// across senders + channels - that's the whole point), record it, and report
	// whether it's over the cap. long enough to judge only; short messages are
	// always allowed (and not recorded) so common one-liners never collide.
	function repeatOk(content, now) {
		const tokens = tokenSet(content);
		if (tokens.size < DUP_MIN_TOKENS) return true;
		const cutoff = now - DUP_WINDOW_MS;
		while (recent.length && recent[0].at < cutoff) recent.shift();
		let similar = 0;
		for (const e of recent) if (jaccard(tokens, e.tokens) >= DUP_SIM) similar++;
		recent.push({ tokens, at: now });
		if (recent.length > DUP_RING) recent.shift();
		return similar < DUP_MAX; // the (DUP_MAX+1)th near-copy in the window is dropped
	}

	return {
		stats,
		// all three checks are always evaluated (matching iOS's "drain both"): a
		// message that fails one still spends from the others, so alternating spam
		// can't ride free.
		allow(senderKey, content, now = Date.now()) {
			if (senders.size > MAX_TRACKED) senders.clear();
			if (contents.size > MAX_TRACKED) contents.clear();

			let sb = senders.get(senderKey);
			if (!sb) senders.set(senderKey, (sb = makeBucket(SENDER_CAPACITY, now)));
			const senderOk = drain(sb, SENDER_CAPACITY, SENDER_REFILL_PER_SEC, now);

			const key = normalizeContent(content);
			let contentOk = true;
			if (key) {
				let cb = contents.get(key);
				if (!cb) contents.set(key, (cb = makeBucket(CONTENT_CAPACITY, now)));
				contentOk = drain(cb, CONTENT_CAPACITY, CONTENT_REFILL_PER_SEC, now);
			}

			const notRepeat = repeatOk(content, now);

			if (senderOk && contentOk && notRepeat) {
				stats.allowed++;
				return true;
			}
			if (!notRepeat) stats.repeatDrops++;
			else if (!senderOk) stats.senderDrops++;
			else stats.contentDrops++;
			return false;
		},
	};
}

// presence heartbeats get their own, looser sender-only limiter: a legitimate
// client announces every ~20s, so 1-per-5s with a small burst never touches
// real traffic but bounds how hard one key can churn the roster.
export function createPresenceRateLimiter() {
	const senders = new Map();
	return {
		allow(senderKey, now = Date.now()) {
			if (senders.size > MAX_TRACKED) senders.clear();
			let sb = senders.get(senderKey);
			if (!sb) senders.set(senderKey, (sb = makeBucket(3, now)));
			return drain(sb, 3, 0.2, now);
		},
	};
}
