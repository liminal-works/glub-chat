// NIP-13 proof-of-work miner. Runs as a classic (non-module) Worker so the
// grind loop never touches the UI thread. Given an unsigned event and a target
// difficulty, it appends a ["nonce", n, target] tag and counts up n until the
// event id (sha256 of the NIP-01 serialization) has >= target leading zero
// bits, then posts the winning tag back.
//
// sha256 is implemented synchronously here because crypto.subtle.digest is
// async - fine for one hash, hopeless inside a hot mining loop.

"use strict";

// --- compact synchronous sha256 (FIPS 180-4), returns Uint8Array(32) ---------
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);

function sha256(bytes) {
	const len = bytes.length;
	// pad: 0x80, zeros, 64-bit big-endian bit length
	const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
	padded.set(bytes);
	padded[len] = 0x80;
	const dv = new DataView(padded.buffer);
	dv.setUint32(padded.length - 4, len << 3, false);
	dv.setUint32(padded.length - 8, (len / 0x20000000) | 0, false);

	let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
	let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const w15 = W[i - 15], w2 = W[i - 2];
			const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
			const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
			W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
		}
		let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) | 0;
			h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
		}
		h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
	}
	const out = new Uint8Array(32);
	const odv = new DataView(out.buffer);
	[h0, h1, h2, h3, h4, h5, h6, h7].forEach((h, i) => odv.setUint32(i * 4, h >>> 0, false));
	return out;
}

// leading zero BITS of a 32-byte hash (NIP-13 difficulty)
function leadingZeroBits(hash) {
	let bits = 0;
	for (let i = 0; i < hash.length; i++) {
		const b = hash[i];
		if (b === 0) { bits += 8; continue; }
		bits += Math.clz32(b) - 24; // clz32 counts from bit 31; a byte occupies bits 7..0
		break;
	}
	return bits;
}

const utf8 = new TextEncoder();

// { jobId, event: {pubkey, created_at, kind, tags, content}, difficulty }
self.onmessage = (e) => {
	const { jobId, event, difficulty } = e.data;
	const started = Date.now();

	// pre-split the NIP-01 serialization around the nonce value so each attempt
	// is one string concat + one utf8 encode + one hash - no re-JSON per try.
	// serialization: [0, pubkey, created_at, kind, tags, content], built from
	// parts (never searched for) so message content can't confuse the split.
	// the nonce tag is appended as the last tag.
	const meta = JSON.stringify([0, event.pubkey, event.created_at, event.kind]).slice(0, -1); // "[0,"pk",ts,kind"
	const tagsJson = JSON.stringify(event.tags); // "[[...],[...]]" or "[]"
	const head =
		meta + "," + tagsJson.slice(0, -1) + (event.tags.length ? "," : "") + '["nonce","';
	const tail = '","' + difficulty + '"]],' + JSON.stringify(event.content) + "]";

	let nonce = 0;
	for (;;) {
		const hash = sha256(utf8.encode(head + nonce + tail));
		if (leadingZeroBits(hash) >= difficulty) {
			self.postMessage({
				jobId,
				nonceTag: ["nonce", String(nonce), String(difficulty)],
				iterations: nonce + 1,
				ms: Date.now() - started,
			});
			return;
		}
		nonce++;
	}
};
