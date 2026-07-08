// bitchat-compatible direct messages over nostr.
//
// Interop target is the native bitchat client's "geohash DM" path (bitchat/
// Nostr/NostrProtocol.swift + NostrEmbeddedBitChat.swift). That stack is NIP-17
// shaped (rumor kind 14 -> seal kind 13 -> gift wrap kind 1059) but the
// encryption layer is NOT spec NIP-44: bitchat derives the key as
// HKDF-SHA256(ikm = 33-byte compressed ECDH point, salt = "", info = "nip44-v2")
// and encrypts with XChaCha20-Poly1305, enveloped as "v2:" + base64url(nonce24
// || ciphertext || tag). Standard nostr nip44 libraries will not interop, which
// is why this file implements the construction directly from @noble primitives
// (the same ones nostr-tools already pulls in).
//
// The rumor's content is not the message text either - it's a full binary
// BitchatPacket ("bitchat1:" + base64url), type 0x11 (noiseEncrypted), whose
// payload is [NoisePayloadType byte][TLV(messageID, content)]. All of that is
// reproduced here byte-for-byte from BitFoundation/BinaryProtocol.swift.
//
// Everything runs in the browser on purpose: the seal is signed with - and the
// ECDH runs against - your real secret key, so this code path can never be
// delegated to a server without handing over the nsec.

import { finalizeEvent, verifyEvent, generateSecretKey } from "https://esm.sh/nostr-tools@2";
import { secp256k1 } from "https://esm.sh/@noble/curves@2.0.1/secp256k1";
import { hkdf } from "https://esm.sh/@noble/hashes@2.0.1/hkdf";
import { sha256 } from "https://esm.sh/@noble/hashes@2.0.1/sha2";
import { xchacha20poly1305 } from "https://esm.sh/@noble/ciphers@2.1.1/chacha";

// The native client publishes + subscribes gift wraps on its default relay set
// (relays known to accept kind 1059) - not the per-geohash relays. Mirror it.
// Overridable via a `glub_dm_relays` localStorage JSON array, so someone running
// their own gift-wrap relay (or a private group) can point DMs at it.
const DEFAULT_DM_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://offchain.pub"];

