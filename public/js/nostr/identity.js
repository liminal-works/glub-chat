import { getPublicKey } from "https://esm.sh/nostr-tools@2";

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

export function getStoredName() {
	return localStorage.getItem(STORAGE_NAME_KEY);
}

export function setStoredName(name) {
	localStorage.setItem(STORAGE_NAME_KEY, name);
}
