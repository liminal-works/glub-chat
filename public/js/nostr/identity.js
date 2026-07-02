import { getPublicKey, nip19 } from "https://esm.sh/nostr-tools@2";

const STORAGE_NAME_KEY = "glub_name";
const STORAGE_SK_KEY = "glub_sk";

function randomHex(len) {
	const bytes = new Uint8Array(len / 2);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
	return Uint8Array.from(hex.match(/.{1,2}/g).map((h) => parseInt(h, 16)));
}

function bytesToHex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// secret key never leaves the browser — generated, stored, and used here only.
export function loadOrCreateIdentity() {
	let skHex = localStorage.getItem(STORAGE_SK_KEY);

	if (!/^[0-9a-f]{64}$/.test(skHex || "")) {
		skHex = randomHex(64);
		localStorage.setItem(STORAGE_SK_KEY, skHex);
	}

	const sk = hexToBytes(skHex);
	const pk = getPublicKey(sk);

	return { sk, pk };
}

// throw away the current keypair and mint a fresh one (a brand new identity).
// stored in place of the old, so it persists like any other.
export function regenerateIdentity() {
	const skHex = randomHex(64);
	localStorage.setItem(STORAGE_SK_KEY, skHex);
	const sk = hexToBytes(skHex);
	const pk = getPublicKey(sk);
	return { sk, pk };
}

// a candidate keypair that is NOT persisted - used to brute-force a vanity pubkey
// suffix; only the winner gets adopted via adoptIdentity.
export function candidateKeypair() {
	const skHex = randomHex(64);
	return { skHex, pk: getPublicKey(hexToBytes(skHex)) };
}

// persist a specific secret key (hex) as the identity. returns { sk, pk }.
export function adoptIdentity(skHex) {
	if (!/^[0-9a-f]{64}$/.test(skHex)) throw new Error("bad secret key");
	localStorage.setItem(STORAGE_SK_KEY, skHex);
	const sk = hexToBytes(skHex);
	return { sk, pk: getPublicKey(sk) };
}

// decode a bech32 nsec into a 64-char hex secret key (throws if not an nsec).
export function skHexFromNsec(nsec) {
	const { type, data } = nip19.decode(String(nsec).trim());
	if (type !== "nsec") throw new Error("not an nsec");
	return bytesToHex(data);
}

// encode a secret key (Uint8Array) as a bech32 nsec, for backup/export.
export function skToNsec(sk) {
	return nip19.nsecEncode(sk);
}

export function getStoredName() {
	return localStorage.getItem(STORAGE_NAME_KEY);
}

export function setStoredName(name) {
	localStorage.setItem(STORAGE_NAME_KEY, name);
}
