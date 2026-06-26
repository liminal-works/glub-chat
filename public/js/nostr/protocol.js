import { finalizeEvent } from "https://esm.sh/nostr-tools@2";

// bitchat's geohash channels ride on these two ephemeral nostr kinds:
// 20000 = chat message, 20001 = presence/announce.
export const CHAT_KIND = 20000;
export const PRESENCE_KIND = 20001;

export function subscribeFilter(sinceSec) {
	return { kinds: [CHAT_KIND, PRESENCE_KIND], since: sinceSec };
}

export function makeChatMessage({ content, geohash, name, sk, pk }) {
	const tags = [["g", geohash]];
	if (name) tags.push(["n", name]);

	return finalizeEvent(
		{
			kind: CHAT_KIND,
			created_at: Math.floor(Date.now() / 1000),
			tags,
			content,
			pubkey: pk,
		},
		sk
	);
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