function resolveDmRelays() {
	try {
		const override = JSON.parse(localStorage.getItem("glub_dm_relays") || "null");
		if (Array.isArray(override) && override.length && override.every((u) => typeof u === "string" && /^wss?:\/\//.test(u))) {
			return override;
		}
	} catch {
		/* malformed override - fall back to the defaults */
	}
	return DEFAULT_DM_RELAYS;
}

export const DM_RELAYS = resolveDmRelays();

// TLV fields are single-byte-length, so content tops out at 255 utf-8 bytes.
export const DM_MAX_CONTENT_BYTES = 255;

const GIFT_WRAP_KIND = 1059;
const SEAL_KIND = 13;
const RUMOR_KIND = 14;
const MSG_TYPE_NOISE_ENCRYPTED = 0x11;
const PAYLOAD_PRIVATE_MESSAGE = 0x01;
const PAYLOAD_READ_RECEIPT = 0x02;
const PAYLOAD_DELIVERED = 0x03;
const TLV_MESSAGE_ID = 0x00;
const TLV_CONTENT = 0x01;
const FLAG_HAS_RECIPIENT = 0x01;
const FLAG_HAS_SIGNATURE = 0x02;
const FLAG_IS_COMPRESSED = 0x04;
const PACKET_TTL = 7;
const SUB_LOOKBACK_SECS = 86_400; // native subscribes a day back
const RECONNECT_BASE_MS = 2000;
const MAX_BACKOFF_MS = 60_000;
const MAX_SEEN = 4000;

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

function hexToBytes(hex) {
	return Uint8Array.from(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
}

function b64urlEncode(bytes) {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(s) {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// --- bitchat's DM cipher ------------------------------------------------------

// HKDF over the raw compressed ECDH point (this is the part that diverges from
// spec NIP-44, which uses the x coordinate + hkdf-extract with a salt string).
function conversationKey(skBytes, pubHexXOnly, parity) {
	const point = secp256k1.getSharedSecret(skBytes, hexToBytes(parity + pubHexXOnly), true);
	return hkdf(sha256, point, new Uint8Array(0), utf8.encode("nip44-v2"), 32);
}

function bcEncrypt(plaintext, recipientPubHex, skBytes) {
	// encrypt always interprets the x-only recipient key as even-Y, like native
	const key = conversationKey(skBytes, recipientPubHex, "02");
	const nonce24 = crypto.getRandomValues(new Uint8Array(24));
	const sealed = xchacha20poly1305(key, nonce24).encrypt(utf8.encode(plaintext)); // ct || tag
	const combined = new Uint8Array(24 + sealed.length);
	combined.set(nonce24, 0);
	combined.set(sealed, 24);
	return "v2:" + b64urlEncode(combined);
}

function bcDecrypt(payload, senderPubHex, skBytes) {
	if (!payload.startsWith("v2:")) throw new Error("bad ciphertext prefix");
	const data = b64urlDecode(payload.slice(3));
	if (data.length <= 24 + 16) throw new Error("ciphertext too short");
	const nonce24 = data.slice(0, 24);
	const body = data.slice(24);
	// the sender key arrives x-only; native tries even-Y then odd-Y - so do we
	for (const parity of ["02", "03"]) {
		try {
			const key = conversationKey(skBytes, senderPubHex, parity);
			return utf8d.decode(xchacha20poly1305(key, nonce24).decrypt(body));
		} catch {
			/* wrong parity or genuinely bad - the second attempt decides */
		}
	}
	throw new Error("decrypt failed");
}

// --- NIP-17 layers (rumor -> seal -> gift wrap), built exactly like native ----

function randomizedNow() {
	// wrap/seal timestamps are fuzzed +/-15min for privacy; the true timestamp
	// lives inside the encrypted rumor
	return Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1801) - 900;
}

// content here is the "bitchat1:..." string, not the raw message text
export function createGiftWrap(content, recipientPubHex, senderSkBytes, senderPubHex) {
	// native serializes the unsigned rumor with id:"" and no sig field
	const rumor = { id: "", pubkey: senderPubHex, created_at: Math.floor(Date.now() / 1000), kind: RUMOR_KIND, tags: [], content };
	const seal = finalizeEvent(
		{ kind: SEAL_KIND, created_at: randomizedNow(), tags: [], content: bcEncrypt(JSON.stringify(rumor), recipientPubHex, senderSkBytes) },
		senderSkBytes
	);
	const wrapSk = generateSecretKey(); // throwaway key hides the sender from relays
	return finalizeEvent(
		{ kind: GIFT_WRAP_KIND, created_at: randomizedNow(), tags: [["p", recipientPubHex]], content: bcEncrypt(JSON.stringify(seal), recipientPubHex, wrapSk) },
		wrapSk
	);
}

// returns { content, senderPubkey, timestamp, authenticated }.
//
// two wire generations exist in native bitchat:
// - current builds sign the seal with the sender's identity key, so
//   seal.pubkey == rumor.pubkey and the sender is authenticated by the seal
//   signature (that equality became a hard requirement in their security-audit
//   fix, which the commit itself calls a breaking wire-protocol change).
// - builds before that fix sign the seal with a THROWAWAY key, so the two
//   pubkeys never match and the only sender claim is the rumor's - which is
//   unauthenticated (anyone knowing the recipient's npub could forge it).
// we accept both: `authenticated` tells the caller which kind this was, so the
// UI can mark legacy messages instead of dropping every DM from a deployed app.
export function decryptGiftWrap(giftWrap, recipientSkBytes) {
	const seal = JSON.parse(bcDecrypt(giftWrap.content, giftWrap.pubkey, recipientSkBytes));
	if (seal.kind !== SEAL_KIND || !verifyEvent(seal)) throw new Error("invalid seal");
	const rumor = JSON.parse(bcDecrypt(seal.content, seal.pubkey, recipientSkBytes));
	const sealPk = String(seal.pubkey || "").toLowerCase();
	const rumorPk = String(rumor.pubkey || "").toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(rumorPk)) throw new Error("bad rumor pubkey");
	const authenticated = sealPk === rumorPk;
	return {
		content: String(rumor.content || ""),
		senderPubkey: authenticated ? sealPk : rumorPk,
		timestamp: rumor.created_at,
		authenticated,
	};
}

// --- BitchatPacket binary codec (BinaryProtocol.swift, v1) --------------------

// [type byte][TLV messageID][TLV content]
function encodePmPayload(messageID, content) {
	const idBytes = utf8.encode(messageID);
	const contentBytes = utf8.encode(content);
	if (idBytes.length > 255 || contentBytes.length > 255) return null;
	const out = new Uint8Array(1 + 2 + idBytes.length + 2 + contentBytes.length);
	let o = 0;
	out[o++] = PAYLOAD_PRIVATE_MESSAGE;
	out[o++] = TLV_MESSAGE_ID;
	out[o++] = idBytes.length;
	out.set(idBytes, o);
	o += idBytes.length;
	out[o++] = TLV_CONTENT;
	out[o++] = contentBytes.length;
	out.set(contentBytes, o);
	return out;
}

// acks carry the raw messageID string after the type byte (no TLV)
function encodeAckPayload(type, messageID) {
	const idBytes = utf8.encode(messageID);
	const out = new Uint8Array(1 + idBytes.length);
	out[0] = type;
	out.set(idBytes, 1);
	return out;
}

// v1 header: ver(1) type(1) ttl(1) ts-ms(8 BE) flags(1) len(2 BE), then
// sender(8) [recipient(8)] payload [sig(64)], PKCS#7-padded to a block size.
// We never compress on send (the flag is optional; native decodes either way).
function encodePacket(payload, senderPeerId8) {
	const header = 14 + 8;
	const raw = new Uint8Array(header + payload.length);
	const dv = new DataView(raw.buffer);
	let o = 0;
	raw[o++] = 1; // version
	raw[o++] = MSG_TYPE_NOISE_ENCRYPTED;
	raw[o++] = PACKET_TTL;
	dv.setBigUint64(o, BigInt(Date.now()));
	o += 8;
	raw[o++] = 0; // flags: no recipient, no signature, no compression
	dv.setUint16(o, payload.length);
	o += 2;
	raw.set(senderPeerId8, o);
	o += 8;
	raw.set(payload, o);
	return pkcs7Pad(raw);
}

// MessagePadding.swift: pad to the smallest of 256/512/1024/2048 that fits
// (data + 16); skip padding when the needed amount can't fit one length byte.
function pkcs7Pad(data) {
	let target = data.length; // "very large" fallback: unpadded
	for (const block of [256, 512, 1024, 2048]) {
		if (data.length + 16 <= block) {
			target = block;
			break;
		}
	}
	const need = target - data.length;
	if (need <= 0 || need > 255) return data;
	const out = new Uint8Array(target);
	out.set(data, 0);
	out.fill(need, data.length);
	return out;
}

// length-driven parse; trailing PKCS#7 pad bytes are ignored automatically
// because every field is read by its declared size. async because compressed
// payloads (native compresses >=100 byte payloads) inflate via
// DecompressionStream("deflate-raw") - Apple's COMPRESSION_ZLIB is raw deflate.
async function decodePacket(raw) {
	if (raw.length < 14 + 8) return null;
	const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	let o = 0;
	const version = raw[o++];
	if (version !== 1) return null; // native sends v1 on the nostr path
	const type = raw[o++];
	o++; // ttl
	const timestamp = Number(dv.getBigUint64(o));
	o += 8;
	const flags = raw[o++];
	const payloadLength = dv.getUint16(o);
	o += 2;
	const senderID = raw.slice(o, o + 8);
	o += 8;
	let recipientID = null;
	if (flags & FLAG_HAS_RECIPIENT) {
		if (o + 8 > raw.length) return null;
		recipientID = raw.slice(o, o + 8);
		o += 8;
	}
	if (o + payloadLength > raw.length) return null;
	let payload;
	if (flags & FLAG_IS_COMPRESSED) {
		if (payloadLength < 2) return null;
		const originalSize = dv.getUint16(o);
		const compressed = raw.slice(o + 2, o + payloadLength);
		payload = await inflateRaw(compressed);
		if (!payload || payload.length !== originalSize) return null;
	} else {
		payload = raw.slice(o, o + payloadLength);
	}
	o += payloadLength;
	if (flags & FLAG_HAS_SIGNATURE && o + 64 > raw.length) return null;
	return { type, timestamp, senderID, recipientID, payload };
}

// Apple's Compression framework (COMPRESSION_ZLIB, what native uses) emits raw
// DEFLATE, so "deflate-raw" is the match - but try zlib-wrapped "deflate" too so
// we're robust to either envelope.
async function inflateRaw(bytes) {
	for (const format of ["deflate-raw", "deflate"]) {
		try {
			const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		} catch {
			/* try the next envelope */
		}
	}
	return null;
}

function decodeTlvPm(data) {
	let o = 0;
	let messageID = null;
	let content = null;
	while (o + 2 <= data.length) {
		const type = data[o++];
		const len = data[o++];
		if (o + len > data.length) return null;
		const value = data.slice(o, o + len);
		o += len;
		if (type === TLV_MESSAGE_ID) messageID = utf8d.decode(value);
		else if (type === TLV_CONTENT) content = utf8d.decode(value);
		else return null; // unknown TLV type - native rejects too
	}
	if (messageID == null || content == null) return null;
	return { messageID, content };
}

// "bitchat1:" envelope <-> a typed DM payload
export function encodeDmContent(kind, messageID, content, senderPubHex) {
	const senderPeerId8 = hexToBytes(senderPubHex.slice(0, 16)); // 8-byte peer id: leading bytes of our pubkey
	const payload =
		kind === "pm" ? encodePmPayload(messageID, content) : encodeAckPayload(kind === "read" ? PAYLOAD_READ_RECEIPT : PAYLOAD_DELIVERED, messageID);
	if (!payload) return null;
	return "bitchat1:" + b64urlEncode(encodePacket(payload, senderPeerId8));
}

// -> { kind: "pm"|"delivered"|"read", messageID, content? } or null
export async function decodeDmContent(content) {
	if (!content.startsWith("bitchat1:")) return null;
	let packet;
	try {
		packet = await decodePacket(b64urlDecode(content.slice(9)));
	} catch {
		return null;
	}
	if (!packet || packet.type !== MSG_TYPE_NOISE_ENCRYPTED || !packet.payload.length) return null;
	const payloadType = packet.payload[0];
	const body = packet.payload.slice(1);
	if (payloadType === PAYLOAD_PRIVATE_MESSAGE) {
		const pm = decodeTlvPm(body);
		return pm ? { kind: "pm", messageID: pm.messageID, content: pm.content } : null;
	}
	if (payloadType === PAYLOAD_DELIVERED || payloadType === PAYLOAD_READ_RECEIPT) {
		return { kind: payloadType === PAYLOAD_DELIVERED ? "delivered" : "read", messageID: utf8d.decode(body) };
	}
	return null;
}

// --- DM relay client ----------------------------------------------------------

// A small always-on socket set to the DM relays, independent of the geo pool
// and of assist mode: DMs are end-to-end encrypted with the local key, so they
// always ride direct client sockets (the api never sees them, encrypted or not).
export function createDmClient({ getIdentity, onMessage, onAck, onStatusChange }) {
	const sockets = new Map(); // url -> WebSocket
	const seenWraps = new Set(); // gift wrap event ids
	const seenMessageIDs = new Set(); // pm message ids (dedup across relays)
	let gen = 0; // bumped on resubscribe/stop; stale sockets no-op
	let started = false;
	// gift wraps replayed from relay storage (the day-long lookback) arrive before
	// EOSE; once any relay signals EOSE we flip `live` so subsequent wraps count as
	// genuinely new. the grace lets slower relays finish dumping their backlog.
	let live = false;
	let liveTimer = null;
	const stats = { wrapsSeen: 0, verifyFailed: 0, decryptFailed: 0, decodeFailed: 0, surfaced: 0, throttled: 0 };

	// opt-in wire tracing for debugging interop (e.g. native bitchat -> web). turn
	// on with `localStorage.glub_dm_debug = 1` then reload; every inbound gift wrap
	// is logged at each stage so you can see exactly where (if anywhere) it drops.
	const DEBUG = (() => {
		try {
			return !!localStorage.getItem("glub_dm_debug");
		} catch {
			return false;
		}
	})();
	const dlog = (...a) => {
		if (DEBUG) console.log("[dm]", ...a);
	};

	function remember(set, value) {
		set.add(value);
		if (set.size > MAX_SEEN) {
			// drop the oldest half; Set iterates in insertion order
			let i = 0;
			const cut = set.size / 2;
			for (const v of set) {
				if (i++ >= cut) break;
				set.delete(v);
			}
		}
	}

	function subFilter() {
		return {
			kinds: [GIFT_WRAP_KIND],
			"#p": [getIdentity().pk],
			since: Math.floor(Date.now() / 1000) - SUB_LOOKBACK_SECS,
			limit: 100,
		};
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
			ws.send(JSON.stringify(["REQ", "glub-dm", subFilter()]));
			dlog("REQ ->", url.replace(/^wss?:\/\//, ""), "kind 1059 #p", getIdentity().pk.slice(0, 12));
			onStatusChange?.();
		});

		ws.addEventListener("close", () => {
			if (sockets.get(url) === ws) sockets.delete(url);
			onStatusChange?.();
			if (myGen !== gen) return;
			const delay = Math.min(MAX_BACKOFF_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5));
			setTimeout(() => {
				if (myGen === gen) connect(url, attempt + 1);
			}, delay);
		});

		ws.addEventListener("error", () => {});

		ws.addEventListener("message", (msg) => {
			let frame;
			try {
				frame = JSON.parse(msg.data);
			} catch {
				return;
			}
			if (!Array.isArray(frame)) return;
			if (frame[0] === "CLOSED" && frame[1] === "glub-dm") {
				dlog("sub CLOSED @", url.replace(/^wss?:\/\//, ""), frame[2]);
				return;
			}
			if (frame[0] === "EOSE" && frame[1] === "glub-dm") {
				dlog("EOSE @", url.replace(/^wss?:\/\//, ""), "- backlog done");
				if (!live && !liveTimer) liveTimer = setTimeout(() => (live = true), 1500);
				return;
			}
			if (frame[0] !== "EVENT" || frame[1] !== "glub-dm") return;
			dlog("<- 1059", frame[2]?.id?.slice(0, 10), "wrapPk", frame[2]?.pubkey?.slice(0, 8), live ? "live" : "backlog", "@", url.replace(/^wss?:\/\//, ""));
			enqueueWrap(frame[2]);
		});
	}

	// unwrap throttle: every gift wrap costs an ECDH + two decrypt layers, and
	// wraps are indistinguishable until decrypted - so a wrap-flood addressed to
	// us is a CPU DoS. queue and drain at a bounded rate; overflow past the queue
	// cap is dropped (restored DM history in localStorage covers the loss on a
	// huge backlog). the live/backlog phase is snapshotted at ENQUEUE time, since
	// `live` may flip while a wrap waits in the queue.
	const UNWRAP_PER_TICK = 8;
	const UNWRAP_TICK_MS = 200; // 40/s sustained - a few % of cpu, worst case
	const UNWRAP_QUEUE_MAX = 300;
	const unwrapQueue = [];
	let unwrapTimer = null;

	function enqueueWrap(ev) {
		if (!ev?.id || ev.kind !== GIFT_WRAP_KIND) return;
		if (seenWraps.has(ev.id)) return; // cheap dedup before spending queue space
		if (unwrapQueue.length >= UNWRAP_QUEUE_MAX) {
			stats.throttled += 1;
			return;
		}
		unwrapQueue.push({ ev, historical: !live });
		if (!unwrapTimer) {
			unwrapTimer = setInterval(drainUnwraps, UNWRAP_TICK_MS);
			drainUnwraps(); // first batch immediately - normal traffic never waits
		}
	}

	function drainUnwraps() {
		for (let i = 0; i < UNWRAP_PER_TICK && unwrapQueue.length; i++) {
			const { ev, historical } = unwrapQueue.shift();
			handleWrap(ev, historical);
		}
		if (!unwrapQueue.length) {
			clearInterval(unwrapTimer);
			unwrapTimer = null;
		}
	}

	async function handleWrap(ev, historical) {
		if (seenWraps.has(ev.id)) return; // may have been unwrapped while queued
		stats.wrapsSeen += 1;
		if (!verifyEvent(ev)) {
			stats.verifyFailed += 1;
			dlog("x verify failed", ev.id.slice(0, 10));
			return;
		}
		remember(seenWraps, ev.id);

		const { sk, pk } = getIdentity();
		let opened;
		try {
			opened = decryptGiftWrap(ev, sk);
		} catch (e) {
			stats.decryptFailed += 1;
			dlog("x decrypt failed", ev.id.slice(0, 10), e && e.message);
			return; // not for this key / corrupt - usually just noise, drop
		}
		if (opened.senderPubkey === pk) return; // our own reflected wrap

		const dm = await decodeDmContent(opened.content);
		if (!dm) {
			stats.decodeFailed += 1;
			dlog("x decode failed; content head:", (opened.content || "").slice(0, 48));
			return;
		}
		dlog(
			"ok surfaced",
			dm.kind,
			opened.authenticated ? "(authenticated)" : "(legacy/unverified)",
			"from",
			opened.senderPubkey.slice(0, 8),
			dm.kind === "pm" ? JSON.stringify((dm.content || "").slice(0, 40)) : ""
		);
		stats.surfaced += 1;

		if (dm.kind === "pm") {
			if (seenMessageIDs.has(dm.messageID)) return;
			remember(seenMessageIDs, dm.messageID);
			// only ack live messages - acking the whole backlog on every reload would
			// spam the sender (and burn relay writes)
			if (!historical) sendAck("delivered", dm.messageID, opened.senderPubkey);
			onMessage?.({
				senderPubkey: opened.senderPubkey,
				messageID: dm.messageID,
				content: dm.content,
				timestamp: opened.timestamp,
				authenticated: opened.authenticated,
				historical,
			});
		} else {
			onAck?.({ senderPubkey: opened.senderPubkey, messageID: dm.messageID, kind: dm.kind });
		}
	}

	function publish(event) {
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

	function wrapAndSend(kind, messageID, content, recipientPubHex) {
		const { sk, pk } = getIdentity();
		const embedded = encodeDmContent(kind, messageID, content, pk);
		if (!embedded) return 0;
		return publish(createGiftWrap(embedded, recipientPubHex, sk, pk));
	}

	function sendAck(kind, messageID, recipientPubHex) {
		try {
			wrapAndSend(kind, messageID, "", recipientPubHex);
		} catch {
			/* acks are best-effort */
		}
	}

	return {
		start() {
			if (started) return;
			started = true;
			for (const url of DM_RELAYS) connect(url);
		},
		// identity changed: drop every socket and re-REQ under the new pubkey. the
		// new key's backlog should be historical again, so reset the live gate.
		resubscribe() {
			if (!started) return;
			gen++;
			live = false;
			clearTimeout(liveTimer);
			liveTimer = null;
			for (const ws of sockets.values()) ws.close();
			sockets.clear();
			for (const url of DM_RELAYS) connect(url);
		},
		// returns the messageID when handed to >=1 open socket, null when it
		// couldn't go out (no sockets / content too long)
		sendDm(content, recipientPubHex) {
			const messageID = crypto.randomUUID().toUpperCase(); // native uses uppercase UUIDs
			remember(seenMessageIDs, messageID);
			const sent = wrapAndSend("pm", messageID, content, recipientPubHex);
			return sent > 0 ? messageID : null;
		},
		// tell the sender we've read their message (native shows this as a read
		// receipt); best-effort, mirrors what native does when a thread is viewed
		sendRead(messageID, recipientPubHex) {
			sendAck("read", messageID, recipientPubHex);
		},
		get connectedCount() {
			let n = 0;
			for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) n++;
			return n;
		},
		// receive-pipeline tallies, handy for interop debugging: how many gift wraps
		// arrived and where they dropped (verify / decrypt / decode) vs surfaced.
		stats() {
			return { ...stats, connected: this.connectedCount };
		},
	};
}
