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

// encode a lat/lon to a geohash of the given precision (length). Inverse of
// geohashToLatLon; used by !goto to turn a resolved place into channel names.
export function latLonToGeohash(lat, lon, precision = 6) {
	const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
	let idx = 0;
	let bit = 0;
	let even = true;
	let geohash = "";
	let latRange = [-90.0, 90.0];
	let lonRange = [-180.0, 180.0];

	while (geohash.length < precision) {
		if (even) {
			const mid = (lonRange[0] + lonRange[1]) / 2;
			if (lon >= mid) {
				idx = (idx << 1) | 1;
				lonRange[0] = mid;
			} else {
				idx = (idx << 1) | 0;
				lonRange[1] = mid;
			}
		} else {
			const mid = (latRange[0] + latRange[1]) / 2;
			if (lat >= mid) {
				idx = (idx << 1) | 1;
				latRange[0] = mid;
			} else {
				idx = (idx << 1) | 0;
				latRange[1] = mid;
			}
		}
		even = !even;
		if (++bit === 5) {
			geohash += base32[idx];
			bit = 0;
			idx = 0;
		}
	}
	return geohash;
}

// a geohash cell's bounding box (+ center), or null for a non-geohash string.
export function geohashToBBox(geohash) {
	const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
	const bits = [16, 8, 4, 2, 1];
	let evenBit = true;
	let latMin = -90,
		latMax = 90;
	let lonMin = -180,
		lonMax = 180;

	for (const ch of String(geohash || "").toLowerCase()) {
		const cd = base32.indexOf(ch);
		if (cd === -1) return null;
		for (const mask of bits) {
			if (evenBit) {
				const mid = (lonMin + lonMax) / 2;
				if (cd & mask) lonMin = mid;
				else lonMax = mid;
			} else {
				const mid = (latMin + latMax) / 2;
				if (cd & mask) latMin = mid;
				else latMax = mid;
			}
			evenBit = !evenBit;
		}
	}
	return { latMin, latMax, lonMin, lonMax, lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

// great-circle distance in miles (the !goto region-size ladder is quoted in mi).
export function haversineMi(lat1, lon1, lat2, lon2) {
	const R_KM = 6371;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R_KM * c * 0.621371;
}

// the widest span of a geohash cell in miles (max of width/height), or null.
function geohashRegionMaxMi(g) {
	const box = geohashToBBox(g);
	if (!box) return null;
	const midLat = (box.latMin + box.latMax) / 2;
	const midLon = (box.lonMin + box.lonMax) / 2;
	const heightMi = haversineMi(box.latMin, midLon, box.latMax, midLon);
	const widthMi = haversineMi(midLat, box.lonMin, midLat, box.lonMax);
	return Math.max(widthMi, heightMi);
}

// "~4.9 mi" style span label for a geohash cell (ported verbatim, incl. the 666
// dodge), or null for a non-geohash.
export function formatRegionSizeMi(g) {
	const mi = geohashRegionMaxMi(g);
	if (mi == null) return null;
	if (mi >= 100) {
		let rounded = Math.round(mi);
		if (rounded === 666) rounded++;
		return `~${rounded} mi`;
	}
	if (mi >= 1) return `~${mi.toFixed(1)} mi`;
	return `~${mi.toFixed(2)} mi`;
}

// parse a "lat, lon" string into { lat, lon } (validated ranges), else null.
export function parseLatLonInput(text) {
	const m = String(text || "")
		.trim()
		.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
	if (!m) return null;
	const lat = Number(m[1]);
	const lon = Number(m[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
	return { lat, lon };
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
