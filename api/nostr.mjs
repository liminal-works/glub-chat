import { verifyEvent } from "nostr-tools";

// the client's protocol.js imports nostr-tools from esm.sh (a browser URL Node
// can't resolve), so the api keeps its own tiny copy of the few helpers it
// needs rather than importing that module.

export const CHAT_KIND = 20000;
export const PRESENCE_KIND = 20001; // bitchat presence/announce ("i'm here") events

// first value of the first tag matching `key`, or "" if absent.
function getTag(ev, key) {
	const tags = Array.isArray(ev.tags) ? ev.tags : [];
	const t = tags.find((x) => Array.isArray(x) && x[0] === key);
	return t && typeof t[1] === "string" ? t[1] : "";
}

export function getGeohash(ev) {
	return getTag(ev, "g");
}

export function getName(ev) {
	return getTag(ev, "n");
}

export { verifyEvent };
