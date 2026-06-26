const DEFAULT_RELAY_CSV_URL =
	"https://raw.githubusercontent.com/permissionlesstech/bitchat/main/relays/online_relays_gps.csv";

function normalizeRelayUrl(raw) {
	const r = raw.trim();
	if (!r) return "";
	if (r.startsWith("wss://") || r.startsWith("ws://")) return r;
	return "wss://" + r;
}

// returns [{ url, lat, lon }], deduped by url
export async function fetchRelayList(url = DEFAULT_RELAY_CSV_URL) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`relay list fetch failed: HTTP ${res.status}`);

	const text = await res.text();
	const lines = text.split(/\r?\n/);
	const seen = new Set();
	const relays = [];

	// skip header row
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;

		const [rawUrl, rawLat, rawLon] = line.split(",");
		const url = normalizeRelayUrl(rawUrl || "");
		if (!url || seen.has(url)) continue;

		const lat = Number(rawLat);
		const lon = Number(rawLon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

		seen.add(url);
		relays.push({ url, lat, lon });
	}

	return relays;
}
