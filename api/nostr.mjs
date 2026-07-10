import { verifyEvent } from "nostr-tools";

// the client's protocol.js imports nostr-tools from esm.sh (a browser URL Node
// can't resolve), so the api keeps its own tiny copy of the few helpers it
// needs rather than importing that module.

export const CHAT_KIND = 20000;
export const PRESENCE_KIND = 20001; // bitchat presence/announce ("i'm here") events
export const METADATA_KIND = 0; // nostr profile metadata (NIP-01 set_metadata)
export const NOTE_KIND = 1; // location notes: persistent geohash-tagged text notes
export const DELETE_KIND = 5; // NIP-09 deletion request

// parse a kind-0 metadata event's JSON content into the fields we surface. only
// the display bits (name/about/picture/nip05), each length-capped. null if the
// event isn't usable.
export function parseProfile(ev) {
	if (!ev || ev.kind !== METADATA_KIND) return null;
	let data;
	try {
		data = JSON.parse(ev.content);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
	// the bio gets a generous cap; when it does overflow we keep the truncation
	// visible with a "... (N chars)" tail (N = the true original length) rather
	// than silently swallowing the rest.
	const ABOUT_MAX = 2000;
	const rawAbout = typeof data.about === "string" ? data.about : "";
	const about =
		rawAbout.length > ABOUT_MAX
			? `${rawAbout.slice(0, ABOUT_MAX).trimEnd()}... (${rawAbout.length} chars)`
			: rawAbout;
	return {
		name: str(data.display_name || data.displayName || data.name, 64),
		about,
		picture: str(data.picture, 512),
		banner: str(data.banner, 512),
		nip05: str(data.nip05, 128),
		website: str(data.website, 256),
		lud16: str(data.lud16, 128), // lightning address
		updated: typeof ev.created_at === "number" ? ev.created_at : 0, // revision token: bumps on every profile edit
	};
}

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

// the NIP-40 expiration (unix secs) an event carries, or null.
export function noteExpiration(ev) {
	const raw = getTag(ev, "expiration");
	const n = Number(raw);
	return raw && Number.isFinite(n) ? n : null;
}

// the event ids a NIP-09 deletion (kind 5) references via its `e` tags.
export function deletionTargets(ev) {
	const tags = Array.isArray(ev.tags) ? ev.tags : [];
	return tags.filter((t) => Array.isArray(t) && t[0] === "e" && typeof t[1] === "string").map((t) => t[1]);
}

export { verifyEvent };
