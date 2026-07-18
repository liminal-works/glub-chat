// Open-Meteo current conditions for a lat/lon, for the /weather and /time self-
// bot commands. Open-Meteo is free, needs no API key, and sends permissive CORS,
// so the browser fetches it directly (no server hop). timezone=auto makes it
// return the location's IANA timezone, which /time uses.

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

// WMO weather interpretation codes -> { text, emoji }. Ranges collapsed to their
// representative code (drizzle/rain/snow intensities read the same to a human).
const WMO = {
	0: { text: "clear", emoji: "☀️" },
	1: { text: "mainly clear", emoji: "🌤️" },
	2: { text: "partly cloudy", emoji: "⛅" },
	3: { text: "overcast", emoji: "☁️" },
	45: { text: "fog", emoji: "🌫️" },
	48: { text: "freezing fog", emoji: "🌫️" },
	51: { text: "light drizzle", emoji: "🌦️" },
	53: { text: "drizzle", emoji: "🌦️" },
	55: { text: "heavy drizzle", emoji: "🌦️" },
	56: { text: "freezing drizzle", emoji: "🌧️" },
	57: { text: "freezing drizzle", emoji: "🌧️" },
	61: { text: "light rain", emoji: "🌧️" },
	63: { text: "rain", emoji: "🌧️" },
	65: { text: "heavy rain", emoji: "🌧️" },
	66: { text: "freezing rain", emoji: "🌧️" },
	67: { text: "freezing rain", emoji: "🌧️" },
	71: { text: "light snow", emoji: "🌨️" },
	73: { text: "snow", emoji: "🌨️" },
	75: { text: "heavy snow", emoji: "❄️" },
	77: { text: "snow grains", emoji: "🌨️" },
	80: { text: "rain showers", emoji: "🌦️" },
	81: { text: "rain showers", emoji: "🌦️" },
	82: { text: "violent showers", emoji: "⛈️" },
	85: { text: "snow showers", emoji: "🌨️" },
	86: { text: "snow showers", emoji: "🌨️" },
	95: { text: "thunderstorm", emoji: "⛈️" },
	96: { text: "thunderstorm w/ hail", emoji: "⛈️" },
	99: { text: "thunderstorm w/ hail", emoji: "⛈️" },
};

export function wmoDescribe(code) {
	return WMO[code] || { text: "unknown", emoji: "🌡️" };
}

// parse "lat, lon" into { lat, lon } (validated ranges), else null.
export function parseLatLon(text) {
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

// forward-geocode a free-text place to { lat, lon, label }, or null if no match.
// Uses Open-Meteo's own geocoding API (free, no key, open CORS).
export async function geocodePlace(query) {
	const q = String(query || "").trim();
	if (!q) return null;
	const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
	const res = await fetch(url, { cache: "no-store" });
	if (!res.ok) throw new Error(`geocode http ${res.status}`);
	const data = await res.json();
	const hit = Array.isArray(data.results) ? data.results[0] : null;
	if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return null;
	const label = [hit.name, hit.country].filter(Boolean).join(", ");
	return { lat: hit.latitude, lon: hit.longitude, label };
}

// { tempC, code, windKmh, timezone } for a location, or throws. tempC/windKmh may
// be undefined if the API omits them; callers guard.
export async function fetchConditions(lat, lon) {
	const url =
		`${ENDPOINT}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
		`&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;
	const res = await fetch(url, { cache: "no-store" });
	if (!res.ok) throw new Error(`weather http ${res.status}`);
	const data = await res.json();
	const c = data.current || {};
	return {
		tempC: c.temperature_2m,
		code: c.weather_code,
		windKmh: c.wind_speed_10m,
		timezone: data.timezone,
	};
}
