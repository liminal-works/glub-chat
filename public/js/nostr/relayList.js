const DEFAULT_RELAY_CSV_URL =
	"https://raw.githubusercontent.com/permissionlesstech/bitchat/main/relays/online_relays_gps.csv";

function normalizeRelayUrl(raw) {
	const r = raw.trim();
	if (!r) return "";
	if (r.startsWith("wss://") || r.startsWith("ws://")) return r;
	return "wss://" + r;
}

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

		const relayUrl = normalizeRelayUrl(line.split(",")[0] || "");
		if (!relayUrl || seen.has(relayUrl)) continue;

		seen.add(relayUrl);
		relays.push(relayUrl);
	}

	return relays;
}
