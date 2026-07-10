import { finalizeEvent, verifyEvent } from "https://esm.sh/nostr-tools@2";

// re-exported so the client can verify events the (untrusted) history api hands
// back - the api is a convenience transport, not an authority.
export { verifyEvent };

// bitchat's geohash channels ride on these two ephemeral nostr kinds:
// 20000 = chat message, 20001 = presence/announce.
export const CHAT_KIND = 20000;
export const PRESENCE_KIND = 20001;

// no `since` - relays are asked for whatever backlog of these ephemeral
// kinds they're still holding/rebroadcasting, capped by `limit`.
export function subscribeFilter(limit = 500) {
	return { kinds: [CHAT_KIND, PRESENCE_KIND], limit };
}

// "teleport" marks a message posted into a geohash we're not physically in -
// always true for this web client, since you pick any channel regardless of
// location. Matches what bitchat/the reference web client sends.
function geoTags(geohash, name) {
	const tags = [["g", geohash], ["t", "teleport"]];
	if (name) tags.push(["n", name]);
	return tags;
}

// build/sign are split so events can be worked on between the two steps -
// NIP-13 mining appends a nonce tag to the UNSIGNED event (the nonce changes
// the id, so it must be settled before signing). created_at is stamped at
// build time and must not change afterwards for the same reason.
export function buildChatEvent({ content, geohash, name, pk }) {
	return {
		kind: CHAT_KIND,
		created_at: Math.floor(Date.now() / 1000),
		tags: geoTags(geohash, name),
		content,
		pubkey: pk,
	};
}

// a presence/announce heartbeat: "i'm in this geohash". Same tag conventions as
// a chat message (g + teleport + n) but the ephemeral 20001 kind and empty
// content - the name in the `n` tag is the whole payload.
export function buildPresenceEvent({ geohash, name, pk }) {
	return {
		kind: PRESENCE_KIND,
		created_at: Math.floor(Date.now() / 1000),
		tags: geoTags(geohash, name),
		content: "",
		pubkey: pk,
	};
}

// bitchat's "location notes": persistent (stored) kind-1 text notes tagged to a
// geohash, optionally expiring via NIP-40. Unlike chat (ephemeral 20000) these
// stick around on relays, so a channel accrues a little bulletin board. Deletes
// are NIP-09 kind-5. No teleport tag and no PoW - matches native exactly.
export const NOTE_KIND = 1;
export const DELETE_KIND = 5;

// build an unsigned location note. expiresAt is a unix-seconds number or null
// (null = never expires). name goes in an `n` tag like chat.
export function buildNoteEvent({ content, geohash, name, pk, expiresAt = null }) {
	const tags = [["g", geohash]];
	if (name) tags.push(["n", name]);
	if (expiresAt) tags.push(["expiration", String(Math.floor(expiresAt))]);
	return {
		kind: NOTE_KIND,
		created_at: Math.floor(Date.now() / 1000),
		tags,
		content,
		pubkey: pk,
	};
}

export function makeNote({ content, geohash, name, expiresAt, sk, pk }) {
	return signEvent(buildNoteEvent({ content, geohash, name, pk, expiresAt }), sk);
}

// a NIP-09 deletion request for one of your own notes (relays that honor it drop
// the referenced event; we also drop it locally regardless).
export function makeDeleteEvent({ eventId, sk, pk }) {
	return signEvent(
		{ kind: DELETE_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["e", eventId]], content: "", pubkey: pk },
		sk,
	);
}

// the NIP-40 expiration (unix secs) an event carries, or null.
export function noteExpiration(ev) {
	const raw = getTag(ev, "expiration");
	const n = Number(raw);
	return raw && Number.isFinite(n) ? n : null;
}

export function signEvent(unsigned, sk) {
	return finalizeEvent(unsigned, sk);
}

// one-step build+sign, for callers that don't mine
export function makeChatMessage({ content, geohash, name, sk, pk }) {
	return signEvent(buildChatEvent({ content, geohash, name, pk }), sk);
}

export function makePresenceEvent({ geohash, name, sk, pk }) {
	return signEvent(buildPresenceEvent({ geohash, name, pk }), sk);
}

export function getTag(ev, key) {
	const tags = Array.isArray(ev.tags) ? ev.tags : [];
	return tags.find((t) => Array.isArray(t) && t[0] === key)?.[1] || "";
}

