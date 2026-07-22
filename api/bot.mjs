// The global bot: a server-side participant that watches every geohash channel
// through the aggregator's firehose and answers `!commands` by posting an
// ordinary signed chat message back into the channel. Native bitchat clients
// (which have no global view) get commands like `!top` that surface glub's
// server-side index of the whole network.
//
// This is a faithful port of the old standalone glub bot: the same command set,
// aliases, scoring, language detection (franc) and reply text. What's new is
// *where it lives* - instead of holding its own relay sockets it rides the
// aggregator: observe() is fed each live chat event, and replies fan out through
// the aggregator's existing connections. !top is the first command; the plumbing
// (observe/parse/alias/cooldown/dispatch/reply) is shared so !listen etc. slot in
// beside it.

import crypto from "node:crypto";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { franc } from "franc";
import { CHAT_KIND, getName, getGeohash } from "./nostr.mjs";
import { geohashToLatLon, countryCodeToFlag, latLonToGeohash, formatRegionSizeMi, parseLatLonInput } from "./geo.mjs";
import { queryNostr, extractImageUrlsFromEvent, normalizeNostrTag } from "./nostrQuery.mjs";

const now = () => Math.floor(Date.now() / 1000);

// long messages are clipped with a char count, so a !listen line can't blow out
// the reply (ported verbatim).
function clipText(s, max = 200) {
	const str = String(s ?? "");
	if (str.length <= max) return str;
	return str.slice(0, max) + `... (${str.length} chars)`;
}

