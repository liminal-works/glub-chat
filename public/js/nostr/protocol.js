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
