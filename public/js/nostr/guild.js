// Guilds: password-gated encrypted group chat, with no server and no registry.
//
// There is no native bitchat equivalent - this is glub's own - so the design is
// built around one idea: a guild is a FREQUENCY, and the password is the only thing
// that tunes you to it. Both the public routing tag and the encryption key are
// derived from (name, password) by one slow KDF pass:
//
//   master = PBKDF2(password, salt = sha256("glub-guild-v1|" + name), ITER, 64 bytes)
//   key    = master[0..32]    the xchacha key; never leaves this device
//   freq   = sha256("glub-guild-freq-v1|" + master[32..64])   the public "g" tag
//
// Consequences that fall out of that, all of them wanted:
//   * two guilds sharing a name but not a password land on DIFFERENT tags, so their
//     traffic is separated by the relays themselves rather than by decryption - it
//     cannot bleed even in principle;
//   * "create" and "join" are the same operation, because there is nothing to
//     register with. You either derive the right frequency or you are elsewhere;
//   * a compromised password is not revoked, it is abandoned: pick a new one and the
//     guild is simply a different frequency.
//
// The frequency is deliberately derived from the SLOW half of the KDF, not from a
// cheap hash of the password. Otherwise publishing it would hand an attacker a fast
// oracle - guess a password, compute a frequency, check for traffic - that is far
// cheaper than attacking the ciphertext. Deriving both from the same PBKDF2 pass
// keeps the cost of a guess identical either way.
//
// Events use kind 20002: ephemeral (like chat), ignored by the main subscription,
// and never requested by native clients. Everything except the frequency tag is
// encrypted - including the sender's display name - so an observer sees only that
// an opaque blob landed on some frequency.
//
// KNOWN, DELIBERATE LIMITS (see the UI copy, which says so plainly):
//   * messages are signed with your real key, so an observer can see WHICH pubkeys
//     post to a frequency. Contents are private; the membership graph is not.
//   * no password means the key is derivable by anyone who guesses the name. That is
//     obfuscation, not privacy.
//   * a low-entropy password can be attacked offline forever against any captured
//     ciphertext. PBKDF2 raises the cost per guess; it cannot make it go away.
//   * no forward secrecy: someone who learns the password can read past traffic they
//     captured earlier.
//   * uploaded media (images, voice notes) is hosted UNENCRYPTED by the api, exactly
//     as it is for public channels. What the seal protects is the link, not the
//     bytes: only members learn the url, but anyone who obtains it - or who runs the
//     host - can fetch the file. The filename's 64 bits of randomness make guessing
//     one impractical, which is a different guarantee from the one the rest of this
//     module provides, and worth knowing before sending something sensitive.

import { finalizeEvent, verifyEvent } from "https://esm.sh/nostr-tools@2";
import { sha256 } from "https://esm.sh/@noble/hashes@2.0.1/sha2";
import { xchacha20poly1305 } from "https://esm.sh/@noble/ciphers@2.1.1/chacha";

export const GUILD_KIND = 20002;

const PBKDF2_ITER = 300_000; // ~a quarter second on a phone; paid once per join
const NONCE_BYTES = 24; // xchacha
const MAX_NAME_LEN = 40;
const SUB_LIMIT = 200;
const MAX_BACKOFF_MS = 30_000;
const RELAY_COUNT = 8; // a guild is not geographic, so this is just breadth

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

