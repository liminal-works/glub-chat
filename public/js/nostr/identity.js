import { getPublicKey } from "https://esm.sh/nostr-tools@2";

const STORAGE_NAME_KEY = "glub_name";
const STORAGE_NAME_GEN_KEY = "glub_name_generated"; // was the stored name auto-generated (anon####) vs chosen?
const STORAGE_SK_KEY = "glub_sk";

function randomHex(len) {
	const bytes = new Uint8Array(len / 2);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
	return Uint8Array.from(hex.match(/.{1,2}/g).map((h) => parseInt(h, 16)));
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

export function getStoredName() {
	return localStorage.getItem(STORAGE_NAME_KEY);
}

// whether the stored name was auto-generated for the user (vs a name they chose).
// drives whether "random" re-rolls the name or keeps it.
export function isStoredNameGenerated() {
	return localStorage.getItem(STORAGE_NAME_GEN_KEY) === "1";
}

export function setStoredName(name, generated) {
	localStorage.setItem(STORAGE_NAME_KEY, name);
	localStorage.setItem(STORAGE_NAME_GEN_KEY, generated ? "1" : "0");
}
