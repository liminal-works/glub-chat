// inbound anti-spam: the dual token-bucket design native bitchat (iOS) runs on
// public messages, ported constants and all. two independent buckets must both
// allow a message:
//   sender  - per pubkey: burst of 5, refills 1/s. throttles one loud key.
//   content - per NORMALIZED text: burst of 3, refills 0.5/s. catches the real
//             nostr spam shape: identical copypasta sprayed across burner keys
//             (new keys are free, so per-sender limits alone are toothless).
// purely a view-side filter: nothing is sent, nothing is stored, a legit
// sender who trips it just has that burst collapsed on this client.

const SENDER_CAPACITY = 5;
const SENDER_REFILL_PER_SEC = 1.0;
const CONTENT_CAPACITY = 3;
const CONTENT_REFILL_PER_SEC = 0.5;

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
	const stats = { allowed: 0, senderDrops: 0, contentDrops: 0 };

	return {
		stats,
		// both buckets are always drained (matching iOS): a message that fails
		// one still spends from the other, so alternating spam can't ride free.
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

			if (senderOk && contentOk) {
				stats.allowed++;
				return true;
			}
			if (!senderOk) stats.senderDrops++;
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
