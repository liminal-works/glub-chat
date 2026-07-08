// NIP-13 proof-of-work: mining manager (worker-side loop lives in
// pow-worker.js) plus the difficulty helpers an inbound filter would need.
//
// mining happens on the UNSIGNED event - the nonce tag changes the event id,
// so it must be settled before signing. usage:
//   const nonceTag = await mineNonceTag(unsigned, 12);
//   if (nonceTag) unsigned.tags.push(nonceTag);
//   sign(unsigned);
//
// everything here fails open: no Worker support, a worker crash, or a timeout
// all resolve to null and the caller sends the event unmined - spam defense
// must never be the reason a message can't go out.

// how many leading zero bits we grind into outbound events. 12 is native
// android's default ("Low, ~0.1s") - cheap enough to be imperceptible, real
// enough that android users filtering at their default see us.
export const POW_DIFFICULTY = 12;

// a mining round should never block a send for long; at difficulty 12 this is
// ~1000x headroom. anything slower means something is wrong - send unmined.
const MINE_TIMEOUT_MS = 5000;

let worker = null;
let nextJobId = 1;
const jobs = new Map(); // jobId -> resolve

function ensureWorker() {
	if (worker) return worker;
	try {
		worker = new Worker("/js/nostr/pow-worker.js");
	} catch {
		return null; // no worker support - callers fall back to unmined sends
	}
	worker.onmessage = (e) => {
		const { jobId, nonceTag } = e.data;
		const resolve = jobs.get(jobId);
		if (resolve) {
			jobs.delete(jobId);
			resolve(nonceTag);
		}
	};
	worker.onerror = () => {
		// fail every in-flight job open, then drop the worker so the next mine
		// attempt gets a fresh one.
		for (const resolve of jobs.values()) resolve(null);
		jobs.clear();
		try {
			worker.terminate();
		} catch {}
		worker = null;
	};
	return worker;
}

// mine a ["nonce", n, difficulty] tag for an unsigned event (pubkey,
// created_at, kind, tags, content). resolves to the tag, or null on any
// failure/timeout (caller should send unmined).
export function mineNonceTag(event, difficulty = POW_DIFFICULTY) {
	if (!difficulty || difficulty <= 0) return Promise.resolve(null);
	const w = ensureWorker();
	if (!w) return Promise.resolve(null);
	const jobId = nextJobId++;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (jobs.delete(jobId)) resolve(null);
		}, MINE_TIMEOUT_MS);
		jobs.set(jobId, (tag) => {
			clearTimeout(timer);
			resolve(tag);
		});
		w.postMessage({ jobId, event: { pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content }, difficulty });
	});
}

// leading zero bits of a hex event id (NIP-13 difficulty of a received event)
export function idDifficulty(idHex) {
	let bits = 0;
	for (const c of String(idHex || "")) {
		const nibble = parseInt(c, 16);
		if (Number.isNaN(nibble)) break;
		if (nibble === 0) {
			bits += 4;
			continue;
		}
		bits += nibble < 2 ? 3 : nibble < 4 ? 2 : nibble < 8 ? 1 : 0;
		break;
	}
	return bits;
}

// the difficulty an event's nonce tag COMMITS to (3rd element), or 0. android
// treats "committed < required" as spam even when the actual id clears the bar.
export function committedDifficulty(event) {
	const tag = (Array.isArray(event.tags) ? event.tags : []).find((t) => Array.isArray(t) && t[0] === "nonce");
	if (!tag) return 0;
	const n = parseInt(tag[2], 10);
	return Number.isFinite(n) ? n : 0;
}
