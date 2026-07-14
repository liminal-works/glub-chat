// Server-side geohash geometry, ported verbatim from the old global bot so the
// bot's geo math (relay fan-out targeting, reverse-geocoded flags) is bit-for-bit
// the behaviour it had before. The browser client has its own copy in
// public/js/nostr/protocol.js (which pulls nostr-tools from esm.sh and so can't
// be imported by Node); this is the Node-side twin.

// geohash -> center { lat, lon }, or null for an empty / non-geohash string.
export function geohashToLatLon(geohash, { throwOnInvalid = false } = {}) {
	const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
	const clean = String(geohash || "").trim().toLowerCase();

	if (!clean) {
		if (throwOnInvalid) throw new Error("Empty geohash");
		return null;
	}

	let even = true;
	let lat = [-90.0, 90.0];
	let lon = [-180.0, 180.0];

	for (const ch of clean) {
		const idx = base32.indexOf(ch);

		if (idx === -1) {
			if (throwOnInvalid) throw new Error(`Invalid geohash char: ${ch}`);
			return null;
		}

		for (let bit = 4; bit >= 0; bit--) {
			const b = (idx >> bit) & 1;

			if (even) {
				const mid = (lon[0] + lon[1]) / 2;
				if (b) lon[0] = mid;
				else lon[1] = mid;
			} else {
				const mid = (lat[0] + lat[1]) / 2;
				if (b) lat[0] = mid;
				else lat[1] = mid;
			}

			even = !even;
		}
	}

	return {
		lat: (lat[0] + lat[1]) / 2,
		lon: (lon[0] + lon[1]) / 2,
	};
}

// great-circle distance in km between two lat/lon points.
export function haversineKm(lat1, lon1, lat2, lon2) {
	const R = 6371;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

// ISO 3166-1 alpha-2 country code -> its 🇽🇾 regional-indicator flag emoji.
// 🌐 for anything that isn't a clean two-letter code.
export function countryCodeToFlag(cc) {
	if (!cc || typeof cc !== "string") return "🌐";

	const code = cc.trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(code)) return "🌐";

	const A = 0x1f1e6;
	const first = code.charCodeAt(0) - 65;
	const second = code.charCodeAt(1) - 65;

	return String.fromCodePoint(A + first, A + second);
}