export function getGeohash(ev) {
	return getTag(ev, "g");
}

export function getName(ev) {
	return getTag(ev, "n");
}

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

// decodes a geohash string to its center { lat, lon }
export function decodeGeohash(geohash) {
	let evenBit = true;
	let latLo = -90, latHi = 90;
	let lonLo = -180, lonHi = 180;

	for (const c of geohash.toLowerCase()) {
		const idx = GEOHASH_BASE32.indexOf(c);
		if (idx === -1) throw new Error(`invalid geohash character: ${c}`);

		for (let bit = 4; bit >= 0; bit--) {
			const bitValue = (idx >> bit) & 1;
			if (evenBit) {
				const mid = (lonLo + lonHi) / 2;
				if (bitValue === 1) lonLo = mid;
				else lonHi = mid;
			} else {
				const mid = (latLo + latHi) / 2;
				if (bitValue === 1) latLo = mid;
				else latHi = mid;
			}
			evenBit = !evenBit;
		}
	}

	return { lat: (latLo + latHi) / 2, lon: (lonLo + lonHi) / 2 };
}

// every geohash cell contained within `prefix` down a bounded number of levels,
// including `prefix` itself. Notes are tagged with the poster's exact channel
// geohash, and a channel contains all finer channels nested under it (a note in
// #9qh5 belongs to #9q), so subscribing to the whole subtree + matching g-tags
// by prefix surfaces those nested notes instead of only exact-cell matches.
//
// Nostr `#g` filters are exact-match only (no prefix operator), so we enumerate
// the descendant cells and hand the relay the explicit list. Depth is capped so
// the filter stays a sane size (each level multiplies the count by 32) and we
// don't descend past building-level precision, where notes don't exist.
export const NOTES_SUBTREE_DEPTH = 2; // channel + this many finer levels
const NOTES_MAX_PRECISION = 8; // don't enumerate past ~building precision
const NOTES_MAX_CELLS = 1200; // hard cap on the #g array (relay safety)

export function geohashSubtreeCells(prefix) {
	const p = String(prefix).toLowerCase();
	const cells = [p];
	const maxLen = Math.min(p.length + NOTES_SUBTREE_DEPTH, NOTES_MAX_PRECISION);
	let frontier = [p];
	while (frontier.length && frontier[0].length < maxLen) {
		const next = [];
		for (const cell of frontier) for (const c of GEOHASH_BASE32) next.push(cell + c);
		if (cells.length + next.length > NOTES_MAX_CELLS) break;
		cells.push(...next);
		frontier = next;
	}
	return cells;
}

// a geohash cell's center + nominal size. each character is 5 bits, split
// longitude-first (lon gets ceil(bits/2)); the cell is 360/2^lonBits degrees
// wide. spanKm is that width at the EQUATOR (not latitude-adjusted) - native
// bitchat quotes this figure for a channel's coverage (a 2-char geohash reads
// ~1250km / ~777mi, a 5-char ~4.9km / ~3.0mi), so we reproduce it. throws on a
// non-geohash string, same as decodeGeohash - callers use that to skip
// word-channels.
export function geohashCell(geohash) {
	const { lat, lon } = decodeGeohash(geohash);
	const lonBits = Math.ceil((geohash.length * 5) / 2);
	const spanKm = (360 / 2 ** lonBits) * 111.32;
	return { lat, lon, spanKm };
}

// great-circle distance in km between two lat/lon points
export function haversineKm(a, b) {
	const R = 6371;
	const dLat = ((b.lat - a.lat) * Math.PI) / 180;
	const dLon = ((b.lon - a.lon) * Math.PI) / 180;
	const lat1 = (a.lat * Math.PI) / 180;
	const lat2 = (b.lat * Math.PI) / 180;

	const sinDLat = Math.sin(dLat / 2);
	const sinDLon = Math.sin(dLon / 2);
	const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;

	return 2 * R * Math.asin(Math.sqrt(h));
}

// sorts relays by distance from a geohash channel's center, nearest first
export function sortRelaysByGeohash(relays, geohash) {
	const center = decodeGeohash(geohash);
	return relays
		.map((relay) => ({ relay, distKm: haversineKm(center, { lat: relay.lat, lon: relay.lon }) }))
		.sort((a, b) => a.distKm - b.distKm)
		.map((x) => x.relay);
}
