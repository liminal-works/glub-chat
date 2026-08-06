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
import { geohashToLatLon, countryCodeToFlag, latLonToGeohash, formatRegionSize, parseLatLonInput } from "./geo.mjs";
import { queryNostr, extractImageUrlsFromEvent, normalizeNostrTag } from "./nostrQuery.mjs";

const now = () => Math.floor(Date.now() / 1000);

// fisher-yates. Used so a "random" pick is genuinely one rather than whatever the
// relays happened to hand back first.
function shuffle(arr) {
	const out = arr.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
const NOSTR_POOL = 60; // candidates gathered before scoring - a pool of 12 has nothing to choose from
const NOSTR_MAX_TAGS = 8; // a search is a handful of words; past that it's an attempt to build a filter that never matches
// A backstop, not a style. The note goes out whole: clipping it here is the wrong
// place, because the reader taps "more" expecting the rest and finds the bot already
// threw it away. The client's own wall handling does the collapsing.
const NOSTR_MAX_BODY = 4000;
const COMMAND_COOLDOWN_WINDOW_MS = 60_000; // global command budget window
// ...and how many commands fit in it. Global, not per-user, so an instance watching
// a dozen busy geohashes needs more headroom than one sitting on a quiet channel -
// hence the knob.
const COMMAND_COOLDOWN_MAX = Number(process.env.GLUB_BOT_COMMAND_MAX) || 12;
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

// glub.chat promo: on this fraction of command replies to NON-glub clients (native
// bitchat users who may not know the web client exists), tack a small nudge onto
// the reply. Fully reversible via env - GLUB_BOT_PROMO_RATE=0 turns it off; the
// value is clamped to [0,1], default 0.25.
const PROMO_RATE = (() => {
	const n = Number(process.env.GLUB_BOT_PROMO_RATE);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.25;
})();
const PROMO_TEXT = "\n\ntry https://glub.chat/";

// --- shouts (admin broadcast) ----------------------------------------------
// A shout is deliberately NOT a fan-out to every channel we know about. It stays
// live for a window and drops into a channel the FIRST time that channel shows
// activity, so it only ever lands somewhere a person is currently present to read
// it. Blasting the index instead would reach mostly-empty geohashes, and would look
// exactly like the spam the bot exists to not be.
const SHOUT_WINDOW_SEC = Number(process.env.GLUB_SHOUT_WINDOW_SEC) || 420; // how long a shout stays live
const SHOUT_MAX_CHANNELS = Number(process.env.GLUB_SHOUT_MAX_CHANNELS) || 250; // safety cap per shout
const SHOUT_INTERVAL_MS = Number(process.env.GLUB_SHOUT_INTERVAL_MS) || 400; // min gap between deliveries, across ALL jobs

// --- !news: world headlines from public rss ----------------------------------
// Ported from the original bitbot. Plain RSS/Atom over https: no api key, no
// quota, nothing to bill. The cache is there to be polite to the feeds rather
// than to save anything - one refresh an hour serves every channel this instance
// is sitting on.
const NEWS_CACHE_TTL_MS = 60 * 60_000; // serve cached headlines this long
const NEWS_COUNT = 8; // headlines per reply
const NEWS_FETCH_TIMEOUT_MS = 8000; // per feed; one slow source must not hold the rest
const NEWS_MAX_AGE_MS = 48 * 3600_000; // ignore anything older than this
const NEWS_TITLE_CLIP = 110;

// All keyless and free. A feed that fails or disappears is skipped silently, so
// this list can be edited without breaking the command.
const NEWS_SOURCES = [
	["bbc", "https://feeds.bbci.co.uk/news/world/rss.xml"],
	["aljaz", "https://www.aljazeera.com/xml/rss/all.xml"],
	["npr", "https://feeds.npr.org/1001/rss.xml"],
	["guardian", "https://www.theguardian.com/world/rss"],
	["dw", "https://rss.dw.com/rdf/rss-en-world"],
	["cbc", "https://www.cbc.ca/webfeed/rss/rss-world"],
];

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#8217": "'" };

function decodeXml(text) {
	return String(text)
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		// markup comes off before entities are decoded: otherwise an escaped
		// "&lt;tag&gt;" inside a headline turns into markup and gets stripped
		.replace(/<[^>]+>/g, "")
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&([a-z0-9#]+);/gi, (m, e) => XML_ENTITIES[e.toLowerCase()] ?? m)
		.replace(/\s+/g, " ")
		.trim();
}

function firstXmlTag(block, tag) {
	const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
	return m ? decodeXml(m[1]) : "";
}

// RSS puts the url in <link>text</link>; Atom puts it in an href attribute.
function firstFeedLink(block) {
	const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
	if (rss && rss[1].trim()) return decodeXml(rss[1]);
	const atom =
		block.match(/<link[^>]*\srel=["']alternate["'][^>]*\shref=["']([^"']+)["']/i) ||
		block.match(/<link[^>]*\shref=["']([^"']+)["']/i);
	return atom ? decodeXml(atom[1]) : "";
}

// Feeds append tracking parameters and they bloat a chat line for no one's benefit.
// Two lists, because some of these are families with a shared prefix (utm_source,
// utm_medium, at_campaign...) and some are whole names that must match exactly - a
// prefix rule on "ref" would eat "referendum".
const TRACKING_PREFIXES = /^(at_|utm_|ns_|pk_|mc_)/i;
const TRACKING_PARAMS = new Set(["cmpid", "ito", "smid", "traffic_source", "maca", "ref", "src", "source", "cid", "ncid", "fbclid", "gclid"]);
function cleanArticleUrl(url) {
	const raw = String(url || "").trim();
	if (!/^https?:\/\//i.test(raw)) return "";
	try {
		const u = new URL(raw);
		for (const key of [...u.searchParams.keys()]) {
			if (TRACKING_PREFIXES.test(key) || TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
		}
		return u.toString();
	} catch {
		return raw;
	}
}

// Two outlets almost never file the same story in the same words - "Volcano erupts
// and strands travellers" and "Travellers stranded as volcano erupts" are one story -
// so duplicates are found by how much vocabulary two headlines share rather than by
// any exact key. Endings are clipped first so "strands" and "stranded" count as one
// word; it is not real stemming, just enough to survive a rewrite.
const NEWS_STOPWORDS = new Set([
	"after", "amid", "another", "around", "been", "before", "being", "could", "does",
	"during", "from", "have", "into", "more", "most", "over", "said", "says", "than",
	"that", "their", "them", "then", "there", "these", "they", "this", "were", "what",
	"when", "which", "while", "will", "with", "would", "your",
]);
const NEWS_DUPE_RATIO = 0.6; // shared words, as a fraction of the shorter headline
const NEWS_DUPE_MIN = 3; // below this there is too little vocabulary to judge on

function newsStem(word) {
	const cut = word.replace(/(ings?|ed|es|s)$/, "");
	return cut.length >= 3 ? cut : word;
}

function headlineTokens(title) {
	return new Set(
		String(title)
			.toLowerCase()
			.replace(/[^a-z0-9 ]+/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 3 && !NEWS_STOPWORDS.has(w))
			.map(newsStem),
	);
}

function sameStory(a, b) {
	const small = a.size < b.size ? a : b;
	if (small.size < NEWS_DUPE_MIN) return false;
	let shared = 0;
	for (const w of small) if (a.has(w) && b.has(w)) shared++;
	return shared / small.size >= NEWS_DUPE_RATIO;
}

// RSS <item> and Atom <entry> parse the same way here; both carry a title and a date.
function parseFeed(xml, source) {
	const out = [];
	const blocks = String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
	for (const block of blocks) {
		const title = firstXmlTag(block, "title");
		if (!title) continue;
		const when =
			firstXmlTag(block, "pubDate") ||
			firstXmlTag(block, "published") ||
			firstXmlTag(block, "updated") ||
			firstXmlTag(block, "dc:date");
		const ts = when ? Date.parse(when) : NaN;
		out.push({ title, source, url: cleanArticleUrl(firstFeedLink(block)), ts: Number.isFinite(ts) ? ts : 0 });
	}
	return out;
}

async function fetchFeed(name, url) {
	const res = await fetch(url, {
		headers: { "User-Agent": NOMINATIM_UA },
		signal: AbortSignal.timeout(NEWS_FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return parseFeed(await res.text(), name);
}

// Pull every feed at once, drop stale and duplicate stories, then INTERLEAVE the
// sources - taking each outlet's freshest, then each outlet's second, and so on -
// so one prolific wire service can't own the whole list.
async function fetchHeadlines() {
	const results = await Promise.allSettled(NEWS_SOURCES.map(([name, url]) => fetchFeed(name, url)));
	const bySource = new Map();
	const cutoff = Date.now() - NEWS_MAX_AGE_MS;
	let ok = 0;

	results.forEach((r, i) => {
		const [name] = NEWS_SOURCES[i];
		if (r.status !== "fulfilled") {
			console.log(`[bot] news: ${name} failed: ${r.reason?.message || r.reason}`);
			return;
		}
		// items with no parseable date are KEPT: a headline of unknown timing beats
		// silently dropping a whole source over a date format
		const fresh = r.value.filter((x) => !x.ts || x.ts >= cutoff);
		fresh.sort((a, b) => b.ts - a.ts);
		if (fresh.length) {
			bySource.set(name, fresh);
			ok++;
		}
	});
	if (!ok) throw new Error("all feeds failed");

	const picked = [];
	const takenUrls = new Set();
	const takenTokens = [];
	const queues = [...bySource.values()];
	for (let round = 0; picked.length < NEWS_COUNT * 2 && round < 20; round++) {
		let advanced = false;
		for (const q of queues) {
			const item = q[round];
			if (!item) continue;
			advanced = true;
			if (item.url && takenUrls.has(item.url)) continue; // literally the same article
			const tokens = headlineTokens(item.title);
			if (takenTokens.some((prev) => sameStory(prev, tokens))) continue; // same story, different outlet
			takenTokens.push(tokens);
			if (item.url) takenUrls.add(item.url);
			picked.push(item);
		}
		if (!advanced) break;
	}
	console.log(`[bot] news: refreshed from ${ok}/${NEWS_SOURCES.length} feeds, ${picked.length} headlines`);
	return picked;
}

// Module-level so every channel this instance serves shares one cache. Concurrent
// callers share the in-flight fetch rather than each starting their own, and a
// failed refresh keeps serving the previous headlines - stale news beats no news,
// and the header says how old it is either way.
const newsCache = { items: [], at: 0, pending: null };

async function getHeadlines(force = false) {
	const fresh = newsCache.items.length && Date.now() - newsCache.at < NEWS_CACHE_TTL_MS;
	if (!force && fresh) return newsCache.items;
	if (newsCache.pending) return newsCache.pending;

	newsCache.pending = (async () => {
		try {
			const items = await fetchHeadlines();
			newsCache.items = items;
			newsCache.at = Date.now();
			return items;
		} catch (err) {
			console.log("[bot] news: refresh failed:", err.message);
			if (newsCache.items.length) return newsCache.items; // serve stale
			throw err;
		} finally {
			newsCache.pending = null;
		}
	})();
	return newsCache.pending;
}

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
export function createBot({
	broadcast,
	store,
	patrons = null,
	vault = null,
	admin = null,
	nip05Domain = "glub.chat",
	botName = process.env.GLUB_BOT_NAME || "glub.bot",
} = {}) {
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
		`[bot] identity ${pk.slice(0, 8)}...${pk.slice(-4)} name=${botName}` +
			(ROTATE_MIN > 0 ? ` (rotating every ${ROTATE_MIN}m)` : " (rotation off)"),
	);

	if (ROTATE_MIN > 0) {
		setInterval(() => {
			adoptKey(randomKey());
			console.log(`[bot] rotated identity -> ${pk.slice(0, 8)}...${pk.slice(-4)}`);
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

	// !listen <lang>: recent messages detected in an ISO-639-3 language (eng/rus/...).
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

	// the promo suffix for the CURRENT command's reply, chosen once per dispatch
	// from the triggering event (see dispatch). reply() appends it and clears it,
	// so only the command's first posted line carries the nudge. Best-effort under
	// rare async interleaving of two commands - it's a cosmetic promo, worst case a
	// reply gets a different 25% draw than intended.
	let promoForReply = "";
	// the lower-cased "client" tag value on an event ("" if none).
	function clientOf(ev) {
		const tags = Array.isArray(ev?.tags) ? ev.tags : [];
		const tag = tags.find((t) => Array.isArray(t) && t[0] === "client");
		return tag && typeof tag[1] === "string" ? tag[1].toLowerCase() : "";
	}
	// pick the promo for a triggering event: nothing if disabled, the sender is
	// already on glub.chat (don't sell them what they're using), or the dice miss.
	function pickPromo(ev) {
		if (!PROMO_RATE || !ev) return "";
		if (clientOf(ev) === "glub.chat") return "";
		return Math.random() < PROMO_RATE ? PROMO_TEXT : "";
	}

	function reply(content, geohash) {
		if (!content || !geohash) return;
		const promo = promoForReply;
		promoForReply = ""; // consume: only the first reply of a command carries it
		const ev = makeBotChatMessage(content + promo, geohash);
		const sent = broadcast?.(ev, geohash);
		console.log(`[bot] reply -> #${geohash} (${sent ?? 0} relays)${promo ? " +promo" : ""}`);
	}

	// A message nobody asked for - the background sweep noticing a donation landed,
	// possibly minutes after the !donate that started it. Deliberately not reply():
	// promoForReply belongs to a dispatch, and borrowing it here would staple one
	// command's promo onto an unrelated announcement long after the fact.
	function announce(content, geohash) {
		if (!content || !geohash) return;
		const ev = makeBotChatMessage(content, geohash);
		const sent = broadcast?.(ev, geohash);
		console.log(`[bot] announce -> #${geohash} (${sent ?? 0} relays)`);
	}

	// --- shouts -----------------------------------------------------------------
	// Ported from the standalone bitbot, and the reason it works this way is worth
	// keeping: a shout is opportunistic, not a broadcast. The job sits in a list for
	// its window and gets delivered to a channel the first time that channel shows
	// live activity - so it reaches people who are there, in the order they turn up,
	// rather than every geohash the index has ever seen.
	const shouts = [];
	let shoutSeq = 0;
	let shoutLastMs = 0; // global across all jobs, so two shouts can't double the rate

	function startShout(message) {
		const msg = String(message || "").trim();
		if (!msg) return null;
		const job = { id: ++shoutSeq, msg, until: now() + SHOUT_WINDOW_SEC, channels: new Set() };
		shouts.push(job);
		console.log(`[bot] shout #${job.id} queued for ${SHOUT_WINDOW_SEC}s`);
		return job;
	}

	// Drop jobs that ran out of time or hit their channel cap.
	function pruneShouts() {
		const t = now();
		for (let i = shouts.length - 1; i >= 0; i--) {
			const job = shouts[i];
			if (t < job.until && job.channels.size < SHOUT_MAX_CHANNELS) continue;
			shouts.splice(i, 1);
			console.log(`[bot] shout #${job.id} done, reached ${job.channels.size} channels`);
		}
	}

	function stopShouts() {
		const n = shouts.length;
		shouts.length = 0;
		if (n) console.log(`[bot] stopped ${n} shout(s)`);
		return n;
	}

	// Called for every channel we see activity in. Delivers at most ONE shout per
	// sighting: with several queued, a single busy channel would otherwise receive
	// all of them back to back, which is the exact thing that reads as spam.
	function maybeShout(geo) {
		pruneShouts();
		if (!geo || !shouts.length) return;

		const ms = Date.now();
		if (ms - shoutLastMs < SHOUT_INTERVAL_MS) return;

		for (const job of shouts) {
			if (job.channels.has(geo)) continue; // already reached; never twice
			job.channels.add(geo);
			shoutLastMs = ms;
			announce(job.msg, geo);
			console.log(`[bot] shout #${job.id} -> #${geo} (${job.channels.size})`);
			break; // one per sighting keeps delivery gentle
		}

		pruneShouts();
	}

	// called by the patron sweep when an invoice settles. The thank-you goes back to
	// the channel the donation was asked for in, which is also the channel that
	// watched them decide to do it.
	function announcePatron(patron, invoice) {
		if (!patron || !invoice?.geohash) return;
		const who = invoice.name ? `@${invoice.name} ` : "";
		announce(`thank you ${who}· you're a patron: ${nip05Of(patron.name)} · !nip05 <name> to change it`, invoice.geohash);
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
			const span = formatRegionSize(geo);
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
				const size = formatRegionSize(gh);
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

	// !nostr: reach into the wider nostr firehose (not just geohash notes).
	//
	//   !nostr                  a random note that has an image (any note if none do)
	//   !nostr sunset flower    every word is a tag, "#" optional. Notes are SCORED by
	//                           how many of them they hit and the best one wins - a
	//                           post matching 3 of 4 beats one matching 1.
	//   !nostr <npub|hex>       that author's recent posts, newest first
	//
	// The note is relayed WHOLE. Clipping it here was the wrong place to do it: the
	// reader taps "more" expecting the rest and finds the bot already threw it away.
	// The client collapses long messages on its own, so all that's left here is a
	// safety cap for something pathological.
	async function cmdNostr(geo, args) {
		const raw = args.join(" ").trim();
		// a lone npub/hex is the one argument that isn't a tag - browsing a person's
		// feed is a different question from searching, and worth keeping.
		const author = args.length === 1 ? toHexPubkey(raw) : "";
		const tags = author
			? []
			: [...new Set(raw.split(/\s+/).map(normalizeNostrTag).filter(Boolean))].slice(0, NOSTR_MAX_TAGS);

		const unseen = (ev) => !nostrSeen.has(ev.id);
		let events = [];

		if (author) {
			events = await queryNostr({ kinds: [1], authors: [author], limit: NOSTR_SCAN_LIMIT }, {
				timeoutMs: NOSTR_TIMEOUT_MS,
				want: NOSTR_WANT,
				accept: unseen,
			});
			events.sort((a, b) => b.created_at - a.created_at); // a feed reads newest first
		} else if (tags.length) {
			// relay-side "#t" is the cheap pass and catches properly-hashtagged notes.
			events = await queryNostr({ kinds: [1], "#t": tags, limit: NOSTR_SCAN_LIMIT }, {
				timeoutMs: NOSTR_TIMEOUT_MS,
				want: NOSTR_POOL,
				accept: unseen,
			});
			// nothing tagged? plenty of people write "sunset" without hashing it, so
			// fall back to a broad scan and let the scorer read the text instead.
			if (!events.length) {
				events = await queryNostr({ kinds: [1], limit: NOSTR_SCAN_LIMIT }, {
					timeoutMs: NOSTR_TIMEOUT_MS,
					want: NOSTR_POOL,
					accept: (ev) => unseen(ev) && scoreNostr(ev, tags).matched > 0,
				});
			}
			events = rankByTags(events, tags);
		} else {
			// no argument: a picture, ideally. The image test is applied when PICKING
			// rather than when accepting, so a scan that happens to turn up no images
			// still has something to show instead of coming back empty-handed.
			events = await queryNostr({ kinds: [1], limit: NOSTR_SCAN_LIMIT }, {
				timeoutMs: NOSTR_TIMEOUT_MS,
				want: NOSTR_POOL,
				accept: unseen,
			});
			const withImage = events.filter((ev) => extractImageUrlsFromEvent(ev).length > 0);
			events = shuffle(withImage.length ? withImage : events);
		}

		const pick = events[0];
		if (!pick) {
			const f = tags.length ? ` for ${tags.map((t) => "#" + t).join(" ")}` : author ? ` for ${toNpub(author).slice(0, 12)}...` : "";
			reply(`nostr:\n\nno new notes${f}`, geo);
			return;
		}
		nostrSeen.add(pick.id);
		if (nostrSeen.size > NOSTR_SEEN_MAX) nostrSeen.clear();

		// the whole note, newlines and all - a post's shape is part of it. Only the
		// runs of blank lines are tidied, and the cap is a backstop, not a style.
		const body = clipText(String(pick.content || "").replace(/\n{3,}/g, "\n\n").trim(), NOSTR_MAX_BODY);
		const url = extractImageUrlsFromEvent(pick)[0] || "";

		const meta =
			`${timeAgo(now(), pick.created_at)} ago` +
			(tags.length ? ` · ${tags.map((t) => "#" + t).join(" ")}` : "");

		const lines = [`nostr:`, "", toNpub(pick.pubkey)];
		if (body) lines.push("", body);
		// the url is usually already IN the note - appending it again would just show
		// the same link twice.
		if (url && !body.includes(url)) lines.push(url);
		lines.push("", meta);
		reply(lines.join("\n"), geo);
	}

	// how many of `tags` a note hits, and how many of those are real "t" tags rather
	// than a word in the text. Both count as a match - somebody typing "sunset" plainly
	// meant it - but a hashtagged one is the stronger signal and breaks ties.
	function scoreNostr(ev, tags) {
		const tagged = new Set(
			(Array.isArray(ev.tags) ? ev.tags : [])
				.filter((t) => Array.isArray(t) && t[0] === "t")
				.map((t) => normalizeNostrTag(t[1])),
		);
		const content = String(ev.content || "").toLowerCase();
		let matched = 0;
		let hashed = 0;
		for (const tag of tags) {
			const inTags = tagged.has(tag);
			// a whole word, so "art" doesn't match "cartoon"
			const inText = new RegExp(`(?:^|[^\\p{L}\\p{N}_])#?${escapeRegExp(tag)}(?:[^\\p{L}\\p{N}_]|$)`, "u").test(content);
			if (inTags || inText) matched++;
			if (inTags) hashed++;
		}
		return { matched, hashed };
	}

	// best-scoring notes first. Within a tie: more real hashtags, then having an
	// image, then random - so running the same search twice rotates rather than
	// handing back the same note until it's been seen.
	function rankByTags(events, tags) {
		const scored = events
			.map((ev) => ({ ev, ...scoreNostr(ev, tags), img: extractImageUrlsFromEvent(ev).length > 0, r: Math.random() }))
			.filter((x) => x.matched > 0);
		scored.sort((a, b) => b.matched - a.matched || b.hashed - a.hashed || Number(b.img) - Number(a.img) || a.r - b.r);
		return scored.map((x) => x.ev);
	}

	// a relay source url for display: drop the ws(s):// scheme + trailing slash so
	// it reads as a bare host. "api:publish" (an event that came in via our own
	// publish endpoint, not a relay socket) and unknowns get a friendly label.
	function prettyRelay(source) {
		const s = String(source || "").trim();
		if (!s || s === "?") return "unknown";
		if (s === "api:publish") return "api (direct publish)";
		return s.replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
	}

	// a compact delay label: sub-second in ms, otherwise seconds with one decimal.
	function formatDelay(ms) {
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	// !ping: a liveness/latency check. Reports how long the command took to reach
	// the bot (receipt wall-clock minus the message's created_at) and which relay
	// carried it here. created_at is second-resolution, so the delay is an estimate
	// (and clamps at 0 when a sender's clock runs slightly ahead), but it's a real
	// one-way propagation figure and the relay is exactly the socket it arrived on.
	function cmdPing(c) {
		const ageMs = Math.max(0, c.recvMs - c.ev.created_at * 1000);
		reply(`pong:\n\ndelay ${formatDelay(ageMs)}\nrelay ${prettyRelay(c.source)}`, c.geo);
	}

	// !help: generated from the registry, so a new command shows up here for free.
	// Kept SHORT (terse one-liners) so it doesn't wrap on mobile; the per-command
	// !help <command> page carries the usage + optional params.
	function cmdHelp(geo, arg, asAdmin = false) {
		const visible = (c) => !c.hidden && (!c.admin || asAdmin);
		const q = String(arg || "").trim().toLowerCase().replace(/^!/, "");
		if (q) {
			const c = byToken.get(q);
			// an admin command stays invisible even when asked for by name - otherwise
			// !help vault is a way to discover exactly what !vault denied you
			if (c && visible(c)) {
				const alias = c.aliases?.length ? `\n\nalias: ${c.aliases.map((a) => "!" + a).join(" · ")}` : "";
				reply(`!${c.name}:\n\n${c.usage || c.desc}${alias}`, geo);
				return;
			}
		}
		const lines = COMMANDS.filter(visible)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((c) => `- !${c.name} · ${c.desc}`);
		reply(`commands:\n\n${lines.join("\n")}\n\n!help <command> for more`, geo);
	}

	// !news: world headlines. One reply, one line per story with its url beneath,
	// blank line between - the same layout the original bot used, which reads as a
	// list on a phone without any markup to lean on.
	//
	// "!news refresh" forces past the cache. It's the escape hatch for a stale hour
	// rather than a way to hammer the feeds: the global command budget already caps
	// how often anything here runs.
	async function cmdNews(geo, args) {
		const force = String(args[0] || "").toLowerCase() === "refresh";
		let items;
		try {
			items = await getHeadlines(force);
		} catch {
			reply("news unavailable right now", geo);
			return;
		}
		if (!items.length) {
			reply("no headlines", geo);
			return;
		}
		const ageMin = newsCache.at ? Math.floor((Date.now() - newsCache.at) / 60_000) : 0;
		const header = ageMin < 1 ? "news:" : `news (${ageMin}m ago):`;
		const entries = items.slice(0, NEWS_COUNT).map((x) => {
			const line = `${clipText(x.title, NEWS_TITLE_CLIP)} (${x.source})`;
			return x.url ? `${line}\n${x.url}` : line;
		});
		reply(`${header}\n\n${entries.join("\n\n")}`, geo);
	}

	// --- patronage ------------------------------------------------------------
	// Every handler below reads the pubkey off the SIGNED event. The aggregator has
	// already verified that signature before observe() ever saw it, so `ev.pubkey`
	// is proof of the key rather than a claim about it - which is why none of this
	// needs a login, a session, a token, or a challenge. A !nip05 that isn't signed
	// by the pubkey it would rename cannot reach this code.
	const nip05Of = (name) => `${name}@${nip05Domain}`;
	const payerOf = (c) => (c.ev && typeof c.ev.pubkey === "string" ? c.ev.pubkey : "");

	async function cmdDonate(c) {
		const pubkey = payerOf(c);
		if (!pubkey) return; // no signed event behind it; nothing to attribute a payment to
		let out;
		try {
			out = await patrons.requestInvoice({ pubkey, name: nameOf(c.ev), geo: c.geo });
		} catch (e) {
			console.error("[bot] !donate failed:", e.message);
			reply("couldn't reach the lightning node - try again in a minute", c.geo);
			return;
		}
		if (out.status === "unconfigured") {
			reply("donations aren't set up on this instance", c.geo);
			return;
		}
		if (out.status === "already") {
			reply(`you're already a patron: ${nip05Of(out.patron.name)} · !nip05 <name> to change it`, c.geo);
			return;
		}
		const inv = out.invoice;
		const mins = Math.max(1, Math.round((inv.expires_at - now()) / 60));
		const lead =
			out.status === "reused"
				? `your invoice is still open (${mins}m left)`
				: `${inv.amount_sats} sats for a nip-05 on ${nip05Domain} (${mins}m)`;
		// the bolt11 alone on its own line: glub renders a bare invoice as a tappable
		// pay chip, and native clients get something clean to copy. Anyone in the
		// channel can pay it, which is the point - donations can be gifts.
		reply(`${lead}:\n\n${inv.bolt11}\n\ncredited automatically once paid · !redeem to check now`, c.geo);
	}

	async function cmdRedeem(c) {
		const pubkey = payerOf(c);
		if (!pubkey) return;
		let out;
		try {
			out = await patrons.redeem(pubkey);
		} catch (e) {
			console.error("[bot] !redeem failed:", e.message);
			reply("couldn't reach the lightning node - try again in a minute", c.geo);
			return;
		}
		if (out.status === "settled") reply(`thank you · you're a patron: ${nip05Of(out.patron.name)} · !nip05 <name> to change it`, c.geo);
		else if (out.status === "already") reply(`you're already a patron: ${nip05Of(out.patron.name)}`, c.geo);
		else if (out.status === "pending") reply("that invoice hasn't been paid yet", c.geo);
		else if (out.status === "none") reply("no open invoice · !donate to start one", c.geo);
		else reply("donations aren't set up on this instance", c.geo);
	}

	function cmdNip05(c) {
		const pubkey = payerOf(c);
		if (!pubkey) return;
		const requested = c.args.join(" ").trim();
		if (!requested) {
			reply(`usage: !nip05 <name> · your identity becomes <name>@${nip05Domain}`, c.geo);
			return;
		}
		const out = patrons.rename(pubkey, requested);
		if (out.status === "ok") reply(`renamed: ${nip05Of(out.previous)} -> ${nip05Of(out.patron.name)}`, c.geo);
		else if (out.status === "unchanged") reply(`already yours: ${nip05Of(out.patron.name)}`, c.geo);
		else if (out.status === "taken") reply("that name is taken", c.geo);
		else if (out.status === "invalid") reply("nip-05 names can use a-z 0-9 - _ . only", c.geo);
		else if (out.status === "cooldown") reply(`too soon · you can rename again in ${timeAgo(out.retryAfter, 0)}`, c.geo);
		else reply(`not a patron yet · !donate for a nip-05 on ${nip05Domain}`, c.geo);
	}

	// --- authorisation ------------------------------------------------------------
	// Redeem the rotating code printed on every console line. Terminal access is the
	// root credential: whoever can read the logs can make themselves an admin once,
	// and that redemption immediately rotates the code, so the one that just travelled
	// through a public channel is already spent.
	function cmdAuth(c) {
		const pubkey = payerOf(c);
		const [sub, ...rest] = c.args;
		const verb = String(sub || "").toLowerCase();

		if (c.isAdmin && verb === "who") {
			const list = admin.authorized();
			const perm = admin.permanent().length;
			reply(`authorized: ${list.length}${perm ? ` (+${perm} permanent)` : ""}`, c.geo);
			return;
		}
		if (c.isAdmin && verb === "clear") {
			reply(`cleared ${admin.clear()} authorization(s)`, c.geo);
			return;
		}
		if (c.isAdmin && verb === "revoke") {
			const out = admin.revoke(String(rest[0] || "").trim());
			reply(
				out.status === "ok" ? "revoked" : out.status === "permanent" ? "that one is set in the environment" : "not authorized",
				c.geo,
			);
			return;
		}
		if (c.isAdmin && verb === "rotate") {
			admin.rotate("requested");
			reply("code rotated · see the server console", c.geo);
			return;
		}

		// Silent with no argument. !auth on its own must not answer, or it becomes a
		// probe anyone can use to discover that there is a gate here at all.
		if (!verb) return;
		if (c.isAdmin) {
			reply("already authorized", c.geo);
			return;
		}

		const out = admin.redeem(verb, pubkey);
		if (out.status === "ok") reply("authorized", c.geo);
		else if (out.status === "throttled") reply("too many attempts · wait a minute", c.geo);
		else reply("not authorized", c.geo);
	}

	// !shout: queue a message for opportunistic delivery. Admin-only for now; the
	// machinery is rate-limited per job rather than per caller, so opening it up to
	// patrons later is a gate change rather than a redesign.
	function cmdShout(c) {
		pruneShouts();
		const arg = String(c.argStr || "").trim();

		if (!arg) {
			if (!shouts.length) {
				reply("no shouts", c.geo);
				return;
			}
			const reach = shouts.reduce((n, j) => n + j.channels.size, 0);
			reply(`${shouts.length} active, ${reach} channels reached`, c.geo);
			return;
		}

		if (arg.toLowerCase() === "stop") {
			reply(stopShouts() ? "stopped" : "no shouts", c.geo);
			return;
		}

		const job = startShout(arg);
		if (!job) {
			reply("shout failed", c.geo);
			return;
		}
		// everyone in this channel just watched it being typed, so mark it delivered
		// here rather than echoing it back at them
		job.channels.add(c.geo);
		reply("queued", c.geo);
	}

	// --- the vault (admin) ------------------------------------------------------
	// Cashu proofs the bot is holding. The `admin: true` flag on its registry entry is
	// what gates it (see dispatch), so this handler never has to remember to check -
	// and a non-admin gets silence rather than a refusal, because a public channel is
	// the wrong place to advertise that a balance exists.
	async function cmdVault(c) {
		const [sub, ...rest] = c.args;
		const verb = String(sub || "").toLowerCase();

		if (!verb || verb === "balance") {
			const s = vault.stats ? vault.stats() : {};
			reply(
				`vault: ${vault.balanceSats?.() ?? 0} sats in ${vault.proofCount?.() ?? 0} proofs` +
					`\nmint: ${s.mint || "-"}\npayout: ${s.payout || "none"}` +
					`\nuncollected: ${patrons.stats().uncollected}`,
				c.geo,
			);
			return;
		}

		if (verb === "sweep") {
			const target = rest.join(" ").trim();
			// Checked here rather than left to the melt: resolving an address for a zero
			// balance fails deep inside lnurl with "amount must be positive", which is a
			// true statement about the wrong thing.
			if (!vault.balanceSats()) {
				reply("vault is empty", c.geo);
				return;
			}
			try {
				// A lightning address always contains "@" and a bolt11 never does, so that
				// is the test. Telling them apart by LENGTH would work until someone pasted
				// a short invoice, and then it would try to resolve it as a domain.
				const out = !target
					? await vault.sweepToPayout()
					: target.includes("@")
						? await vault.sweepToAddress(target)
						: await vault.meltTo(target);
				if (out?.status === "sent") reply(`swept ${out.amount} sats · ${out.remaining} sats left`, c.geo);
				else if (out?.status === "empty") reply("vault is empty", c.geo);
				else if (out?.status === "below-threshold") reply(`below the auto-sweep threshold (${out.balance} sats)`, c.geo);
				else if (out?.status === "no-payout") reply("no payout address set · !vault sweep <bolt11 or address>", c.geo);
				else if (out?.status === "insufficient") reply(`not enough: need ${out.need}, have ${out.have}`, c.geo);
				else reply(`sweep: ${out?.status || "failed"}`, c.geo);
			} catch (e) {
				console.error("[bot] !vault sweep failed:", e.message);
				reply(`sweep failed: ${clipText(e.message, 80)}`, c.geo);
			}
			return;
		}

		if (verb === "reconcile") {
			try {
				const out = await vault.reconcile();
				reply(`reconciled: dropped ${out.dropped || 0} spent proofs · ${out.total ?? 0} sats`, c.geo);
			} catch (e) {
				reply(`reconcile failed: ${clipText(e.message, 80)}`, c.geo);
			}
			return;
		}

		reply("!vault · !vault sweep [bolt11|address] · !vault reconcile", c.geo);
	}

	// the command registry: adding an entry here makes a command parse, dispatch,
	// AND appear in !help automatically - there's no static list to keep in sync.
	// aliases are the bang-stripped forms users learned (!t, !l, !list, !dump...).
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
			desc: "pull a note from nostr (with an image, or matching your tags)",
			usage: "!nostr · !nostr <tag> [tag...] · !nostr <npub>",
			run: (c) => cmdNostr(c.geo, c.args),
		},
		{
			name: "news",
			aliases: ["n"],
			desc: "recent world headlines",
			usage: "!news · !news refresh",
			run: (c) => cmdNews(c.geo, c.args),
		},
		{ name: "ping", aliases: ["p"], desc: "delay + delivering relay", usage: "!ping", run: (c) => cmdPing(c) },
		// Public on purpose. A donation invoice posted in the channel is one anyone
		// present can settle - including for someone else - and the exchange doubles
		// as the only advertising the thing gets. A DM-only flow would hide both.
		...(patrons?.configured
			? [
					{
						name: "donate",
						aliases: ["patron"],
						desc: `become a patron · nip-05 on ${nip05Domain}`,
						usage: "!donate",
						run: (c) => cmdDonate(c),
					},
					{
						name: "redeem",
						desc: "check your donation invoice now",
						usage: "!redeem",
						run: (c) => cmdRedeem(c),
					},
					{
						name: "nip05",
						aliases: ["nip5"],
						desc: "change your nip-05 name (patrons)",
						usage: "!nip05 <name>",
						run: (c) => cmdNip05(c),
					},
				]
			: []),
		// `admin: true` both gates dispatch and hides the entry from !help for anyone
		// who isn't one, so a public channel never learns these exist.
		...(admin
			? [
					{
						name: "auth",
						desc: "redeem the admin code from the server console",
						usage: "!auth <code> · !auth who · !auth revoke <pubkey> · !auth clear · !auth rotate",
						run: (c) => cmdAuth(c),
					},
				]
			: []),
		...(admin
			? [
					{
						name: "shout",
						admin: true,
						desc: "broadcast into channels as they show activity",
						usage: "!shout <message> · !shout stop · !shout (status)",
						run: (c) => cmdShout(c),
					},
				]
			: []),
		...(admin && patrons?.configured && vault?.kind === "cashu"
			? [
					{
						name: "vault",
						admin: true,
						desc: "donation vault: balance, sweep, reconcile",
						usage: "!vault · !vault sweep [bolt11|address] · !vault reconcile",
						run: (c) => cmdVault(c),
					},
				]
			: []),
		{ name: "help", aliases: ["h", "commands"], desc: "list commands", usage: "!help · !help <command>", run: (c) => cmdHelp(c.geo, c.args[0], c.isAdmin) },
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
		// argStr keeps the raw remainder: `args` is split on whitespace, so joining it
		// back up collapses runs of spaces and flattens newlines. A shout is a message
		// someone composed, so it has to go out as they wrote it.
		const argStr = original.slice(parts[0].length).trim();
		return { command: byToken.get(token) || null, name: token, args: parts.slice(1), argStr };
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

	// run a resolved command; tolerates sync + async handlers. `meta` carries the
	// per-event bits a command may want (the delivering relay + receipt time for
	// !ping); most commands ignore it.
	function dispatch(parsed, geo, meta = {}) {
		const c = parsed.command;
		if (!c) return false;
		// Admin gating happens HERE rather than inside each handler, so a command
		// marked admin cannot be shipped with the check forgotten. A non-admin gets
		// silence, not a refusal: a public channel is the wrong place to confirm that
		// a privileged command exists and that you nearly reached it.
		const asAdmin = !!admin?.isAdmin(meta.ev?.pubkey);
		if (c.admin && !asAdmin) {
			console.log(`[bot] !${c.name} refused (not admin) from ${String(meta.ev?.pubkey || "?").slice(0, 12)}`);
			return false;
		}
		promoForReply = pickPromo(meta.ev); // decided once per command, from the triggering event's client tag
		Promise.resolve(c.run({ geo, args: parsed.args, argStr: parsed.argStr || "", ...meta, isAdmin: asAdmin })).catch((e) =>
			console.error(`[bot] !${c.name} failed:`, e.message),
		);
		return true;
	}

	// --- ingest hook ---------------------------------------------------------
	// called by the aggregator for each accepted LIVE chat event. Records activity
	// + language for every real message, and serves any `!command`. Backlog replays
	// (live=false) are never passed here, so the bot never answers stale history or
	// double-counts a relay's stored backlog.
	function observe(ev, geo, source) {
		const recvMs = Date.now(); // wall-clock receipt, captured first so !ping's delay excludes our own processing
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

		// after the visibility gate and the activity tracking, before dispatch: a
		// channel qualifies by having shown a real message, whether or not it was a
		// command, which is exactly the signal a shout wants.
		maybeShout(geo);

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
			dispatch(parsed, geo, { source, ev, recvMs });
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
			adminCommands: COMMANDS.filter((c) => c.admin).map((c) => c.name),
			trackedChannels: channelActivity.size,
			activeUsers: activePubkeys.size,
			languages: channelLanguage.size,
			recentBuffered: recentOther.length,
		};
	}

	return { observe, stats, announcePatron, get pubkey() { return pk; } };
}