// a guild name is matched by its normalized form, so "#Minecraft " and "minecraft"
// are the same room rather than two silently different frequencies.
export function normalizeGuildName(raw) {
	return String(raw || "")
		.trim()
		.replace(/^#/, "")
		.slice(0, MAX_NAME_LEN)
		.toLowerCase();
}

function bytesToHex(b) {
	let s = "";
	for (const x of b) s += x.toString(16).padStart(2, "0");
	return s;
}

function hexToBytes(hex) {
	const s = String(hex || "");
	if (s.length % 2 || !/^[0-9a-f]*$/i.test(s)) return null;
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function toBase64(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function fromBase64(b64) {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

function concat(a, b) {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

// PBKDF2 through WebCrypto: native, hardware-backed, and async so a 300k-iteration
// stretch never blocks the frame.
async function stretch(password, salt, bytes) {
	const base = await crypto.subtle.importKey("raw", utf8.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
		base,
		bytes * 8,
	);
	return new Uint8Array(bits);
}

// (name, password) -> { name, freq, key }. The single source of truth for what a
// guild IS; everything else in this module just moves bytes around.
export async function deriveGuild(rawName, password) {
	const name = normalizeGuildName(rawName);
	if (!name) throw new Error("guild name required");
	const salt = sha256(utf8.encode(`glub-guild-v1|${name}`));
	const master = await stretch(String(password || ""), salt, 64);
	const key = master.slice(0, 32);
	const freq = bytesToHex(sha256(concat(utf8.encode("glub-guild-freq-v1|"), master.slice(32, 64)))).slice(0, 32);
	return { name, freq, key };
}

// a stored guild carries its derived key so a reload doesn't need the password
// again. Same trust model as the nsec this app already keeps in localStorage: a
// device that can read one can read the other.
export function serializeGuild(g) {
	return { name: g.name, freq: g.freq, key: bytesToHex(g.key) };
}

export function deserializeGuild(o) {
	if (!o || typeof o !== "object") return null;
	const name = normalizeGuildName(o.name);
	const key = hexToBytes(o.key);
	if (!name || !key || key.length !== 32) return null;
	if (typeof o.freq !== "string" || !/^[0-9a-f]{32}$/.test(o.freq)) return null;
	return { name, freq: o.freq, key };
}

// { n, m, r, f, l } -> base64(nonce || ciphertext). Everything the reader needs,
// including who sent it, lives inside the sealed blob.
export function sealGuildPayload(key, payload) {
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const ct = xchacha20poly1305(key, nonce).encrypt(utf8.encode(JSON.stringify(payload)));
	return toBase64(concat(nonce, ct));
}

// null on anything that isn't ours: wrong key, tampering, or junk posted to the
// frequency by someone who can see the tag but not read it.
export function openGuildPayload(key, b64) {
	try {
		const raw = fromBase64(String(b64 || ""));
		if (raw.length <= NONCE_BYTES) return null;
		const pt = xchacha20poly1305(key, raw.slice(0, NONCE_BYTES)).decrypt(raw.slice(NONCE_BYTES));
		const obj = JSON.parse(utf8Decode.decode(pt));
		return obj && typeof obj === "object" ? obj : null;
	} catch {
		return null;
	}
}

export function buildGuildEvent({ payload, guild, pk }) {
	return {
		kind: GUILD_KIND,
		created_at: Math.floor(Date.now() / 1000),
		// the ONLY plaintext: which frequency this belongs to
		tags: [["g", guild.freq]],
		content: sealGuildPayload(guild.key, payload),
		pubkey: pk,
	};
}

// --- relay client ---------------------------------------------------------------
// Owns its own sockets, exactly like the notes and DM clients, so guilds keep
// working with server assist off - the whole point is that this needs no server.
//
// createGuildClient({ getIdentity, getRelays, onMessage, onState })
//   getRelays() -> [wssUrl]        the global relay set (a guild has no geography)
//   onMessage({ id, pubkey, createdAt, freq, payload })
//   onState({ connected, total })
export function createGuildClient({ getIdentity, getRelays, onMessage, onState } = {}) {
	const sockets = new Map(); // url -> WebSocket
	let gen = 0; // bumped on open/close so stale sockets and timers no-op
	let guild = null;
	let sub = null;
	const seen = new Set();

	const emitState = () => {
		let connected = 0;
		for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) connected++;
		onState?.({ connected, total: sockets.size });
	};

	function closeAll() {
		for (const ws of sockets.values()) {
			try {
				ws.close();
			} catch {}
		}
		sockets.clear();
	}

	function handleFrame(raw) {
		let frame;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!Array.isArray(frame) || frame[0] !== "EVENT" || frame[1] !== sub) return;
		const ev = frame[2];
		if (!ev || ev.kind !== GUILD_KIND || typeof ev.content !== "string") return;
		if (seen.has(ev.id)) return;
		// relays are untrusted transport: check the signature before doing anything
		// with the payload, exactly as the chat and notes paths do.
		let ok = false;
		try {
			ok = verifyEvent(ev);
		} catch {
			ok = false;
		}
		if (!ok) return;
		const tag = (ev.tags || []).find((t) => Array.isArray(t) && t[0] === "g");
		if (!tag || tag[1] !== guild.freq) return;
		const payload = openGuildPayload(guild.key, ev.content);
		if (!payload) return; // not ours to read
		seen.add(ev.id);
		if (seen.size > 4000) seen.clear();
		onMessage?.({ id: ev.id, pubkey: ev.pubkey, createdAt: ev.created_at, freq: guild.freq, payload });
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
		ws.onopen = () => {
			if (myGen !== gen) return void ws.close();
			ws.send(JSON.stringify(["REQ", sub, { kinds: [GUILD_KIND], "#g": [guild.freq], limit: SUB_LIMIT }]));
			emitState();
		};
		ws.onmessage = (e) => {
			if (myGen === gen && guild) handleFrame(e.data);
		};
		ws.onclose = () => {
			if (myGen !== gen) return;
			sockets.delete(url);
			emitState();
			const delay = Math.min(MAX_BACKOFF_MS, 800 * 2 ** attempt);
			setTimeout(() => {
				if (myGen === gen && guild) connect(url, attempt + 1);
			}, delay);
		};
		ws.onerror = () => {
			try {
				ws.close();
			} catch {}
		};
	}

	function open(next) {
		gen++;
		closeAll();
		seen.clear();
		guild = next;
		if (!guild) return void emitState();
		sub = `guild-${Math.random().toString(36).slice(2, 10)}`;
		const urls = (getRelays?.() || []).slice(0, RELAY_COUNT);
		for (const url of urls) connect(url);
		emitState();
	}

	function close() {
		gen++;
		guild = null;
		closeAll();
		emitState();
	}

	// sign + fan out. Returns the signed event so the caller can echo it locally
	// without waiting for a relay to hand it back.
	function post(payload) {
		if (!guild) return null;
		const { sk, pk } = getIdentity();
		let event;
		try {
			event = finalizeEvent(buildGuildEvent({ payload, guild, pk }), sk);
		} catch {
			return null;
		}
		seen.add(event.id); // our own echo shouldn't render twice
		const msg = JSON.stringify(["EVENT", event]);
		let sent = 0;
		for (const ws of sockets.values()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			try {
				ws.send(msg);
				sent++;
			} catch {}
		}
		return { event, relays: sent };
	}

	return { open, close, post, get guild() { return guild; } };
}
