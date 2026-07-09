// optional reverse geocoding for geohash channels: turns a channel's center
// coordinates into a place name, precision-scoped to what the geohash actually
// resolves (a 2-char geohash is a whole country; 5+ chars is a town). Like
// avatars/translate this is an assist-only nicety - the client always shows the
// cell coverage on its own and only decorates it with a place name when the api
// answers.
//
// Provider: OpenStreetMap Nominatim (free, no key). We are a polite citizen:
// results are cached forever (a geohash -> place never changes), identical
// concurrent lookups share one request, and outbound calls are spaced >=1s to
// respect the usage policy. Override the endpoint with GEOCODE_API_URL.

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const API_URL = process.env.GEOCODE_API_URL || "https://nominatim.openstreetmap.org/reverse";
// Nominatim asks for an identifying UA; make it overridable for a real deploy.
const USER_AGENT = process.env.GEOCODE_USER_AGENT || "glub-chat/0.1 (+https://github.com/liminal-works/glub-chat)";
const MIN_INTERVAL_MS = 1100; // >= Nominatim's 1 req/s policy
const CACHE_MAX = 5000;

const cache = new Map(); // geohash(lower) -> resolved place | null
const inflight = new Map(); // geohash(lower) -> Promise
let lastCallAt = 0;

// self-contained geohash -> center {lat, lon} (mirrors the client's
// decodeGeohash; kept here so the api needn't import the browser module).
function decodeGeohash(geohash) {
	let evenBit = true;
	let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
	for (const c of geohash.toLowerCase()) {
		const idx = BASE32.indexOf(c);
		if (idx === -1) return null; // not a geohash (e.g. a /join word-channel)
		for (let bit = 4; bit >= 0; bit--) {
			const bitValue = (idx >> bit) & 1;
			if (evenBit) {
				const mid = (lonLo + lonHi) / 2;
				if (bitValue === 1) lonLo = mid; else lonHi = mid;
			} else {
				const mid = (latLo + latHi) / 2;
				if (bitValue === 1) latLo = mid; else latHi = mid;
			}
			evenBit = !evenBit;
		}
	}
	return { lat: (latLo + latHi) / 2, lon: (lonLo + lonHi) / 2 };
}

// precision tier from geohash length: how much of the address is justified.
// <=2 chars ~ country scale, 3-4 ~ region, 5+ ~ city.
function tierFor(len) {
	if (len <= 2) return { zoom: 3, region: false, city: false };
	if (len <= 4) return { zoom: 5, region: true, city: false };
	return { zoom: 10, region: true, city: true };
}

async function nominatimReverse(lat, lon, zoom) {
	// space outbound calls to honor the usage policy
	const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastCallAt = Date.now();

	const url = `${API_URL}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${zoom}&addressdetails=1&accept-language=en`;
	const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
	if (!res.ok) throw new Error(`geocode provider ${res.status}`);
	return res.json();
}

// resolve a geohash to { country, cc, region, city } (only the fields its
// precision justifies), or null if it isn't a place. cached + de-duplicated.
export async function geocode(geohash) {
	const gh = String(geohash || "").toLowerCase();
	if (!gh || gh.length > 12) return null;
	if (cache.has(gh)) return cache.get(gh);
	if (inflight.has(gh)) return inflight.get(gh);

	const center = decodeGeohash(gh);
	if (!center) {
		cache.set(gh, null);
		return null;
	}
	const tier = tierFor(gh.length);

	// inner resolves to { ok, place }: ok=false is a transient failure (not
	// cached, so a later open retries); ok=true with place=null is a confirmed
	// non-place like open ocean (cached, since it won't change).
	const p = (async () => {
		try {
			const data = await nominatimReverse(center.lat, center.lon, tier.zoom);
			const a = (data && data.address) || {};
			const country = a.country || "";
			if (!country) return { ok: true, place: null };
			const place = { country, cc: (a.country_code || "").toUpperCase() };
			if (tier.region) place.region = a.state || a.region || a.province || a.state_district || "";
			if (tier.city) place.city = a.city || a.town || a.village || a.municipality || a.county || "";
			return { ok: true, place };
		} catch {
			return { ok: false, place: null };
		}
	})();
	inflight.set(gh, p);

	const { ok, place } = await p;
	inflight.delete(gh);
	if (ok) {
		if (cache.size > CACHE_MAX) cache.clear();
		cache.set(gh, place);
	}
	return place;
}