// compact "23s / 4m / 2h / 3d" elapsed label (ported verbatim).
function timeAgo(nowSec, thenSec) {
	const d = Math.max(0, nowSec - thenSec);
	if (d < 60) return `${d}s`;
	const m = Math.floor(d / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

// !seen matches on the bare name: drop a leading "@" and a trailing "#abcd" key
// suffix, lower-cased, so "@6ix#dead" and "6ix" resolve to the same person.
function normalizeSeenName(name) {
	const s = String(name || "").trim();
	if (!s) return "";
	return s.replace(/^@/, "").replace(/#([0-9a-f]{4})$/i, "").toLowerCase();
}

// accept an npub, a 64-hex pubkey, or a "pubkey:" prefix; return the hex key or "".
function toHexPubkey(s) {
	const raw = String(s || "").trim().replace(/^pubkey:/i, "");
	if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
	if (/^npub1[0-9a-z]+$/i.test(raw)) {
		try {
			const { type, data } = nip19.decode(raw);
			if (type === "npub" && typeof data === "string") return data;
		} catch {}
	}
	return "";
}

// hex pubkey -> shareable npub (falls back to the hex if encoding somehow fails).
function toNpub(hex) {
	try {
		return nip19.npubEncode(hex);
	} catch {
		return hex;
	}
}

// ---- tunables (ported verbatim from the old bot) --------------------------
const ACTIVE_WINDOW_SEC = 60; // a pubkey counts as "active" if seen within this
const ACTIVITY_WINDOW_SEC = 60; // !top scores messages seen in the last minute (mpm)
const LANG_MIN_CHARS = 160; // don't detect a channel's language below this much text
const LANG_MAX_CHARS = 800; // keep only the most recent ~800 chars per channel
const LANG_RECHECK_EVERY = 6; // re-run franc every N messages
const LISTEN_BUFFER_SIZE = 800; // cross-channel recent-message ring for !listen
const RECENT_BY_LANGUAGE_MAX = 10; // recent messages kept per detected language
const LISTEN_SHOW = 10; // how many messages a !listen reply dumps (tight one-line items)
const LISTEN_FRESH_SEC = 60 * 60; // bare !listen only shows chatter this fresh - it's a "who's talking now" firehose, not a backlog
const SEEN_MAX_PER_NAME = 5; // channels remembered per name for !seen
const SEEN_TTL_SEC = 24 * 60 * 60; // forget a name's sightings after ~24h
const NOTES_PAGE_SIZE = 10; // notes shown per !notes page (tight one-line items)
const NOTES_FETCH_CAP = 100; // most notes we page through for a channel
const NOTES_SNAPSHOT_TTL_MS = 60_000; // reuse a channel's note snapshot while paging
const NOTE_CLIP = 100; // per-note content clip in a !notes list (inline, so kept short)
const NOSTR_WANT = 12; // candidate image notes to gather before picking one
const NOSTR_TIMEOUT_MS = 6000; // give up a !nostr relay query after this
const NOSTR_SCAN_LIMIT = 300; // kind-1 events a !nostr filter samples per relay
const NOSTR_SEEN_MAX = 5000; // event ids remembered so !nostr doesn't repeat
const COMMAND_COOLDOWN_WINDOW_MS = 60_000; // global command budget window
const COMMAND_COOLDOWN_MAX = 12; // ...and how many commands fit in it
const GEO_CACHE_MAX = 5000; // reverse-geocode cache bound
const PLACE_CACHE_MAX = 2000; // forward place-lookup (!goto) cache bound
const GEOCODE_TIMEOUT_MS = 2500; // per reverse-geocode; a flag must never stall a reply
const NOMINATIM_UA = "glub.chat-bot (https://glub.chat)";

// the bot honors the same visibility rules a client does: a message no client
// would render must not be able to drive the bot either.
const MAX_FUTURE_SEC = 120; // drop events timestamped this far ahead (forged/skewed clock), matching the client
// live chat reads as "~now"; a backdated event is a replay clients won't surface
// as a live message (native hides ephemeral chat outside a recency window). 5min
// default is generous enough for clock skew + relay latency, env-tunable tighter.
const MAX_PAST_SEC = Number(process.env.GLUB_BOT_MAX_PAST_SEC) || 300;
// PoW is OFF by default: ios bitchat attaches no nonce tag at all (only android's
// *inbound* filter drops no-nonce events, and even that's opt-in), so requiring
// one here drops heaps of legit traffic. leave this off unless you've confirmed
// your abuser mines and your audience does too; set GLUB_BOT_REQUIRE_POW=1.
const BOT_REQUIRE_POW = process.env.GLUB_BOT_REQUIRE_POW === "1";
const BOT_MIN_POW = Number(process.env.GLUB_BOT_MIN_POW) || 0; // extra floor on the committed difficulty when PoW is required

// --- NIP-13 proof-of-work (ported from the client's pow.js) ------------------
// leading-zero *bits* of a hex event id.
function idDifficulty(idHex) {
	let bits = 0;
	for (const c of String(idHex || "")) {
		const nibble = parseInt(c, 16);
		if (Number.isNaN(nibble)) break;
		if (nibble === 0) {
			bits += 4;
			continue;
		}
		bits += nibble < 2 ? 3 : nibble < 4 ? 2 : nibble < 8 ? 1 : 0;
		break;
	}
	return bits;
}
// the difficulty an event's nonce tag COMMITS to (3rd element), or 0 if absent.
function committedDifficulty(ev) {
	const tag = (Array.isArray(ev.tags) ? ev.tags : []).find((t) => Array.isArray(t) && t[0] === "nonce");
	if (!tag) return 0;
	const n = parseInt(tag[2], 10);
	return Number.isFinite(n) ? n : 0;
}

// would a client actually render this event? forged-future timestamps are out,
// and (like a default native client) a message must carry a real, self-consistent
// proof-of-work nonce. returns { ok } or { ok:false, reason } for logging.
function isRenderable(ev, nowSec) {
	if (ev.created_at > nowSec + MAX_FUTURE_SEC) return { ok: false, reason: `future-timestamp(+${ev.created_at - nowSec}s)` };
	if (ev.created_at < nowSec - MAX_PAST_SEC) return { ok: false, reason: `stale-timestamp(-${nowSec - ev.created_at}s)` };
	if (BOT_REQUIRE_POW) {
		const committed = committedDifficulty(ev);
		if (committed === 0) return { ok: false, reason: "no-pow-nonce" };
		if (idDifficulty(ev.id) < committed) return { ok: false, reason: "pow-mismatch" };
		if (committed < BOT_MIN_POW) return { ok: false, reason: `pow-below-min(${committed}<${BOT_MIN_POW})` };
	}
	return { ok: true };
}

// createBot({ broadcast, botName })
//   broadcast(signedEvent, geohash)  fan the reply out (the aggregator supplies it)
//   botName                          the `n` tag / display handle (default "glub.bot")
export function createBot({ broadcast, store, botName = process.env.GLUB_BOT_NAME || "glub.bot" } = {}) {
	// --- identity ------------------------------------------------------------
	// bitchat-style disposable burner keys: the bot mints a fresh keypair on boot
	// and rotates it every GLUB_BOT_ROTATE_MIN minutes (default 45; 0 disables).
	// GLUB_BOT_SK (64-hex), if set, seeds the FIRST key - handy for a known
	// starting npub or tests - but rotation still applies unless it's disabled.
	// Because replies signed with a just-retired key can still echo back from
	// relays, we skip ANY of our recent keys (botPubkeys), not just the current one.
	const ROTATE_MIN = Number(process.env.GLUB_BOT_ROTATE_MIN ?? 45);
	const BOT_PUBKEYS_MAX = 12; // recent keys remembered so our own echoes are ignored
	const botPubkeys = new Set();
	let sk;
	let pk;

	function adoptKey(skBytes) {
		sk = skBytes;
		pk = getPublicKey(sk);
		botPubkeys.add(pk);
		while (botPubkeys.size > BOT_PUBKEYS_MAX) botPubkeys.delete(botPubkeys.values().next().value);
	}
	const randomKey = () => Uint8Array.from(crypto.randomBytes(32));

	const seedHex = (process.env.GLUB_BOT_SK || "").trim().toLowerCase();
	adoptKey(/^[0-9a-f]{64}$/.test(seedHex) ? Uint8Array.from(Buffer.from(seedHex, "hex")) : randomKey());
	console.log(
		`[bot] identity ${pk.slice(0, 8)}…${pk.slice(-4)} name=${botName}` +
			(ROTATE_MIN > 0 ? ` (rotating every ${ROTATE_MIN}m)` : " (rotation off)"),
	);

	if (ROTATE_MIN > 0) {
		setInterval(() => {
			adoptKey(randomKey());
			console.log(`[bot] rotated identity -> ${pk.slice(0, 8)}…${pk.slice(-4)}`);
		}, ROTATE_MIN * 60_000).unref();
	}

	// --- rolling state -------------------------------------------------------
	const channelActivity = new Map(); // geohash -> [created_at secs] (rolling 60s window) → !top score
	const activePubkeys = new Map(); // pubkey -> lastSeen secs → active-user count
	const langBlob = new Map(); // geohash -> { blob, n } accumulating text for detection
	const channelLanguage = new Map(); // geohash -> { lang, updated } (ISO 639-3, e.g. "eng")
	const geoNameCache = new Map(); // geohash -> { country_code, geocodable } (reverse-geocode cache)
	const placeCache = new Map(); // normalized query -> Promise<{ lat, lon, label } | null> (forward-geocode cache for !goto)
	const commandHits = []; // ms timestamps of recently-served commands (global cooldown)
	const recentOther = []; // cross-channel recent messages, newest last → !listen
	const recentByLanguage = new Map(); // ISO-639-3 lang -> [{ g, user, msg, t }] → !listen <lang>
	const seenByName = new Map(); // normalized name -> [{ g, t }] (oldest first) → !seen
	const notesSnapshots = new Map(); // channel -> { at, notes } cached page source for !notes
	const nostrSeen = new Set(); // event ids already surfaced by !nostr (so it rotates)

	// --- activity + language bookkeeping ------------------------------------
	function recordChannelActivity(geohash, tsSec) {
		if (!geohash) return;
		const t = typeof tsSec === "number" && tsSec > 0 ? tsSec : now();
		let arr = channelActivity.get(geohash);
		if (!arr) channelActivity.set(geohash, (arr = []));
		arr.push(t);
		const cutoff = t - ACTIVITY_WINDOW_SEC;
		while (arr.length && arr[0] < cutoff) arr.shift();
	}

	function noteActivePubkey(pubkey, tsSec) {
		if (!pubkey) return;
		activePubkeys.set(pubkey, typeof tsSec === "number" ? tsSec : now());
	}

	function activeUserCount() {
		const cutoff = now() - ACTIVE_WINDOW_SEC;
		for (const [pkey, t] of activePubkeys) if (t < cutoff) activePubkeys.delete(pkey);
		return activePubkeys.size;
	}

	// remember a name's last channels for !seen: newest-last, consecutive repeats in
	// the same channel just refresh the time, capped per name and aged out at TTL.
	function noteSeen(name, g, tsSec) {
		const n = normalizeSeenName(name);
		if (!n || !g) return;
		const t = typeof tsSec === "number" ? tsSec : now();
		const cutoff = now() - SEEN_TTL_SEC;

		let arr = seenByName.get(n);
		if (!arr) seenByName.set(n, (arr = []));
		while (arr.length && arr[0].t < cutoff) arr.shift();

		const last = arr[arr.length - 1];
		if (last && last.g === g) {
			last.t = t; // still here - just bump the timestamp
			return;
		}
		arr.push({ g, t });
		while (arr.length > SEEN_MAX_PER_NAME) arr.shift();
	}

	// accumulate a channel's chat text and periodically re-detect its dominant
	// language with franc; the result is what !top prints beside the flag.
	function updateChannelLanguage(g, text) {
		const clean = String(text || "").trim();
		if (!clean) return;

		let st = langBlob.get(g);
		if (!st) langBlob.set(g, (st = { blob: "", n: 0 }));

		st.blob += (st.blob ? " " : "") + clean;
		st.n++;
		if (st.blob.length > LANG_MAX_CHARS) st.blob = st.blob.slice(st.blob.length - LANG_MAX_CHARS);

		if (st.n % LANG_RECHECK_EVERY !== 0) return;
		if (st.blob.length < LANG_MIN_CHARS) return;

		const lang = franc(st.blob, { minLength: 10 });
		if (!lang || lang === "und") return;
		channelLanguage.set(g, { lang, updated: Date.now() });
	}

	// !top ranking: channels by messages in the last 60s (messages-per-minute).
	function topActiveChannels(limit = 5) {
		const out = [];
		const t = now();
		const cutoff = t - ACTIVITY_WINDOW_SEC;
		for (const [g, arr] of channelActivity.entries()) {
			if (!arr || arr.length === 0) continue;
			while (arr.length && arr[0] < cutoff) arr.shift();
			if (arr.length > 0) out.push({ g, mpm: arr.length, count: arr.length });
		}
		out.sort((a, b) => b.mpm - a.mpm);
		return out.slice(0, limit);
	}

	// --- !listen buffers + formatters (ported verbatim) ----------------------
	// a readable display name for a message author: the `n` tag, else a short key.
	function nameOf(ev) {
		return String(getName(ev) || "").trim() || "anon" + String(ev.pubkey || "").slice(0, 4);
	}

	// cross-channel recent-message ring (newest last), bounded.
	function pushRecent(ev, geohash, content) {
		if (!geohash || !content) return;
		recentOther.push({ g: geohash, t: typeof ev.created_at === "number" ? ev.created_at : now(), name: nameOf(ev), content });
		if (recentOther.length > LISTEN_BUFFER_SIZE) recentOther.splice(0, recentOther.length - LISTEN_BUFFER_SIZE);
	}

	// per-language recent buffer, so !listen <lang> can show what a language sounds
	// like right now. detection is per-message here (not the channel blob).
	function rememberMessageLanguage(g, user, text, createdAt) {
		const clean = String(text || "").trim();
		if (clean.length < 10) return;
		const lang = franc(clean, { minLength: 10 });
		if (!lang || lang === "und") return;
		let arr = recentByLanguage.get(lang);
		if (!arr) recentByLanguage.set(lang, (arr = []));
		arr.push({ g, user, msg: clean, t: createdAt || now() });
		if (arr.length > RECENT_BY_LANGUAGE_MAX) arr.shift();
	}

	// shared !listen renderer: a header, then one tight line per message in the raw
	// firehose shape `#geo <name> message  Nm ago`, or a quiet empty note.
	function listenBlock(header, items, empty) {
		if (!items.length) return `${header}\n\n${empty}`;
		const nowSec = now();
		const body = items
			.map((m) => `#${m.g} <${m.name}> ${clipText(String(m.content || "").replace(/\s+/g, " ").trim(), 100)} ${timeAgo(nowSec, m.t)} ago`)
			.join("\n");
		return `${header}\n\n${body}`;
	}

	// !listen (no arg): recent messages from channels OTHER than the caller's. the
	// point is to catch a live convo you might chime in on, so anything older than
	// LISTEN_FRESH_SEC is dropped rather than backfilling the list with stale chatter
	// when the network is quiet.
	function buildListenOutput(currentG, n) {
		const cutoff = now() - LISTEN_FRESH_SEC;
		const picked = [];
		for (let i = recentOther.length - 1; i >= 0 && picked.length < n; i--) {
			const m = recentOther[i];
			if (!m || !m.g || !m.t || m.t < cutoff || m.g === currentG) continue;
			picked.push(m);
		}
		picked.reverse(); // oldest -> newest for readability
		return listenBlock("recent messages:", picked, "nothing else active right now");
	}

	// !listen <#geohash>: recent messages from one specific channel.
	function buildListenOutputForChannel(targetG, n) {
		const picked = [];
		for (let i = recentOther.length - 1; i >= 0 && picked.length < n; i--) {
			const m = recentOther[i];
			if (!m || !m.g || m.g !== targetG) continue;
			picked.push(m);
		}
		picked.reverse();
		return listenBlock(`recent in #${targetG}:`, picked, "nothing here yet");
	}

	// !listen <lang>: recent messages detected in an ISO-639-3 language (eng/rus/…).
	function buildListenOutputForLanguage(code, n) {
		const recent = recentByLanguage.get(String(code || "").trim().toLowerCase()) || [];
		const picked = [...recent].slice(-n).reverse();
		// this buffer stores {user,msg}; normalize to the {name,content} listenBlock wants
		const items = picked.map((m) => ({ g: m.g, name: m.user, content: m.msg, t: m.t }));
		return listenBlock(`recent in ${code}:`, items, "nothing detected yet");
	}

	// --- reverse-geocoded flags (Nominatim, cached) -------------------------
	async function geocodeGeohash(g) {
		if (geoNameCache.has(g)) return geoNameCache.get(g);

		const coords = geohashToLatLon(g);
		if (!coords) {
			const result = { country_code: null, geocodable: false };
			cacheGeo(g, result);
			return result;
		}

		let countryCode = null;
		let label = null;
		try {
			const url =
				`https://nominatim.openstreetmap.org/reverse?format=json` +
				`&lat=${coords.lat}&lon=${coords.lon}&zoom=10&addressdetails=1&accept-language=en`;
			// hard timeout: this enrichment (flag for !top, label for !goto) must NEVER
			// stall a reply. A host that can't reach nominatim (or a slow/rate-limited
			// response) would otherwise leave the awaiting command hanging forever.
			const res = await fetch(url, {
				headers: { "User-Agent": NOMINATIM_UA, "Accept-Language": "en" },
				signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
			});
			if (res.ok) {
				const json = await res.json().catch(() => null);
				if (json?.address) {
					countryCode = String(json.address.country_code || "").toLowerCase() || null;
					label = formatGeoLabel(g, json.address);
				}
			}
		} catch {
			// timeout / network hiccup: geocodable-but-unknown (🌐); don't cache a hard miss
			return { country_code: null, label: null, lat: coords.lat, lon: coords.lon, geocodable: true };
		}

		const result = { country_code: countryCode, label, lat: coords.lat, lon: coords.lon, geocodable: true };
		cacheGeo(g, result);
		return result;
	}

	// build a human place label from a Nominatim address, scaled to the geohash's
	// precision (broad channels name a country, local ones a city). Ported verbatim.
	function formatGeoLabel(g, addr) {
		const len = g.length;
		const country = addr.country || null;
		const state = addr.state || addr.region || addr.state_district || addr.province || null;
		const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || null;

		const withCountry = (place) => {
			if (!place) return country || null;
			if (!country) return place;
			if (String(place).toLowerCase() === String(country).toLowerCase()) return country;
			return `${place}, ${country}`;
		};

		if (len <= 2) return country;
		if (len === 3) return withCountry(state);
		if (len <= 5) {
			if (city && state) return withCountry(`${city}, ${state}`);
			if (city) return withCountry(city);
			if (state) return withCountry(state);
			return country;
		}
		if (city) return withCountry(city);
		if (state) return withCountry(state);
		return country;
	}

	// forward geocode a free-text place query to { lat, lon, label } (or null),
	// cached by normalized query so the same place never hits nominatim twice - a
	// place's coordinates don't change, and !goto <place> is the kind of thing that
	// gets repeated. the Promise itself is cached, so simultaneous lookups of the
	// same place share one request. a resolved value (hit or genuine no-match) stays
	// cached; a thrown request (down/rate-limited/timeout) is evicted so it retries.
	function geocodePlaceQuery(query) {
		const q = String(query || "").trim();
		if (!q) return Promise.resolve(null);
		const key = q.toLowerCase().replace(/\s+/g, " ");
		const cached = placeCache.get(key);
		if (cached) return cached;

		const p = (async () => {
			const url =
				`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
				`&format=jsonv2&limit=1&addressdetails=1&accept-language=en`;
			const res = await fetch(url, {
				headers: { "User-Agent": NOMINATIM_UA, "Accept-Language": "en" },
				signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`geocode failed (${res.status})`);
			const json = await res.json().catch(() => null);
			const hit = Array.isArray(json) ? json[0] : null;
			if (!hit) return null;
			const lat = Number(hit.lat);
			const lon = Number(hit.lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
			return { lat, lon, label: String(hit.display_name || q).trim() };
		})();

		p.catch(() => placeCache.delete(key)); // don't cache transient failures
		if (placeCache.size >= PLACE_CACHE_MAX) placeCache.clear();
		placeCache.set(key, p);
		return p;
	}

	// !goto's resolver: a "lat, lon" pair, else a place-name lookup.
	async function resolveGotoTarget(input) {
		const raw = String(input || "").trim();
		if (!raw) return null;
		const coords = parseLatLonInput(raw);
		if (coords) return { lat: coords.lat, lon: coords.lon, label: `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}` };
		return await geocodePlaceQuery(raw);
	}

	function cacheGeo(g, result) {
		if (geoNameCache.size >= GEO_CACHE_MAX) geoNameCache.clear();
		geoNameCache.set(g, result);
	}

	async function getGeohashFlag(g) {
		const geo = await geocodeGeohash(g);
		if (!geo?.geocodable) return "🌀"; // word-channel / non-geohash
		return countryCodeToFlag(geo?.country_code);
	}

	// --- outgoing ------------------------------------------------------------
	function makeBotChatMessage(content, geohash) {
		return finalizeEvent(
			{
				kind: CHAT_KIND,
				created_at: now(),
				tags: [
					["g", geohash],
					["n", botName],
					["client", "glub.chat"],
				],
				content,
				pubkey: pk,
			},
			sk,
		);
	}

	function reply(content, geohash) {
		if (!content || !geohash) return;
		const ev = makeBotChatMessage(content, geohash);
		const sent = broadcast?.(ev, geohash);
		console.log(`[bot] reply -> #${geohash} (${sent ?? 0} relays)`);
	}

	// --- commands ------------------------------------------------------------
	// !top: the most active channels, messages-per-minute over the last 60s. The
	// layout is the original bot's: a numbered list, geohashes padded into a
	// column, each with its mpm + the derived "one message every Ns" and a
	// detected-language flag, then a unique-active-users tally.
	async function cmdTop(geo) {
		const top = topActiveChannels(5);

		if (top.length === 0) {
			reply("top channels: (no activity yet)", geo);
			return;
		}

		const maxG = Math.max(...top.map((x) => x.g.length)); // pad geohashes so the columns line up
		const flags = await Promise.all(top.map((x) => getGeohashFlag(x.g)));

		const lines = top.map((x, i) => {
			const gPadded = x.g.padEnd(maxG, " ");
			const mpm = x.count.toFixed(1);
			const secs = (60 / x.count).toFixed(2); // avg gap: one message every N seconds
			const langCode = channelLanguage.get(x.g)?.lang;
			const langPart = langCode ? ` ${langCode} ${flags[i] || "🌐"}` : "";
			return `${i + 1}. #${gPadded} — ${mpm}/mpm (${secs}s)${langPart}`;
		});

		reply(`top channels:\n\n${lines.join("\n")}\n\nactive users: ${activeUserCount()}`, geo);
	}

	// !listen: recent chat. bare = other channels; <lang> = a detected language;
	// otherwise treat the arg as a #geohash. (a leading # is optional.)
	function cmdListen(geo, args) {
		const target = args.length >= 1 ? String(args[0] || "").trim().toLowerCase().replace(/^#/, "") : "";
		let msg;
		if (!target) msg = buildListenOutput(geo, LISTEN_SHOW);
		else if (recentByLanguage.has(target)) msg = buildListenOutputForLanguage(target, LISTEN_SHOW);
		else msg = buildListenOutputForChannel(target, LISTEN_SHOW);
		reply(msg, geo);
	}

	// !goto: with an arg, resolve a place-name or "lat,lon" to a ladder of geohash
	// channels at each precision. With NO arg, describe the CURRENT channel's real-
	// world location instead. Faithful to the old ladder format.
	async function cmdGoto(geo, args) {
		const raw = String(args.join(" ") || "").trim();

		// no arg: reverse-lookup where this channel actually is on the map.
		if (!raw) {
			const coords = geohashToLatLon(geo);
			if (!coords) {
				reply(`#${geo} is not a map location`, geo);
				return;
			}
			const info = await geocodeGeohash(geo);
			const label = (info?.label || "unknown area").toLowerCase();
			const flag = countryCodeToFlag(info?.country_code);
			const span = formatRegionSizeMi(geo);
			reply(
				`#${geo}:\n\n` +
					`${label} ${flag}\n` +
					`${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}` +
					(span ? ` · ${span}` : ""),
				geo,
			);
			return;
		}

		let target;
		try {
			target = await resolveGotoTarget(raw);
		} catch (err) {
			console.error("[bot] !goto failed:", err?.message || err);
			reply("could not reach the map right now", geo);
			return;
		}
		if (!target) {
			reply("no match for that place", geo);
			return;
		}

		const ladder = [
			[2, "broad"],
			[3, "region"],
			[4, "city"],
			[5, "district"],
			[6, "local"],
		]
			.map(([p, label]) => {
				const gh = latLonToGeohash(target.lat, target.lon, p);
				const size = formatRegionSizeMi(gh);
				return `- #${gh} · ${label}${size ? ` · ${size}` : ""}`;
			})
			.join("\n");

		reply(`${target.label.toLowerCase()}:\n${target.lat.toFixed(4)}, ${target.lon.toFixed(4)}\n\n${ladder}`, geo);
	}

	// !seen <name>: the channels a name was last active in (newest first), matched
	// on the bare name so "@6ix#dead" and "6ix" both work.
	function cmdSeen(geo, args) {
		const targetRaw = args.join(" ").trim();
		if (!targetRaw) {
			reply("usage:\n\n!seen <name>", geo);
			return;
		}
		const hits = seenByName.get(normalizeSeenName(targetRaw)) || [];
		if (!hits.length) {
			reply(`${targetRaw}:\n\nnot seen recently`, geo);
			return;
		}
		const nowSec = now();
		const items = [...hits].reverse().slice(0, SEEN_MAX_PER_NAME); // newest first
		reply(`${targetRaw}:\n\n` + items.map((x) => `#${x.g} ${timeAgo(nowSec, x.t)} ago`).join("\n"), geo);
	}

	// !notes: the location notes on a channel, from our note cache (works for any
	// channel string, geocodable or not, and includes notes nested beneath it).
	// Paginated so a busy channel doesn't dump 100 notes at once.
	// forms: !notes | !notes <page> | !notes <channel> | !notes <channel> <page>
	function cmdNotes(geo, args) {
		let channel = String(geo || "").trim().toLowerCase();
		let page = 1;
		const a0 = String(args[0] || "").trim().toLowerCase();
		const a1 = String(args[1] || "").trim();
		if (a0) {
			if (/^\d+$/.test(a0)) {
				page = Number(a0);
			} else {
				channel = a0.replace(/^#/, "");
				if (a1) {
					if (!/^\d+$/.test(a1)) {
						reply("usage:\n\n!notes\n!notes <page>\n!notes <#channel> [page]", geo);
						return;
					}
					page = Number(a1);
				}
			}
		}
		if (!channel) {
			reply("give a channel", geo);
			return;
		}

		const notes = notesSnapshot(channel);
		if (!notes.length) {
			reply(`notes in #${channel}:\n\nnone yet`, geo);
			return;
		}

		const totalPages = Math.max(1, Math.ceil(notes.length / NOTES_PAGE_SIZE));
		const p = Math.min(Math.max(1, page), totalPages);
		const start = (p - 1) * NOTES_PAGE_SIZE;
		const slice = notes.slice(start, start + NOTES_PAGE_SIZE);
		const nowSec = now();

		// same firehose line shape as !listen: #geo <name> body  Nm ago
		const items = slice
			.map((ev) => {
				const noteG = getGeohash(ev) || channel;
				const nm = String(getName(ev) || "").trim() || "anon";
				const body = clipText(String(ev.content || "").replace(/\s+/g, " ").trim(), NOTE_CLIP);
				return `#${noteG} <${nm}> ${body} ${timeAgo(nowSec, ev.created_at)} ago`;
			})
			.join("\n");

		// !top-style footer stat: the total, plus the next-page hint when there's more
		const chanArg = channel === String(geo || "").trim().toLowerCase() ? "" : `${channel} `;
		const more = p < totalPages ? ` · page ${p}/${totalPages} · !notes ${chanArg}${p + 1} for more` : "";
		reply(`notes in #${channel}:\n\n${items}\n\n${notes.length} total${more}`, geo);
	}

	// cached page source: query the note store once per channel and reuse it while
	// paging (a fresh query per page could reorder under new arrivals).
	function notesSnapshot(channel) {
		const hit = notesSnapshots.get(channel);
		if (hit && Date.now() - hit.at < NOTES_SNAPSHOT_TTL_MS) return hit.notes;
		const notes = store?.notesByPrefix ? store.notesByPrefix(channel, NOTES_FETCH_CAP) : [];
		notesSnapshots.set(channel, { at: Date.now(), notes });
		return notes;
	}

	// !nostr: reach into the wider nostr firehose (not just geohash notes). no arg =
	// any note with an image; <text> = content contains text (+ image); #<tag> =
	// tagged (+ image); <npub|hex> = that author's recent posts (image optional, so
	// you can browse someone's feed). Each surfaced note is remembered so re-running
	// rotates to a new one; the reply always shows the poster's full npub.
	async function cmdNostr(geo, args) {
		const raw = args.join(" ").trim();
		const filter = { kinds: [1], limit: NOSTR_SCAN_LIMIT };
		let tag = "";
		let contentMatch = "";
		let author = "";

		if (raw.startsWith("#")) {
			tag = normalizeNostrTag(raw);
			if (tag) filter["#t"] = [tag];
		} else if (raw) {
			const hex = toHexPubkey(raw);
			if (hex) {
				author = hex;
				filter.authors = [hex];
			} else {
				contentMatch = raw.toLowerCase();
			}
		}

		// browsing a person's feed shows any post; image hunts require an image.
		const requireImage = !author;

		const events = await queryNostr(filter, {
			timeoutMs: NOSTR_TIMEOUT_MS,
			want: NOSTR_WANT,
			accept: (ev) => {
				if (nostrSeen.has(ev.id)) return false;
				if (contentMatch && !String(ev.content || "").toLowerCase().includes(contentMatch)) return false;
				if (requireImage && extractImageUrlsFromEvent(ev).length === 0) return false;
				return true;
			},
		});

		events.sort((a, b) => b.created_at - a.created_at); // newest first
		const pick = events[0];
		if (!pick) {
			const f = tag ? ` for #${tag}` : author ? ` for ${toNpub(author).slice(0, 12)}…` : contentMatch ? ` for "${raw}"` : "";
			reply(`nostr:\n\nno new notes${f}`, geo);
			return;
		}
		nostrSeen.add(pick.id);
		if (nostrSeen.size > NOSTR_SEEN_MAX) nostrSeen.clear();

		const url = extractImageUrlsFromEvent(pick)[0] || "";
		const meta = `${timeAgo(now(), pick.created_at)} ago` + (tag ? ` · #${tag}` : contentMatch ? ` · "${raw}"` : "");
		const body = clipText(String(pick.content || "").replace(/\s+/g, " ").trim(), 200);

		const lines = [`nostr:`, "", toNpub(pick.pubkey)];
		if (body) lines.push("", body);
		if (url) lines.push(url);
		lines.push("", meta);
		reply(lines.join("\n"), geo);
	}

	// !help: generated from the registry, so a new command shows up here for free.
	// Kept SHORT (terse one-liners) so it doesn't wrap on mobile; the per-command
	// !help <command> page carries the usage + optional params.
	function cmdHelp(geo, arg) {
		const q = String(arg || "").trim().toLowerCase().replace(/^!/, "");
		if (q) {
			const c = byToken.get(q);
			if (c) {
				const alias = c.aliases?.length ? `\n\nalias: ${c.aliases.map((a) => "!" + a).join(" · ")}` : "";
				reply(`!${c.name}:\n\n${c.usage || c.desc}${alias}`, geo);
				return;
			}
		}
		const lines = [...COMMANDS].sort((a, b) => a.name.localeCompare(b.name)).map((c) => `- !${c.name} · ${c.desc}`);
		reply(`commands:\n\n${lines.join("\n")}\n\n!help <command> for more`, geo);
	}

	// the command registry: adding an entry here makes a command parse, dispatch,
	// AND appear in !help automatically - there's no static list to keep in sync.
	// aliases are the bang-stripped forms users learned (!t, !l, !list, !dump…).
	const COMMANDS = [
		{ name: "top", aliases: ["t"], desc: "most active chats", usage: "!top", run: (c) => cmdTop(c.geo) },
		{
			name: "listen",
			aliases: ["l", "list", "dump"],
			desc: "show recent messages",
			usage: "!listen · !listen <lang> · !listen <#geohash>",
			run: (c) => cmdListen(c.geo, c.args),
		},
		{
			name: "goto",
			desc: "locate a place or channel",
			usage: "!goto <place|lat,lon> · !goto (here)",
			run: (c) => cmdGoto(c.geo, c.args),
		},
		{ name: "seen", desc: "a user's recent activity", usage: "!seen <name>", run: (c) => cmdSeen(c.geo, c.args) },
		{
			name: "notes",
			desc: "notes on this or any channel",
			usage: "!notes · !notes <page> · !notes <#channel> [page]",
			run: (c) => cmdNotes(c.geo, c.args),
		},
		{
			name: "nostr",
			desc: "pull a note from nostr",
			usage: "!nostr · !nostr <text> · !nostr #<tag> · !nostr <npub>",
			run: (c) => cmdNostr(c.geo, c.args),
		},
		{ name: "help", aliases: ["h", "commands"], desc: "list commands", usage: "!help · !help <command>", run: (c) => cmdHelp(c.geo, c.args[0]) },
	];

	// name/alias -> command, built once from the registry above.
	const byToken = new Map();
	for (const c of COMMANDS) {
		byToken.set(c.name, c);
		for (const a of c.aliases || []) byToken.set(a, c);
	}

	// content -> { command, name, args } for a `!command` (command null if the token
	// isn't one of ours), or null when it isn't a command at all.
	function parseCommand(raw) {
		const original = String(raw ?? "").trim();
		if (!original.toLowerCase().startsWith("!")) return null;
		const parts = original.split(/\s+/);
		const token = parts[0].slice(1).toLowerCase(); // "!ToP" -> "top"
		return { command: byToken.get(token) || null, name: token, args: parts.slice(1) };
	}

	// global rate budget shared across every command/channel (anti-abuse).
	function commandCooldownOk() {
		const nowMs = Date.now();
		const cutoff = nowMs - COMMAND_COOLDOWN_WINDOW_MS;
		while (commandHits.length && commandHits[0] < cutoff) commandHits.shift();
		if (commandHits.length >= COMMAND_COOLDOWN_MAX) return false;
		commandHits.push(nowMs);
		return true;
	}

	// run a resolved command; tolerates sync + async handlers.
	function dispatch(parsed, geo) {
		const c = parsed.command;
		if (!c) return false;
		Promise.resolve(c.run({ geo, args: parsed.args })).catch((e) => console.error(`[bot] !${c.name} failed:`, e.message));
		return true;
	}

	// --- ingest hook ---------------------------------------------------------
	// called by the aggregator for each accepted LIVE chat event. Records activity
	// + language for every real message, and serves any `!command`. Backlog replays
	// (live=false) are never passed here, so the bot never answers stale history or
	// double-counts a relay's stored backlog.
	function observe(ev, geo, source) {
		if (!ev || ev.kind !== CHAT_KIND || !geo) return;
		if (botPubkeys.has(ev.pubkey)) return; // never react to / count our own replies (incl. just-rotated keys)

		const content = String(ev.content || "");
		const parsed = parseCommand(content);

		// gate on the same rules a client uses to render a message. an event no client
		// would show (forged-future timestamp, or - like a default native client - no
		// valid proof-of-work nonce) is ignored entirely, so a stealth message can't
		// drive the bot without also being a real, visible message.
		const vis = isRenderable(ev, now());
		if (!vis.ok) {
			// a hidden *command* is exactly the abuse to inspect: dump the raw event +
			// the relay that carried it (a nonce mine cost / a forged clock will show).
			if (parsed) {
				console.warn(
					`[bot] IGNORED !${parsed.name} in #${geo} — ${vis.reason} — via ${source || "?"} — ` +
						`pow ${idDifficulty(ev.id)}/${committedDifficulty(ev)} — ${JSON.stringify(ev)}`,
				);
			}
			return;
		}

		// language + presence + last-seen tracking happen for every message (commands
		// included, exactly as before - a "!top" is too short for franc to latch onto).
		updateChannelLanguage(geo, content);
		noteActivePubkey(ev.pubkey, ev.created_at);
		noteSeen(nameOf(ev), geo, ev.created_at);

		if (parsed) {
			// any "!"-prefixed message is a command attempt - never counted as chat.
			if (!parsed.command) {
				console.log(`[bot] saw !${parsed.name} in #${geo} (unknown - no handler)`);
				return;
			}
			// log the whole event for every command so an odd/stealth one can be
			// inspected (which relay, pow it carried, tags, timestamp skew, raw json).
			console.log(
				`[bot] !${parsed.name} in #${geo} from ${ev.pubkey.slice(0, 8)} · pow ${idDifficulty(ev.id)}/${committedDifficulty(ev)} · ` +
					`skew ${ev.created_at - now()}s · via ${source || "?"} · ${JSON.stringify(ev)}`,
			);
			if (!commandCooldownOk()) {
				console.log(`[bot] !${parsed.name} dropped (global cooldown)`);
				return; // global budget spent
			}
			dispatch(parsed, geo);
			return; // a command isn't itself "channel activity"
		}

		// real chat: feed the !top score + the !listen buffers
		if (content) {
			recordChannelActivity(geo, ev.created_at);
			pushRecent(ev, geo, content);
			rememberMessageLanguage(geo, nameOf(ev), content, ev.created_at);
		}
	}

	function stats() {
		return {
			pubkey: pk, // current (rotating) key
			name: botName,
			rotateMin: ROTATE_MIN,
			commands: COMMANDS.map((c) => c.name),
			trackedChannels: channelActivity.size,
			activeUsers: activePubkeys.size,
			languages: channelLanguage.size,
			recentBuffered: recentOther.length,
		};
	}

	return { observe, stats, get pubkey() { return pk; } };
}
