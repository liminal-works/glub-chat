import { verifyEvent } from "nostr-tools";

// the client's protocol.js imports nostr-tools from esm.sh (a browser URL Node
// can't resolve), so the api keeps its own tiny copy of the few helpers it
// needs rather than importing that module.

export const CHAT_KIND = 20000;

export function getGeohash(ev) {
	const tags = Array.isArray(ev.tags) ? ev.tags : [];
	const g = tags.find((t) => Array.isArray(t) && t[0] === "g");
	return g && typeof g[1] === "string" ? g[1] : "";
}

export { verifyEvent };
