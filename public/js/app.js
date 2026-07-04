import {
	loadOrCreateIdentity,
	regenerateIdentity,
	candidateKeypair,
	adoptIdentity,
	skHexFromNsec,
	skToNsec,
	pkToNpub,
	getStoredName,
	setStoredName,
} from "./nostr/identity.js";
import { fetchRelayList } from "./nostr/relayList.js";
import { RelayPool } from "./nostr/relayPool.js";
import { makeChatMessage, makePresenceEvent, getGeohash, getName, CHAT_KIND, PRESENCE_KIND, sortRelaysByGeohash, verifyEvent } from "./nostr/protocol.js";
import { t, formatAgo, setLocale, detectLocale, onLocaleChange } from "./i18n/index.js";
import { createSuggest } from "./ui/suggest.js";
import { createDmClient, DM_MAX_CONTENT_BYTES } from "./nostr/dm.js";

const MAX_LINES = 600;
const NEAR_BOTTOM_PX = 60;
const MAX_GEO_LEN = 12; // geohash precision tops out here; clip the prefix so a huge "g" tag can't flood a line
const MAX_NAME_LEN = 22; // collapse longer names behind a "more" toggle
const MAX_MSG_LEN = 450; // collapse longer messages behind a "more" toggle
const HARD_MAX_MSG_LEN = 8000; // absolute ceiling, even when expanded, to bound DOM/memory
const MAX_IMAGES_PER_MESSAGE = 6; // anti-flood: cap how many previews one message can spam in
const MAX_FUTURE_SECS = 120; // drop events timestamped more than this far ahead (skewed/forged clocks)
const seen = new Set();
const entries = []; // [{ ts, geo, system, pubkey, html, el }], ascending by ts - all received messages

// groundwork for a future "/censor" command - for now images always start
// blurred and are revealed per-tap (see revealedImages below).
const mediaSettings = { censorImages: true };
const revealedImages = new Set(); // "entryId:idx" keys for images tapped open

let identity = loadOrCreateIdentity(); // mutable: /rotate and /import replace it
let name = getStoredName();
let focusedGeo = null;
let focusedUserCount = 0;
let allRelays = []; // [{ url, lat, lon }], populated after the CSV fetch resolves

let autoScroll = true; // stick to the bottom; false once the user scrolls up to read history
let unreadCount = 0; // messages arrived while scrolled up, shown in the banner

const nameGate = document.getElementById("nameGate");
const nameForm = document.getElementById("nameForm");
const nameInput = document.getElementById("nameInput");
const nameHint = document.getElementById("nameHint");
const settingsGate = document.getElementById("settingsGate");
const assistToggle = document.getElementById("assistToggle");
const profilesToggle = document.getElementById("profilesToggle");
const profilesRow = document.getElementById("profilesRow");
const nsecInput = document.getElementById("nsecInput");
const revealNsecBtn = document.getElementById("revealNsecBtn");
const copyNsecBtn = document.getElementById("copyNsecBtn");
const pasteNsecBtn = document.getElementById("pasteNsecBtn");
const nsecStatus = document.getElementById("nsecStatus");
const settingsClose = document.getElementById("settingsClose");
const usersGate = document.getElementById("usersGate");
const usersTitle = document.getElementById("usersTitle");
const usersList = document.getElementById("usersList");
const usersClose = document.getElementById("usersClose");
const profileGate = document.getElementById("profileGate");
const profileCard = document.getElementById("profileCard");
const profileBanner = document.getElementById("profileBanner");
const profileAvatar = document.getElementById("profileAvatar");
const profileName = document.getElementById("profileName");
const profileNostrName = document.getElementById("profileNostrName");
const profileNip05 = document.getElementById("profileNip05");
const profileAbout = document.getElementById("profileAbout");
const profileMeta = document.getElementById("profileMeta");
const profileNpub = document.getElementById("profileNpub");
const profileNpubKey = document.getElementById("profileNpubKey");
const profileNpubHint = document.getElementById("profileNpubHint");
const profileClose = document.getElementById("profileClose");
const terminal = document.getElementById("terminal");
const brandEl = document.getElementById("brand");
const statusEl = document.getElementById("status");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const mediaBtn = document.getElementById("mediaBtn");
const mediaFile = document.getElementById("mediaFile");
const newMessagesBar = document.getElementById("newMessagesBar");
const suggestBox = document.getElementById("suggestBox");
const dmPill = document.getElementById("dmPill");
const actionGate = document.getElementById("actionGate");
const actionTitle = document.getElementById("actionTitle");
const actionDm = document.getElementById("actionDm");
const actionClose = document.getElementById("actionClose");
const dmListGate = document.getElementById("dmListGate");
const dmListClose = document.getElementById("dmListClose");
const dmList = document.getElementById("dmList");
const dmGate = document.getElementById("dmGate");
const dmPeerName = document.getElementById("dmPeerName");
const dmClose = document.getElementById("dmClose");
const dmThread = document.getElementById("dmThread");
const dmInput = document.getElementById("dmInput");
const dmSendBtn = document.getElementById("dmSendBtn");

// pick the locale and fill the static markup before anything renders. en is the
// only bundled language today, so this is english; it's wired so adding a locale
// file is a drop-in. (no callbacks registered yet, so this only does the dom
// fill - dynamic views are re-rendered via onLocaleChange, registered below.)
setLocale(detectLocale());

// "server assist": optional API-backed history/low-bandwidth mode. Phase 0 only
// persists the preference - nothing reads it yet. Defaults ON (per the plan:
// assist-by-default with automatic fallback to pure client when unavailable).
const STORAGE_ASSIST_KEY = "glub_assist";

function getAssistEnabled() {
	return localStorage.getItem(STORAGE_ASSIST_KEY) !== "false";
}

function setAssistEnabled(on) {
	localStorage.setItem(STORAGE_ASSIST_KEY, on ? "true" : "false");
}

// nostr profiles (avatars + bios) are an opt-in extra that relies entirely on the
// api, so they're only ever enabled when server assist is too - and only actually
// usable once the api is reachable. off by default.
const STORAGE_PROFILES_KEY = "glub_profiles";

function getProfilesEnabled() {
	return getAssistEnabled() && localStorage.getItem(STORAGE_PROFILES_KEY) === "true";
}

function setProfilesEnabled(on) {
	localStorage.setItem(STORAGE_PROFILES_KEY, on ? "true" : "false");
}

function profilesActive() {
	return getProfilesEnabled() && apiAvailable;
}

// pubkey -> { name, about, nip05, hasAvatar, updated } | null (null = looked up, none found)
const profileCache = new Map();
const profileFetchedAt = new Map(); // pubkey -> ms we last resolved it (drives stale-while-revalidate)
const profileInflight = new Map(); // pubkey -> Promise (shared, so concurrent callers all get the result)
const CLIENT_FRESH_MS = 5 * 60_000; // re-check a cached profile at most this often, in the background

// fetch + cache a pubkey's profile via the api. stale-while-revalidate: a cached
// entry is handed back instantly, but once it ages past CLIENT_FRESH_MS the next
// call kicks a background refresh so profile edits surface without a session
// reload. concurrent calls share one request.
function fetchProfile(pubkey) {
	if (!profilesActive()) return Promise.resolve(null);
	if (profileCache.has(pubkey)) {
		const age = Date.now() - (profileFetchedAt.get(pubkey) || 0);
		if (age >= CLIENT_FRESH_MS && !profileInflight.has(pubkey)) revalidateProfile(pubkey);
		return Promise.resolve(profileCache.get(pubkey));
	}
	if (profileInflight.has(pubkey)) return profileInflight.get(pubkey);
	return revalidateProfile(pubkey);
}

// (re)fetch a profile from the api and update the cache; if it changed under us,
// repaint every surface showing it. shared across concurrent callers.
function revalidateProfile(pubkey) {
	const promise = (async () => {
		try {
			const res = await fetch(`${API_BASE}/api/profile?pubkey=${pubkey}`, { cache: "no-store" });
			// on a transient failure keep whatever we already had (don't wipe it) and
			// leave it "stale" so a later call retries.
			if (!res.ok) return profileCache.has(pubkey) ? profileCache.get(pubkey) : null;
			const data = await res.json();
			const profile = data.profile || null;
			const changed = profileChanged(profileCache.get(pubkey), profile);
			profileCache.set(pubkey, profile);
			profileFetchedAt.set(pubkey, Date.now());
			if (changed) repaintProfile(pubkey);
			return profile;
		} catch {
			return profileCache.has(pubkey) ? profileCache.get(pubkey) : null;
		} finally {
			profileInflight.delete(pubkey);
		}
	})();
	profileInflight.set(pubkey, promise);
	return promise;
}

// did a background refresh actually change what we'd render? `prev === undefined`
// means this is the first load (callers handle that render themselves), so it's
// not a "change". otherwise the profile's revision token (kind-0 created_at) is
// the canonical signal - it bumps on every edit - plus any null<->profile flip.
function profileChanged(prev, next) {
	if (prev === undefined) return false;
	if (!prev !== !next) return true; // gained or lost a profile entirely
	if (!prev && !next) return false;
	return (prev.updated || 0) !== (next.updated || 0);
}

// a profile changed under us (via background revalidation) - repaint the surfaces
// that show it: chat lines by this author, the users list if open, and the
// profile card if it's currently showing this pubkey.
function repaintProfile(pubkey) {
	for (const entry of entries) {
		if (!entry.system && entry.pubkey === pubkey && entry.el) rerenderEntryEl(entry);
	}
	if (usersGate.classList.contains("show")) openUsers();
	if (openProfilePubkey === pubkey && profileGate.classList.contains("show")) openProfileCard(pubkey);
}

// the optional "server assist" history API. Same-origin "/api" by default
// (reverse-proxy it next to the static files); point window.GLUB_API_BASE at a
// separately-hosted instance to override. When assist is on and the api is
// healthy the client mirrors the api's buffer + live stream and uses relays for
// sending only; otherwise it runs as a pure client on direct relay subscriptions.
const API_BASE = (typeof window !== "undefined" && window.GLUB_API_BASE ? String(window.GLUB_API_BASE) : "").replace(/\/+$/, "");
const BUFFER_FETCH = 600; // how much of the api buffer the client mirrors on connect
const ASSIST_FALLBACK_MS = 12_000; // grace period before a dead stream falls back to relays
const ASSIST_MAINTAIN_MS = 30_000; // health re-check cadence (status freshness + recovery)
const ACK_TIMEOUT_MS = 15_000; // wait this long for an echo before rebroadcasting / giving up
const MAX_SEND_ATTEMPTS = 3; // initial broadcast + up to 2 automatic rebroadcasts
const PRESENCE_FRESH_MS = 5 * 60_000; // a user counts as "present" within this window (fresh message or presence)
const PRESENCE_TICK_MS = 30_000; // re-evaluate presence/count on this cadence so stale users drop off without new activity
// how often WE announce our own presence in the channel we're viewing. a semi-
// random interval (per bitchat) so clients don't all heartbeat in lockstep.
const PRESENCE_BROADCAST_MIN_MS = 47_000;
const PRESENCE_BROADCAST_MAX_MS = 60_000;
const MEDIA_MAX_MB = 10; // client-side pre-check; the api enforces its own limit too
const MEDIA_MAX_DIMENSION = 2048; // static images are downscaled to fit this before upload
const SYSTEM_TTL_MS = 7_000; // default lifetime of an ephemeral status notice before it fades
const SYSTEM_TTL_LONG_MS = 30_000; // for notices worth reading unrushed (e.g. /help output)
const SYSTEM_FADE_MS = 300; // fade-out duration before the faded line is removed (matches css)

// presences we've detected from kind-20001 events on the relays we read (relay
// mode only - in assist mode the api tracks these and we fetch a snapshot).
// geo -> Map<pubkey, { name, teleport, createdAt, lastSeen }>. Used to list "lurkers" who
// announce their presence without sending a message.
const presence = new Map();

// our own sent messages awaiting echo-back confirmation, keyed by event id:
// { event, firstSentAt, attempts, timer }. When a live source (the api stream or
// relays) replays the message we know it propagated; until then we rebroadcast
// the identical signed event (relays dedup by id) up to MAX_SEND_ATTEMPTS.
const pending = new Map();

let apiAvailable = false;
let apiHealth = null; // last /api/health payload (events count, relay stats)
let liveSource = "relays"; // "relays" | "assist" - where live events currently come from
let eventSource = null; // the SSE connection while in assist mode
let assistFallbackTimer = null;
let barrierShown = false; // "beginning of chat" marker rendered once per session
let clearedBefore = 0; // /clear cutoff (epoch secs): entries older than this are filtered from view
const mutedChannels = new Set(); // /mute geohashes hidden from the global feed. session-only - never persisted, so a refresh clears them

function escapeHtml(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
	);
}

function clipText(str, max) {
	if (!str) return "";
	return str.length > max ? str.slice(0, max - 3) + "..." : str;
}


function clipWithEllipsis(str, max) {
	if (!str) return "";
	return str.length > max ? str.slice(0, max) + "..." : str;
}

function escapeRegExp(str) {
	return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// bitchat-style action/emote: "* did something *" (spaces required, like /me).
function isActionMessage(text) {
	return /^\*\s+[\s\S]+?\s+\*$/.test(String(text || "").trim());
}

function extractUrls(text) {
	return String(text || "").match(/\bhttps?:\/\/[^\s<]+/gi) || [];
}

function isDirectImageUrl(url) {
	const clean = String(url).split("?")[0].split("#")[0].toLowerCase();
	return /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(clean);
}

// direct image links in a message's content, capped against link-spam
function extractImageUrls(text) {
	return extractUrls(text).filter(isDirectImageUrl).slice(0, MAX_IMAGES_PER_MESSAGE);
}

// true if text @-mentions the current user: "@name" optionally followed by the
// "#xxxx" pubkey suffix, bounded so "@names" or "@nameother" don't false-match.
function isMention(text, currentName) {
	const n = (currentName || "").trim();
	if (!n) return false;
	const pattern = new RegExp(
		`(^|[^a-z0-9_.-])@${escapeRegExp(n)}(?:#[a-z0-9]{4})?(?![a-z0-9_.-])`,
		"i"
	);
	return pattern.test(String(text || ""));
}

// [hh:mm:ss] in the device's local time, 24-hour. tsSec is in seconds.
function formatTime(tsSec) {
	return new Date(tsSec * 1000).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function timeTag(tsSec) {
	return ` <span class="ts">[${formatTime(tsSec)}]</span>`;
}

// turns URLs and inline #geohash tokens in already-escaped text into clickable
// elements. URLs first, then #geohashes; the geohash match requires the # to
// follow whitespace/start so it won't grab a URL's #fragment or a name#tag.
function linkify(safe) {
	let html = safe.replace(
		/\bhttps?:\/\/[^\s<]+/gi,
		(url) => `<a class="inlineLink" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
	);
	html = html.replace(
		/(^|[\s([{"'])#([a-z0-9]{1,12})\b/gi,
		(m, prefix, geo) => `${prefix}<span class="inlineGeo" data-geo="${geo.toLowerCase()}">#${geo}</span>`
	);
	return html;
}

function entryVisible(entry) {
	if (entry.ts < clearedBefore) return false; // hidden by /clear (local view filter)
	if (entry.system) return true;
	if (focusedGeo) return entry.geo === focusedGeo; // focused: just this channel (mutes don't apply - you opened it on purpose)
	return !mutedChannels.has(entry.geo); // global feed: drop muted channels
}

// builds a message line's inner html (everything after the optional #geo prefix)
// from its stored fields, collapsing an over-long name or message behind a
// "more"/"less" toggle so a single huge message can't blow out the view.
function messageInnerHtml(entry) {
	const expanded = entry.expanded;
	const text = expanded ? entry.text : clipWithEllipsis(entry.text, MAX_MSG_LEN);
	// your own color depends on the live profiles state (orange vs. real per-key
	// color), so recompute it each render; peers' colors never change (baked).
	const color = entry.mine ? pubkeyColor(entry.pubkey) : entry.color;

	let body;
	let needsToggle = entry.text.length > MAX_MSG_LEN;

	if (entry.action) {
		// emote: the whole "* ... *" rendered muted like a timestamp, no username
		body = `<span class="ts">${linkify(escapeHtml(text))}</span>`;
	} else {
		const who = expanded ? entry.who : clipWithEllipsis(entry.who, MAX_NAME_LEN);
		needsToggle = needsToggle || entry.who.length > MAX_NAME_LEN;
		// the name (avatar + @handle#tag) is a tap target: tapping it opens the
		// per-user action popup (DM etc). data-user carries the full pubkey.
		body =
			`<span class="nameTap" data-user="${escapeHtml(entry.pubkey)}">` +
			avatarHtml(entry.pubkey, { inline: true }) + // nostr avatar prefixing the name, if any
			`<span class="bracket" style="color:${color}">&lt;</span>` +
			`<span class="user" style="color:${color}">@${escapeHtml(who)}</span>` +
			`<span class="tag" style="color:${color}">#${escapeHtml(entry.tag)}</span>` +
			`<span class="bracket" style="color:${color}">&gt;</span>` +
			`</span> ` +
			`<span class="msg" style="color:${color}">${linkify(escapeHtml(text))}</span>`;
	}

	if (needsToggle) {
		body += `<span class="toggleMore" data-toggle="${escapeHtml(entry.id)}">${escapeHtml(t(expanded ? "message.less" : "message.more"))}</span>`;
	}

	body += renderImagePreviews(entry);

	return body + timeTag(entry.ts) + ackTag(entry);
}

// send-confirmation badge for our own messages, styled like the timestamp:
// blank on the first in-flight attempt, "resending…" once we start rebroadcasting
// (the first attempt timed out without an echo), the round-trip latency once a
// source replays it ("<1s" / "4s"), or "failed" if every attempt was exhausted
// and it never came back.
function ackTag(entry) {
	if (!entry.mine) return "";
	if (entry.ackSecs != null) {
		const latency = entry.ackSecs === 0 ? t("ack.latency_lt1s") : t("ack.latency_secs", { count: entry.ackSecs });
		return ` <span class="ts ack">${escapeHtml(latency)}</span>`;
	}
	if (entry.ackFailed) return ` <span class="ts ack ackFail">${escapeHtml(t("ack.failed"))}</span>`;
	if (entry.resending) return ` <span class="ts ack">${escapeHtml(t("ack.resending"))}</span>`;
	return ""; // first attempt in flight: stay blank until it confirms / retries / fails
}

// one preview block per image url in the message, blurred by default with a
// tap-to-reveal overlay (bitchat-style); tapping again re-blurs it.
function renderImagePreviews(entry) {
	if (!entry.images || !entry.images.length) return "";

	return entry.images
		.map((url, idx) => {
			const safeUrl = escapeHtml(url);

			if (!mediaSettings.censorImages) {
				return `<div class="mediaPreview"><img class="chatImagePreview" src="${safeUrl}" alt="image preview" loading="lazy"></div>`;
			}

			const key = `${entry.id}:${idx}`;
			if (revealedImages.has(key)) {
				return `<div class="mediaPreview" data-img-toggle="${escapeHtml(key)}"><img class="chatImagePreview" src="${safeUrl}" alt="image preview" loading="lazy"></div>`;
			}

			return (
				`<div class="mediaPreview" data-img-toggle="${escapeHtml(key)}">` +
				`<img class="chatImagePreview chatImagePreviewCensored" src="${safeUrl}" alt="image preview" loading="lazy">` +
				`<div class="mediaCensorOverlay">${escapeHtml(t("message.reveal"))}</div></div>`
			);
		})
		.join("");
}

// renders one entry's DOM node into the terminal at the correct chronological
// position among the other currently-visible (filter-matching) entries.
// `animate` plays the arrival fade - live inserts only, so rerenders (channel
// hops, repaints) never re-animate the whole backlog.
function renderEntryDom(entry, animate = false) {
	const div = document.createElement("div");
	div.className = entry.mention ? "line mention" : "line";
	if (animate) div.className += " arrive";
	// bold "you" only in the orange self-view; with profiles on you blend in as a
	// normal peer (bolding stays tied to the same signal as the orange color).
	if (entry.mine && !profilesActive()) div.className += " mine";
	if (entry.system) div.className += " system";
	if (entry.mentionTint) div.style.background = entry.mentionTint;
	// the #geo prefix is redundant in a focused channel (every line is that
	// channel), so only prepend it in global view.
	const body = entry.system ? entry.html : messageInnerHtml(entry);
	div.innerHTML = (focusedGeo ? "" : entry.geoPrefix || "") + body;
	entry.el = div;

	const idx = entries.indexOf(entry);
	let nextEl = null;
	for (let i = idx + 1; i < entries.length; i++) {
		if (entries[i].el) {
			nextEl = entries[i].el;
			break;
		}
	}

	if (nextEl) terminal.insertBefore(div, nextEl);
	else terminal.appendChild(div);
}

function isNearBottom() {
	return terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - NEAR_BOTTOM_PX;
}

function scrollToBottom() {
	terminal.scrollTop = terminal.scrollHeight;
}

function updateNewMessagesBar() {
	if (unreadCount <= 0) {
		newMessagesBar.hidden = true;
		return;
	}
	newMessagesBar.hidden = false;
	newMessagesBar.textContent = t("message.new_messages", { count: unreadCount });
}

function clearUnread() {
	unreadCount = 0;
	updateNewMessagesBar();
}

function jumpToBottom() {
	autoScroll = true;
	clearUnread();
	scrollToBottom();
}

// rebuilds the visible terminal from `entries` under the current filter -
// used when entering/exiting a focused channel.
function rerenderTerminal() {
	terminal.innerHTML = "";
	for (const entry of entries) entry.el = null;
	for (const entry of entries) {
		if (entryVisible(entry)) renderEntryDom(entry);
	}
	jumpToBottom();
}

// inserts a new entry in chronological order by ts (relay backlog can arrive
// out of order), renders it if it matches the current channel filter, and
// evicts the oldest entry once the buffer exceeds MAX_LINES.
function insertEntry(entry) {
	let lo = 0, hi = entries.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (entries[mid].ts <= entry.ts) lo = mid + 1;
		else hi = mid;
	}
	entries.splice(lo, 0, entry);

	while (entries.length > MAX_LINES) {
		const oldest = entries.shift();
		if (oldest.el) oldest.el.remove();
	}

	if (entryVisible(entry)) {
		renderEntryDom(entry, true);
		if (autoScroll) {
			scrollToBottom();
		} else {
			unreadCount += 1;
			updateNewMessagesBar();
		}
	}

	if (focusedGeo && !entry.system && entry.geo === focusedGeo) {
		updateFocusedUserCount();
		renderTopbar();
	}
}

// low-level: push an ephemeral system entry with pre-built html. these auto-
// dismiss with a short fade so hopping between channels doesn't pile up a wall of
// stale notices. `ttl` (ms) overrides how long it persists before fading; omit it
// for the default. The "beginning of chat" barrier is inserted directly (not
// here) and is intentionally not affected.
function pushSystem(html, ttl = SYSTEM_TTL_MS) {
	const entry = { ts: Date.now() / 1000, geo: null, system: true, pubkey: null, html, el: null };
	insertEntry(entry);
	setTimeout(() => dismissEntry(entry), ttl);
	return entry;
}

// a one-line status notice in bitchat's emote style (* muted text *). `ttl` (ms)
// optionally overrides the default lifetime.
function appendSystem(text, ttl) {
	const ts = Date.now() / 1000;
	pushSystem(`<span class="ts">* ${escapeHtml(text)} *</span>${timeTag(ts)}`, ttl);
}

// fade an entry out and drop it from the log. No-ops if it's already gone (e.g.
// pruned by MAX_LINES or cleared on a channel switch).
function dismissEntry(entry) {
	const idx = entries.indexOf(entry);
	if (idx === -1) return;
	entries.splice(idx, 1);
	const el = entry.el;
	if (!el) return;
	el.classList.add("fading");
	setTimeout(() => el.remove(), SYSTEM_FADE_MS);
}

// Apple's system orange (SwiftUI's Color.orange), reserved for the current
// user. Native bitchat always renders "you" in orange and deliberately steers
// every other user's hue away from orange (see the avoidance below) so the
// color stays unique to you.
const SELF_RGB = { r: 255, g: 149, b: 0 };

// DJB2 hash over a string's UTF-8 bytes, in a wrapping UInt64 - the exact hash
// bitchat uses (String+DJB2.swift). BigInt gives us the 64-bit overflow.
function djb2(str) {
	let h = 5381n;
	const mask = 0xFFFFFFFFFFFFFFFFn;
	for (const b of new TextEncoder().encode(str)) {
		h = ((h << 5n) + h + BigInt(b)) & mask; // h*33 + b
	}
	return h;
}

// HSB/HSV -> { r, g, b } (0-255). SwiftUI's Color(hue:saturation:brightness:)
// is HSB, not CSS's HSL, so we convert here rather than emitting hsl().
function hsbToRgb(h, s, v) {
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);
	let r, g, b;
	switch (i % 6) {
		case 0: r = v; g = t; b = p; break;
		case 1: r = q; g = v; b = p; break;
		case 2: r = p; g = v; b = t; break;
		case 3: r = p; g = q; b = v; break;
		case 4: r = t; g = p; b = v; break;
		default: r = v; g = p; b = q; break;
	}
	return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// bitchat's exact per-user color (Color+Peer.swift, geohash/Nostr path):
// DJB2 of "nostr:" + lowercased pubkey hex, hue from the hash with orange
// steered away, and saturation/brightness also pulled from other bit-slices of
// the same hash. We render dark-mode only, so the isDark=true constants apply.
// the per-key color derived purely from the hash - the color everyone (yourself
// included) is seen as by others. self-agnostic on purpose.
function peerRgb(pubkey) {
	const h = djb2("nostr:" + pubkey.toLowerCase());

	let hue = Number(h % 1000n) / 1000;
	const orange = 30 / 360;
	if (Math.abs(hue - orange) < 0.05) hue = (hue + 0.12) % 1.0; // avoid orange (reserved for "you")

	const sRand = Number((h >> 17n) & 0x3ffn) / 1023;
	const bRand = Number((h >> 27n) & 0x3ffn) / 1023;
	const saturation = Math.min(1, Math.max(0.5, 0.8 + (sRand - 0.5) * 0.2));
	const brightness = Math.min(1, Math.max(0.35, 0.75 + (bRand - 0.5) * 0.16));

	return hsbToRgb(hue, saturation, brightness);
}

function pubkeyRgb(pubkey) {
	// "you" render in bitchat's reserved orange - but only until nostr profiles are
	// active. once your identity is legible (avatar/name/npub on show), you appear
	// in your real per-key color, exactly as everyone else already sees you.
	if (pubkey.toLowerCase() === identity.pk.toLowerCase() && !profilesActive()) return SELF_RGB;
	return peerRgb(pubkey);
}

function pubkeyColor(pubkey) {
	const { r, g, b } = pubkeyRgb(pubkey);
	return `rgb(${r}, ${g}, ${b})`;
}

// translucent version of the sender's color, for tinting their mention highlight
function pubkeyTint(pubkey) {
	const { r, g, b } = pubkeyRgb(pubkey);
	return `rgba(${r}, ${g}, ${b}, 0.16)`;
}

function renderEvent(ev) {
	const geo = getGeohash(ev) || "?";
	const who = getName(ev) || "anon";
	const tag = ev.pubkey.slice(-4);
	const text = String(ev.content || "").slice(0, HARD_MAX_MSG_LEN);
	const color = pubkeyColor(ev.pubkey);

	// clip only the *displayed* geohash so an oversized "g" tag can't flood a
	// line; data-geo keeps the full value so clicking still focuses the real
	// channel (an actually-invalid geohash is caught by focusChannel).
	const geoPrefix = `<span class="geo" data-geo="${escapeHtml(geo)}">#${escapeHtml(clipWithEllipsis(geo, MAX_GEO_LEN))}</span> `;

	// highlight messages that @-mention us, tinted with the sender's own color
	// so it stays visually cohesive (includes our own messages @-ing ourselves).
	const mention = isMention(text, name);
	const mentionTint = mention ? pubkeyTint(ev.pubkey) : null;

	// "teleport" = sender isn't physically in the geohash (every glub send is; a
	// native bitchat client physically present omits it = "local")
	const teleport = Array.isArray(ev.tags) && ev.tags.some((t) => t[0] === "t" && t[1] === "teleport");

	const entry = {
		ts: ev.created_at,
		geo,
		system: false,
		pubkey: ev.pubkey,
		id: ev.id,
		who,
		tag,
		text,
		color,
		geoPrefix,
		mention,
		mentionTint,
		teleport,
		mine: ev.pubkey.toLowerCase() === identity.pk.toLowerCase(), // bitchat bolds your own messages
		pendingAck: pending.has(ev.id), // a message we just sent, awaiting echo-back confirmation
		action: isActionMessage(text),
		images: extractImageUrls(text),
		expanded: false,
		el: null,
	};
	insertEntry(entry);

	// inline avatar: if profiles are on and we don't know this author yet, fetch
	// their profile and repaint the line once it (maybe) has an avatar. concurrent
	// messages from the same author share one request via fetchProfile.
	if (!entry.action && profilesActive() && !profileCache.has(ev.pubkey)) {
		fetchProfile(ev.pubkey).then((p) => {
			if (p && p.hasAvatar && entry.el) rerenderEntryEl(entry);
		});
	}
}

// pubkey -> their latest message entry in `geo`. Pass `withinMs` to keep only
// recent talkers (the "active now" count); omit it for the full roster - the
// list shows everyone who's talked here, even if they've since gone quiet.
function talkers(geo, withinMs) {
	const cutoff = withinMs ? Math.floor(Date.now() / 1000) - withinMs / 1000 : -Infinity;
	const latest = new Map();
	for (const e of entries) {
		if (e.system || e.geo !== geo || e.ts < cutoff) continue;
		const prev = latest.get(e.pubkey);
		if (!prev || e.ts >= prev.ts) latest.set(e.pubkey, e);
	}
	return latest;
}

function updateFocusedUserCount() {
	if (!focusedGeo) {
		focusedUserCount = 0;
		return;
	}
	// count only the actively-present (talked within the freshness window) users;
	// the list itself still shows quieter talkers, they just don't tally here.
	focusedUserCount = talkers(focusedGeo, PRESENCE_FRESH_MS).size;
}

function renderTopbar() {
	syncMediaBtn(); // renderTopbar fires on every mode/status change, so piggyback
	const cursor = `<span class="cursor" aria-hidden="true"></span>`;
	if (focusedGeo) {
		const clippedGeo = clipText(focusedGeo, 12);
		brandEl.innerHTML = `<strong>#${escapeHtml(clippedGeo)}</strong>/<span class="handle">@${escapeHtml(clipText(name || "anon", 12))}</span>${cursor}`;

		statusEl.innerHTML = `<span class="tapUsers">${escapeHtml(t("topbar.users", { count: focusedUserCount }))}</span> - <strong>${escapeHtml(t("topbar.exit"))}</strong>`;
		statusEl.classList.add("tapExit");
	} else {
		brandEl.innerHTML = `<strong>GLUB.CHAT</strong>/<span class="handle">@${escapeHtml(clipText(name || "anon", 12))}</span>${cursor}`;
		statusEl.classList.remove("tapExit");

		// relay link state: solid dot while we hold connections, dim pulse while not
		const r = liveSource === "assist" ? apiHealth?.relays : null;
		const connected = r ? r.connected : pool.connectedCount;
		const total = r ? r.monitored : pool.total;
		const left = connected == null || connected === 0 ? "--" : connected;
		const right = total == null || total === 0 ? "--" : total;
		const dot = `<span class="dot${left === "--" ? " off" : ""}" aria-hidden="true"></span>`;
		statusEl.innerHTML = `${dot}<strong>${escapeHtml(t("topbar.relays"))}</strong>: ${left}/${right}`;
	}
}

// your own #suffix (last 4 of your pubkey) - re-derived when the identity changes
let ownSuffix = identity.pk.slice(-4);

// ghost-text in the name gate: appends a dimmed "#suffix" after whatever you're
// typing, previewing how your handle will appear. Hidden while the field is
// empty so it doesn't fight the placeholder.
function updateNameHint() {
	const v = nameInput.value;
	if (!v) {
		nameHint.innerHTML = "";
		return;
	}
	nameHint.innerHTML =
		`<span class="typed">${escapeHtml(v)}</span>` +
		`<span class="sfx">#${escapeHtml(ownSuffix)}</span>`;
}

nameInput.addEventListener("input", updateNameHint);

// play the typewriter reveal once per session, the first time the gate opens.
// it's a class-triggered CSS animation (see .typing in the stylesheet) rather
// than a display-toggle one, so it fires reliably; and because the mask defaults
// to off, skipping it just leaves the manifesto plainly visible.
let nameGateTyped = false;

function openNameGate() {
	nameInput.value = name || "";
	updateNameHint();
	nameGate.classList.add("show");
	if (!nameGateTyped) {
		nameGateTyped = true;
		nameGate.classList.add("typing");
	}
	setTimeout(() => nameInput.focus(), 0);
}

function closeNameGate() {
	nameGate.classList.remove("show");
}

// the nostr-profiles row is inert unless server assist is on (it relies on the api)
function syncProfilesRow() {
	const enabled = getAssistEnabled();
	profilesToggle.disabled = !enabled;
	profilesRow.classList.toggle("disabled", !enabled);
}

function openSettings() {
	assistToggle.checked = getAssistEnabled();
	profilesToggle.checked = getProfilesEnabled();
	syncProfilesRow();
	nsecRevealed = false;
	renderNsecField();
	setNsecStatus("");
	settingsGate.classList.add("show");
}

function closeSettings() {
	settingsGate.classList.remove("show");
	nsecRevealed = false;
	renderNsecField(); // re-censor so a revealed key isn't left in the dom
}

// the nsec field always shows your current key, censored to the last 4 chars;
// "reveal" toggles the full value.
let nsecRevealed = false;

function censorNsec(nsec) {
	// reveal the first few chars (every nsec starts "nsec1", so this leaks almost
	// nothing) and star out the rest - phosphor-terminal flavored.
	return nsec.slice(0, 7) + "*".repeat(14);
}

function renderNsecField() {
	const nsec = skToNsec(identity.sk);
	nsecInput.value = nsecRevealed ? nsec : censorNsec(nsec);
	revealNsecBtn.textContent = t(nsecRevealed ? "settings.hide_nsec" : "settings.reveal_nsec");
}

function setNsecStatus(text, kind) {
	nsecStatus.textContent = text;
	nsecStatus.className = `idStatus ${kind || ""}`;
}

revealNsecBtn.addEventListener("click", () => {
	nsecRevealed = !nsecRevealed;
	setNsecStatus(""); // don't leave feedback overlapping a revealed key
	renderNsecField();
});

// copy the current identity's nsec (backup / move to another client). the raw key
// only touches the clipboard on this explicit tap.
copyNsecBtn.addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(skToNsec(identity.sk));
		setNsecStatus(t("system.nsec_copied"), "ok");
	} catch {
		setNsecStatus(t("system.nsec_copy_failed"), "err");
	}
});

// paste an nsec from the clipboard and adopt it - keeps your display name, stays
// entirely client-side. the field re-renders (re-censored) to the new key.
pasteNsecBtn.addEventListener("click", async () => {
	let text;
	try {
		text = await navigator.clipboard.readText();
	} catch {
		setNsecStatus(t("system.nsec_paste_failed"), "err");
		return;
	}
	const nsec = (text || "").trim();
	if (!nsec) return;
	try {
		applyIdentity(adoptIdentity(skHexFromNsec(nsec)));
		nsecRevealed = false;
		renderNsecField();
		setNsecStatus(t("system.nsec_imported"), "ok");
	} catch {
		setNsecStatus(t("system.nsec_invalid"), "err");
	}
});

// avatar for a pubkey: the cached profile's proxied image if it has one. `inline`
// styles it for a chat line (vs a users-tab row). `placeholder` reserves blank
// space when there's no avatar (for row alignment); off (chat) shows nothing.
function avatarHtml(pubkey, { inline = false, placeholder = false } = {}) {
	if (!profilesActive()) return "";
	const cls = inline ? "avatar avatarInline" : "avatar";
	const cached = profileCache.get(pubkey);
	if (cached && cached.hasAvatar) {
		return `<img class="${cls}" src="${API_BASE}/api/avatar?pubkey=${pubkey}&v=${cached.updated || 0}" alt="" loading="lazy" />`;
	}
	return placeholder ? `<span class="avatar avatarBlank"></span>` : "";
}

function userRowHtml(u, avatarColumn) {
	const ago = u.ts ? `<span class="userAgo">${escapeHtml(formatAgo(u.ts))}</span>` : "";
	const origin = u.teleport ? t("origin.teleport") : t("origin.local");
	return (
		`<div class="userRow" data-pubkey="${escapeHtml(u.pubkey)}">` +
		`<span class="userMeta">` +
		avatarHtml(u.pubkey, { placeholder: avatarColumn }) +
		`<span style="color:${u.color}">@${escapeHtml(clipText(u.who, 22))}<span class="sfx">#${escapeHtml(u.tag)}</span></span>` +
		ago +
		`</span>` +
		`<span class="userOrigin ${u.teleport ? "teleport" : "local"}">${escapeHtml(origin)}</span>` +
		`</div>`
	);
}

// present (lurking) users come from kind-20001 snapshots; shape them like talking
// rows and drop anyone already shown above as actively talking.
function presentRows(snapshot, excludePubkeys) {
	return snapshot
		.filter((p) => p && typeof p.pubkey === "string" && !excludePubkeys.has(p.pubkey))
		.map((p) => ({
			pubkey: p.pubkey,
			who: p.name || "anon",
			tag: p.pubkey.slice(-4),
			color: pubkeyColor(p.pubkey),
			teleport: !!p.teleport,
			ts: p.createdAt, // heartbeat time, for the "x ago" badge
		}));
}

function renderUsers(talking, present) {
	// only reserve the left avatar column when someone in the list actually has a
	// picture. most users are burner keys with no nostr profile, so without this
	// the whole list would be permanently indented for avatars nobody has.
	const avatarColumn = [...talking, ...present].some((u) => {
		const cached = profileCache.get(u.pubkey);
		return cached && cached.hasAvatar;
	});

	let html = "";
	if (talking.length) {
		html += `<div class="usersBarrier">${escapeHtml(t("users.present"))}</div>`;
		html += talking.map((u) => userRowHtml(u, avatarColumn)).join("");
	}
	if (present.length) {
		html += `<div class="usersBarrier">${escapeHtml(t("users.ghosts", { count: present.length }))}</div>`;
		html += present.map((u) => userRowHtml(u, avatarColumn)).join("");
	}
	usersList.innerHTML = html;
}

// snapshot of who's in the focused channel: actively-talking users (latest
// message per pubkey, freshest first) at the top, then a barrier, then users
// we've only detected via presence (kind-20001) heartbeats - "lurkers". In assist
// mode the api supplies the presence snapshot; in relay mode we use the 20001
// events we read directly.
async function openUsers() {
	if (!focusedGeo) return;
	const geo = focusedGeo;

	const latest = talkers(geo); // full roster - everyone who's talked here stays listed
	const talking = [...latest.values()].sort((a, b) => b.ts - a.ts);
	const talkingPubkeys = new Set(latest.keys());
	talkingPubkeys.add(identity.pk); // never show yourself as a ghost (assist snapshot includes you)

	usersTitle.textContent = t("users.title", { geo: clipText(geo, 14) });
	showUsers(geo, talking, presentRows(localPresence(geo), talkingPubkeys));
	usersGate.classList.add("show");

	if (liveSource === "assist") {
		try {
			const res = await fetch(`${API_BASE}/api/presence?geo=${encodeURIComponent(geo)}`, { cache: "no-store" });
			if (!res.ok) return;
			const data = await res.json();
			// still on the same channel + panel open? then merge the api snapshot
			if (focusedGeo === geo && usersGate.classList.contains("show") && Array.isArray(data.users)) {
				showUsers(geo, talking, presentRows(data.users, talkingPubkeys));
			}
		} catch {
			// keep the synchronous (local) render
		}
	}
}

// the users panel's current state, so async profile hydration always re-renders
// the latest lists (not a stale snapshot captured before the api presence merge).
let currentUsers = { geo: null, talking: [], present: [] };

function showUsers(geo, talking, present) {
	currentUsers = { geo, talking, present };
	renderUsers(talking, present);
	hydrateProfiles();
}

// fetch profiles for the users shown, then re-render once so their avatars appear.
// no-op when profiles are inactive or everyone's already cached.
function hydrateProfiles() {
	if (!profilesActive()) return;
	const { geo, talking, present } = currentUsers;
	const all = [...new Set([...talking, ...present].map((u) => u.pubkey))];
	// run every shown profile through fetchProfile: cold ones get fetched, warm-but-
	// stale ones get a background revalidate (they repaint themselves on change).
	all.forEach((pk) => fetchProfile(pk));
	// the cold ones additionally need one render here so their avatars first appear.
	const cold = all.filter((pk) => !profileCache.has(pk));
	if (!cold.length) return;
	Promise.allSettled(cold.map((pk) => fetchProfile(pk))).then(() => {
		if (focusedGeo === currentUsers.geo && usersGate.classList.contains("show")) {
			renderUsers(currentUsers.talking, currentUsers.present);
		}
	});
}

let openProfilePubkey = null; // pubkey the profile card is currently showing (for background repaints)

// nostr profile card: tap a user to see their avatar + bio (profiles must be on).
async function openProfileCard(pubkey) {
	if (!profilesActive()) return;
	openProfilePubkey = pubkey;
	const entry = entries.find((e) => !e.system && e.pubkey === pubkey);
	const who = entry ? entry.who : profileCache.get(pubkey)?.name || "anon";
	profileName.innerHTML =
		`<span style="color:${pubkeyColor(pubkey)}">@${escapeHtml(clipText(who, 24))}` +
		`<span class="sfx">#${escapeHtml(pubkey.slice(-4))}</span></span>`;
	// the npub is derived straight from the pubkey (no profile needed), so show it
	// right away - it's how people look this identity up on other nostr clients.
	const npub = pkToNpub(pubkey);
	profileNpub.dataset.npub = npub;
	profileNpubKey.textContent = `${npub.slice(0, 12)}…${npub.slice(-8)}`;
	profileNpubHint.textContent = t("settings.copy_nsec");
	profileNpub.hidden = false;
	profileNostrName.textContent = "";
	profileNip05.textContent = "";
	profileAbout.textContent = t("profile.loading");
	profileMeta.innerHTML = "";
	profileAvatar.hidden = true;
	profileBanner.hidden = true;
	profileBanner.classList.remove("bannerTall"); // recomputed per banner once it loads
	profileCard.classList.remove("hasBanner");
	profileCard.scrollTop = 0;
	profileGate.classList.add("show");

	const profile = await fetchProfile(pubkey);
	if (!profileGate.classList.contains("show")) return; // dismissed while loading

	const rev = profile ? profile.updated || 0 : 0; // busts the browser image cache when the profile is edited
	if (profile && profile.hasAvatar) {
		profileAvatar.src = `${API_BASE}/api/avatar?pubkey=${pubkey}&v=${rev}`;
		profileAvatar.hidden = false;
	}
	if (profile && profile.hasBanner) {
		// once we know the banner's real dimensions, tall (portrait) ones switch to
		// fit-to-width so they show fully without side bars; wide ones keep the
		// default capped/contain rendering untouched.
		profileBanner.onload = () => {
			// anything not strictly wider than it is tall (portrait or square) would
			// otherwise get side bars - fit those to the width instead.
			profileBanner.classList.toggle("bannerTall", profileBanner.naturalHeight >= profileBanner.naturalWidth);
		};
		profileBanner.src = `${API_BASE}/api/banner?pubkey=${pubkey}&v=${rev}`;
		profileBanner.hidden = false;
		profileCard.classList.add("hasBanner"); // overlaps the avatar onto the banner
	}
	// their actual nostr display name as a secondary line - but only when it adds
	// something (present and not just the same as the channel handle they go by here)
	const nostrName = (profile && profile.name) || "";
	profileNostrName.textContent = nostrName && nostrName.toLowerCase() !== who.toLowerCase() ? nostrName : "";
	profileNip05.textContent = profile && profile.nip05 ? profile.nip05 : "";
	// "no nostr profile" is only for a genuinely empty identity. any scrap of
	// metadata - a name, avatar, banner, nip05, website, or zap address - means
	// they have a profile, so a missing bio just shows no about line (it collapses)
	// rather than the "none" placeholder.
	const hasProfileContent =
		profile &&
		(profile.about || profile.name || profile.nip05 || profile.website || profile.lud16 || profile.hasAvatar || profile.hasBanner);
	profileAbout.textContent = profile && profile.about ? profile.about : hasProfileContent ? "" : t("profile.none");
	profileMeta.innerHTML = profile ? profileMetaHtml(profile) : "";
}

// optional profile metadata rows: a website link and a lightning address. each
// is omitted when absent, so the block collapses entirely for a bare profile.
function profileMetaHtml(profile) {
	let html = "";
	const site = /^https?:\/\//i.test(profile.website || "") ? profile.website : "";
	if (site) {
		const label = site.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
		html += `<a class="profileLink" href="${escapeHtml(site)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
	}
	if (profile.lud16) {
		html += `<div class="profileZap">⚡ ${escapeHtml(profile.lud16)}</div>`;
	}
	return html;
}

function closeProfileCard() {
	profileGate.classList.remove("show");
	openProfilePubkey = null;
	profileAvatar.removeAttribute("src"); // stop/release the images
	profileBanner.removeAttribute("src");
}

function closeUsers() {
	usersGate.classList.remove("show");
}

// ===========================================================================
// Direct messages (bitchat NIP-17 gift wraps). E2E-encrypted with the local
// key, so this rides its own always-on relay client independent of assist mode.
// See nostr/dm.js for the wire protocol.
// ===========================================================================

// pubkey(lower) -> { pubkey, name, messages: [{ id, mine, content, ts, status }], unread, readSent:Set }
const conversations = new Map();
let activeDmPubkey = null; // pubkey of the open thread, or null
let actionContext = null; // { pubkey, entryId } for the open action popup

const dmClient = createDmClient({
	getIdentity: () => identity,
	onMessage: onDmMessage,
	onAck: onDmAck,
	onStatusChange: () => {},
});
// console helper for interop debugging: call glubDmStats() to see how many gift
// wraps arrived and where they dropped (verify/decrypt/decode) vs surfaced.
window.glubDmStats = () => dmClient.stats();

// best display name we know for a pubkey: their most recent chat handle, else a
// name we've stored on the conversation, else "anon".
function displayNameForPubkey(pubkey) {
	const pk = pubkey.toLowerCase();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e.system && e.pubkey && e.pubkey.toLowerCase() === pk) return e.who;
	}
	const conv = conversations.get(pk);
	return (conv && conv.name) || "anon";
}

function handleHtml(name, pubkey) {
	return `@${escapeHtml(clipText(name, 24))}<span class="sfx">#${escapeHtml(pubkey.slice(-4))}</span>`;
}

function ensureConversation(pubkey) {
	const pk = pubkey.toLowerCase();
	let conv = conversations.get(pk);
	if (!conv) {
		conv = { pubkey: pk, name: displayNameForPubkey(pk), messages: [], unread: 0, readSent: new Set() };
		conversations.set(pk, conv);
	}
	return conv;
}

function totalUnread() {
	let n = 0;
	for (const conv of conversations.values()) n += conv.unread;
	return n;
}

// the floating DM pill lives below the topbar, top-right, over the chat. it only
// appears when there are unread DMs and hides once you're caught up; the /dms
// command is the always-available way into the inbox.
function updateDmPill() {
	const unread = totalUnread();
	if (unread <= 0) {
		dmPill.hidden = true;
		return;
	}
	dmPill.hidden = false;
	dmPill.innerHTML = `DM<span class="dmCount">${unread}</span>`;
}

// --- inbound ---------------------------------------------------------------

// `historical` = a stored/backlog gift wrap replayed by a relay before EOSE (e.g.
// on reload). We still populate the conversation so DM history is preserved, but
// we don't count it as unread or fire a notification - otherwise every reload
// would re-announce the last day of DMs as "N new".
function onDmMessage({ senderPubkey, messageID, content, timestamp, historical }) {
	const conv = ensureConversation(senderPubkey);
	conv.name = displayNameForPubkey(senderPubkey); // refresh in case we now know them
	if (conv.messages.some((m) => m.id === messageID)) return; // dedup
	conv.messages.push({ id: messageID, mine: false, content, ts: timestamp, status: "recv" });
	conv.messages.sort((a, b) => a.ts - b.ts);

	const viewing = activeDmPubkey === conv.pubkey && dmGate.classList.contains("show");
	if (viewing) {
		renderDmThread();
		markConversationRead(conv);
	} else if (!historical) {
		conv.unread += 1;
		appendSystem(t("dm.received", { name: conv.name }), SYSTEM_TTL_LONG_MS);
	}
	updateDmPill();
	if (dmListGate.classList.contains("show")) renderDmList();
}

function onDmAck({ senderPubkey, messageID, kind }) {
	const conv = conversations.get(senderPubkey.toLowerCase());
	if (!conv) return;
	const msg = conv.messages.find((m) => m.id === messageID && m.mine);
	if (!msg) return;
	// only advance status forward: sent -> delivered -> read
	if (kind === "delivered" && msg.status === "sent") msg.status = "delivered";
	else if (kind === "read") msg.status = "read";
	if (activeDmPubkey === conv.pubkey && dmGate.classList.contains("show")) renderDmThread();
}

// --- action popup (tap a user) ---------------------------------------------

function openActionPopup(pubkey, entryId) {
	actionContext = { pubkey, entryId };
	const name = displayNameForPubkey(pubkey);
	actionTitle.innerHTML = handleHtml(name, pubkey);
	// can't DM yourself
	actionDm.hidden = pubkey.toLowerCase() === identity.pk.toLowerCase();
	actionGate.classList.add("show");
}

function closeActionPopup() {
	actionGate.classList.remove("show");
	actionContext = null;
}

// --- conversation thread ---------------------------------------------------

function dmStatusLabel(status) {
	if (status === "read") return t("dm.status_read");
	if (status === "delivered") return t("dm.status_delivered");
	return t("dm.status_sent");
}

function dmMessageHtml(m) {
	const meta = m.mine
		? `<span class="dmMeta">${escapeHtml(formatTime(m.ts))} · <span class="dmStatus ${m.status}">${escapeHtml(dmStatusLabel(m.status))}</span></span>`
		: `<span class="dmMeta">${escapeHtml(formatTime(m.ts))}</span>`;
	return `<div class="dmMsg ${m.mine ? "mine" : "theirs"}">${linkify(escapeHtml(m.content))}${meta}</div>`;
}

function renderDmThread() {
	const conv = conversations.get(activeDmPubkey);
	if (!conv) return;
	dmThread.innerHTML = conv.messages.map(dmMessageHtml).join("");
	dmThread.scrollTop = dmThread.scrollHeight;
}

// send read receipts for any of their messages we haven't acked yet
function markConversationRead(conv) {
	if (conv.unread) {
		conv.unread = 0;
		updateDmPill();
	}
	for (const m of conv.messages) {
		if (!m.mine && !conv.readSent.has(m.id)) {
			conv.readSent.add(m.id);
			dmClient.sendRead(m.id, conv.pubkey);
		}
	}
}

function openDmConversation(pubkey) {
	const pk = pubkey.toLowerCase();
	if (pk === identity.pk.toLowerCase()) {
		appendSystem(t("actions.self"));
		return;
	}
	const conv = ensureConversation(pk);
	activeDmPubkey = pk;
	dmPeerName.innerHTML = handleHtml(conv.name, pk);
	renderDmThread();
	closeActionPopup();
	dmListGate.classList.remove("show");
	dmGate.classList.add("show");
	markConversationRead(conv);
	updateDmPill();
	setTimeout(() => dmInput.focus(), 0);
}

function closeDm() {
	dmGate.classList.remove("show");
	activeDmPubkey = null;
}

function sendDmFromComposer() {
	const text = dmInput.value.trim();
	if (!text || !activeDmPubkey) return;
	if (new TextEncoder().encode(text).length > DM_MAX_CONTENT_BYTES) {
		appendSystem(t("dm.too_long", { max: DM_MAX_CONTENT_BYTES }));
		return;
	}
	const messageID = dmClient.sendDm(text, activeDmPubkey);
	if (!messageID) {
		appendSystem(t("dm.send_failed"));
		return;
	}
	dmInput.value = "";
	const conv = ensureConversation(activeDmPubkey);
	conv.messages.push({ id: messageID, mine: true, content: text, ts: Math.floor(Date.now() / 1000), status: "sent" });
	renderDmThread();
}

// --- inbox (conversation list) ---------------------------------------------

function renderDmList() {
	const convos = [...conversations.values()]
		.filter((c) => c.messages.length)
		.sort((a, b) => lastTs(b) - lastTs(a));
	dmList.innerHTML = convos.map(dmRowHtml).join("");
}

function lastTs(conv) {
	return conv.messages.length ? conv.messages[conv.messages.length - 1].ts : 0;
}

function dmRowHtml(conv) {
	const last = conv.messages[conv.messages.length - 1];
	const preview = last ? (last.mine ? "→ " : "") + clipText(last.content, 40) : "";
	const unread = conv.unread ? `<span class="dmRowUnread">${conv.unread}</span>` : "";
	return (
		`<div class="dmRow" data-user="${escapeHtml(conv.pubkey)}">` +
		`<span class="dmRowMain">` +
		`<span class="dmRowName">${handleHtml(conv.name, conv.pubkey)}</span>` +
		`<span class="dmRowPreview">${escapeHtml(preview)}</span>` +
		`</span>` +
		`<span class="dmRowSide">` +
		`<span class="dmRowTime">${last ? escapeHtml(formatAgo(last.ts)) : ""}</span>` +
		unread +
		`</span>` +
		`</div>`
	);
}

function openDmList() {
	renderDmList();
	dmListGate.classList.add("show");
}

function closeDmList() {
	dmListGate.classList.remove("show");
}

if (name) {
	closeNameGate();
} else {
	openNameGate();
}

brandEl.addEventListener("click", openNameGate);

// tapping the topbar envelope opens the DM inbox
dmPill.addEventListener("click", openDmList);

// --- DM event wiring ---

// tap a name (or DM-list row) -> per-user action popup. bail on any interactive
// child (channel link, url, more/less, image) so those keep their own behavior.
terminal.addEventListener("click", (e) => {
	if (e.target.closest(".inlineLink, .inlineGeo, .geo, .toggleMore, [data-img-toggle]")) return;
	const nameEl = e.target.closest("[data-user]");
	if (!nameEl) return;
	const entry = entries.find((en) => en.el && en.el.contains(nameEl));
	openActionPopup(nameEl.dataset.user, entry ? entry.id : null);
});

actionClose.addEventListener("click", closeActionPopup);
actionGate.addEventListener("click", (e) => {
	if (e.target === actionGate) closeActionPopup();
});
actionDm.addEventListener("click", () => {
	if (actionContext) openDmConversation(actionContext.pubkey);
});
// dummy actions: acknowledge with an ephemeral note until they're built out
for (const btn of actionGate.querySelectorAll(".actionBtn.dummy")) {
	btn.addEventListener("click", () => {
		appendSystem(t("actions.soon", { action: t(`actions.${btn.dataset.action}`) }));
		closeActionPopup();
	});
}

dmListClose.addEventListener("click", closeDmList);
dmListGate.addEventListener("click", (e) => {
	if (e.target === dmListGate) closeDmList();
});
dmList.addEventListener("click", (e) => {
	const row = e.target.closest(".dmRow");
	if (row && row.dataset.user) openDmConversation(row.dataset.user);
});

dmClose.addEventListener("click", closeDm);
dmSendBtn.addEventListener("click", sendDmFromComposer);
dmInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		sendDmFromComposer();
	}
});

// in a focused channel the status is "N USERS - [EXIT]": tapping the user count
// opens the user list, tapping anywhere else (incl. [EXIT]) leaves the channel.
// In global view it's the settings entry point.
statusEl.addEventListener("click", (e) => {
	if (!focusedGeo) {
		openSettings();
		return;
	}
	if (e.target.closest(".tapUsers")) openUsers();
	else exitFocus();
});

assistToggle.addEventListener("change", async () => {
	setAssistEnabled(assistToggle.checked);
	syncProfilesRow(); // profiles depend on assist, so reflect that immediately
	if (assistToggle.checked) {
		// flip to assist if the api is reachable; otherwise stay on relays and let
		// the maintain loop promote us once it comes up. Re-check the toggle after
		// the await - the user may have flipped it back off while the health check
		// was in flight.
		if ((await checkApiHealth()) && getAssistEnabled()) enterAssistMode();
	} else {
		apiAvailable = false;
		apiHealth = null;
		enterRelayMode();
	}
	syncSelfView(); // assist gates profiles, so "you" may flip back to orange
});

profilesToggle.addEventListener("change", () => {
	if (profilesToggle.disabled) return;
	setProfilesEnabled(profilesToggle.checked);
	syncSelfView(); // "you" switches between orange+bold and your real per-key color
	if (usersGate.classList.contains("show")) openUsers(); // reflect avatars on/off
});

settingsClose.addEventListener("click", closeSettings);
// tapping the dimmed backdrop (outside the card) dismisses settings
settingsGate.addEventListener("click", (e) => {
	if (e.target === settingsGate) closeSettings();
});

usersClose.addEventListener("click", closeUsers);
usersGate.addEventListener("click", (e) => {
	if (e.target === usersGate) closeUsers();
});
// tap a user row to open their nostr profile card (when profiles are on)
usersList.addEventListener("click", (e) => {
	if (!profilesActive()) return;
	const row = e.target.closest(".userRow");
	if (row && row.dataset.pubkey) openProfileCard(row.dataset.pubkey);
});

profileClose.addEventListener("click", closeProfileCard);
profileGate.addEventListener("click", (e) => {
	if (e.target === profileGate) closeProfileCard();
});

// tap the npub chip to copy the full key; flash confirmation in the hint slot.
let npubHintTimer = null;
profileNpub.addEventListener("click", async () => {
	const npub = profileNpub.dataset.npub || "";
	if (!npub) return;
	try {
		await navigator.clipboard.writeText(npub);
		profileNpubHint.textContent = t("profile.npub_copied");
	} catch {
		profileNpubHint.textContent = t("profile.npub_copy_failed");
	}
	clearTimeout(npubHintTimer);
	npubHintTimer = setTimeout(() => {
		profileNpubHint.textContent = t("settings.copy_nsec");
	}, 1500);
});

// once the user scrolls up to read history, stop yanking them back to the
// bottom on every new message; resume only when they scroll back down.
terminal.addEventListener("scroll", () => {
	autoScroll = isNearBottom();
	if (autoScroll) clearUnread();
});

newMessagesBar.addEventListener("click", jumpToBottom);

// clicking a geohash - either the #geo prefix or an inline #geo in a message -
// focuses that channel. Links carry no data-geo, so they open normally.
terminal.addEventListener("click", (e) => {
	const geoEl = e.target.closest("[data-geo]");
	if (!geoEl) return;
	const geo = geoEl.dataset.geo;
	if (geo) focusChannel(geo);
});

// expand/collapse an over-long name or message in place
terminal.addEventListener("click", (e) => {
	const toggle = e.target.closest(".toggleMore");
	if (!toggle) return;
	const entry = entries.find((en) => en.id === toggle.dataset.toggle);
	if (!entry || !entry.el) return;
	entry.expanded = !entry.expanded;
	entry.el.innerHTML = (focusedGeo ? "" : entry.geoPrefix || "") + messageInnerHtml(entry);
});

// tap a blurred image preview to reveal it, tap again to re-blur
terminal.addEventListener("click", (e) => {
	const imgToggle = e.target.closest("[data-img-toggle]");
	if (!imgToggle) return;
	const key = imgToggle.dataset.imgToggle;
	if (!key) return;

	if (revealedImages.has(key)) revealedImages.delete(key);
	else revealedImages.add(key);

	const entryId = key.slice(0, key.lastIndexOf(":"));
	const entry = entries.find((en) => en.id === entryId);
	if (!entry || !entry.el) return;
	entry.el.innerHTML = (focusedGeo ? "" : entry.geoPrefix || "") + messageInnerHtml(entry);
});

function randomAnonName() {
	return `anon${Math.floor(1000 + Math.random() * 9000)}`;
}

nameForm.addEventListener("submit", (e) => {
	e.preventDefault();

	const value = nameInput.value.trim().slice(0, 24);
	name = value || randomAnonName();

	setStoredName(name);
	renderTopbar();
	closeNameGate();
	appendSystem(t("system.welcome", { name })); // ephemeral greeting (fades like other notices)
});

// single entry point for every event source (relays + history api): filter to
// geohash chat, dedup by id, then render. Both paths share one dedup set.
function rerenderEntryEl(entry) {
	if (entry.el) entry.el.innerHTML = (focusedGeo ? "" : entry.geoPrefix || "") + messageInnerHtml(entry);
}

// how "you" appear (orange+bold vs. your real per-key color) hinges on
// profilesActive() - repaint your own visible lines in place, no scroll jump.
function repaintSelfLines() {
	const bold = !profilesActive();
	for (const entry of entries) {
		if (!entry.mine || !entry.el) continue;
		entry.el.classList.toggle("mine", bold);
		rerenderEntryEl(entry);
	}
}

// profilesActive() can flip from any of several places (both settings toggles, and
// the api going up/down under the health loop). repaint your lines only when the
// effective state actually changes, so the periodic health check stays free.
let lastSelfViewActive = profilesActive();
function syncSelfView() {
	const active = profilesActive();
	if (active === lastSelfViewActive) return;
	lastSelfViewActive = active;
	repaintSelfLines();
}

// deliver a signed event: in assist mode hand it to the api to fan out across
// the relays it already holds open; otherwise broadcast to our own relay subs.
function deliver(event) {
	if (liveSource === "assist") publishViaApi(event);
	else pool.broadcast(event);
}

// announce our presence in the channel we're currently viewing. purely timer-
// driven (not on join): whatever channel you happen to be in when the timer
// fires. in the global view there's no channel to announce, so we stay quiet.
function broadcastPresence() {
	if (!focusedGeo) return;
	const event = makePresenceEvent({
		geohash: focusedGeo,
		name: name || "anon",
		sk: identity.sk,
		pk: identity.pk,
	});
	deliver(event);
}

// self-rescheduling heartbeat on a fresh semi-random interval each time, so a
// room full of clients doesn't announce in lockstep.
function schedulePresence() {
	const span = PRESENCE_BROADCAST_MAX_MS - PRESENCE_BROADCAST_MIN_MS;
	const delay = PRESENCE_BROADCAST_MIN_MS + Math.random() * span;
	setTimeout(() => {
		broadcastPresence();
		schedulePresence();
	}, delay);
}

// hand a signed event to the api to fan out. We POST the signed event only - the
// key never leaves the browser. Confirmation still arrives via the SSE echo.
async function publishViaApi(event) {
	try {
		const res = await fetch(`${API_BASE}/api/publish`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event),
			cache: "no-store",
		});
		if (!res.ok) throw new Error(`publish ${res.status}`);
	} catch {
		// couldn't reach the api - if the stream is also down we'll fall back to
		// relays and the retry goes out there; otherwise the retry re-POSTs.
	}
}

// (re)deliver a tracked message and arm its confirmation timeout
function attemptBroadcast(id) {
	const rec = pending.get(id);
	if (!rec) return;
	rec.attempts += 1;
	deliver(rec.event);
	clearTimeout(rec.timer);
	rec.timer = setTimeout(() => onSendTimeout(id), ACK_TIMEOUT_MS);
}

// no echo in time: rebroadcast the identical signed event (relays have warmed /
// the broadcast set has healed since) until attempts run out, then flag it. The
// entry shows "resending…" for the duration of the retries and "failed" if they
// all come up empty.
function onSendTimeout(id) {
	const rec = pending.get(id);
	if (!rec) return;
	if (rec.attempts < MAX_SEND_ATTEMPTS) {
		const entry = entries.find((e) => e.id === id);
		if (entry && !entry.resending) {
			entry.resending = true;
			rerenderEntryEl(entry);
		}
		attemptBroadcast(id);
		return;
	}
	pending.delete(id);
	const entry = entries.find((e) => e.id === id);
	if (entry) {
		entry.resending = false;
		entry.ackFailed = true;
		rerenderEntryEl(entry);
	}
}

// a live source replayed one of our sent messages - it propagated. Record the
// round-trip (from the first send) and refresh that line's latency badge.
function confirmSent(id) {
	const rec = pending.get(id);
	if (!rec) return;
	clearTimeout(rec.timer);
	pending.delete(id);
	const entry = entries.find((e) => e.id === id);
	if (!entry) return;
	entry.resending = false;
	entry.ackSecs = Math.max(0, Math.floor((Date.now() - rec.firstSentAt) / 1000));
	rerenderEntryEl(entry);
}

// record a kind-20001 presence heartbeat from a relay we read. Kept latest-per-
// pubkey-per-channel and aged out by PRESENCE_FRESH_MS at read time.
function trackPresence(ev) {
	if (typeof ev.pubkey !== "string") return;
	if (ev.pubkey === identity.pk) return; // don't list ourselves as a detected "ghost"
	if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return;
	const geo = getGeohash(ev);
	if (!geo) return;
	let chan = presence.get(geo);
	if (!chan) presence.set(geo, (chan = new Map()));
	const teleport = Array.isArray(ev.tags) && ev.tags.some((t) => t[0] === "t" && t[1] === "teleport");
	// lastSeen drives freshness; createdAt is the heartbeat time we show as "x ago".
	chan.set(ev.pubkey, { name: getName(ev) || "anon", teleport, createdAt: ev.created_at, lastSeen: Date.now() });
}

// fresh presences for a channel, freshest first (stale entries skipped).
function localPresence(geo) {
	const chan = presence.get(geo);
	if (!chan) return [];
	const cutoff = Date.now() - PRESENCE_FRESH_MS;
	const out = [];
	for (const [pubkey, p] of chan) {
		if (p.lastSeen < cutoff) continue;
		out.push({ pubkey, name: p.name, teleport: p.teleport, createdAt: p.createdAt });
	}
	out.sort((a, b) => b.createdAt - a.createdAt);
	return out;
}

function ingestEvent(ev) {
	if (ev.kind === PRESENCE_KIND) {
		trackPresence(ev);
		return;
	}
	if (ev.kind !== CHAT_KIND) return;
	if (!getGeohash(ev)) return;
	// reject far-future timestamps (a skewed/forged clock) - they'd otherwise sit
	// permanently pinned below every real message
	if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return;

	// detect our own message echoing back (before the dedup skip) so we can
	// confirm it propagated and time it
	if (pending.has(ev.id)) confirmSent(ev.id);

	if (seen.has(ev.id)) return;
	seen.add(ev.id);
	if (seen.size > 5000) seen.clear();

	renderEvent(ev);
}

const pool = new RelayPool({
	onStatusChange: renderTopbar,
	onEvent: ingestEvent,
	// broadcast-only set size (assist mode). The nearest-N relays to a focused
	// geohash can be a sparse/flaky regional set, so keep enough of them open
	// that a send reliably reaches relays the api is also watching.
	broadcastCount: 16,
});

// --- "server assist" mode: mirror the api's buffer + live stream -------------

async function checkApiHealth() {
	if (!getAssistEnabled()) {
		apiAvailable = false;
		apiHealth = null;
		return false;
	}
	try {
		const res = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
		if (!res.ok) {
			apiAvailable = false;
			return false;
		}
		apiHealth = await res.json();
		apiAvailable = !!apiHealth.ok;
	} catch {
		apiAvailable = false;
	}
	syncSelfView(); // the api coming up / going down flips how "you" are colored
	return apiAvailable;
}

// fetch the api's whole buffer once and feed it through the dedup+render
// pipeline. Every event is signature-verified client-side, so a bad/compromised
// api can't inject forged messages.
async function mirrorBuffer() {
	try {
		const res = await fetch(`${API_BASE}/api/history?limit=${BUFFER_FETCH}`, { cache: "no-store" });
		if (!res.ok) return;
		const data = await res.json();
		if (!Array.isArray(data.events)) return;

		for (const ev of data.events) {
			if (!seen.has(ev.id) && verifyEvent(ev)) ingestEvent(ev);
		}
		// fewer than we asked for => we've mirrored the api's entire buffer, so
		// mark the start of available history.
		if (data.events.length < BUFFER_FETCH) showBeginningBarrier(data.events);
	} catch {
		// stream/fallback machinery handles dropping back to relays
	}
}

// a "beginning of chat" divider above the oldest known event (api-buffer only)
function showBeginningBarrier(events) {
	if (barrierShown || !events.length) return;
	barrierShown = true;
	const oldest = events.reduce((m, e) => Math.min(m, e.created_at), Infinity);
	insertEntry({
		ts: oldest - 1,
		geo: null,
		system: true,
		pubkey: null,
		html: `<span class="barrier">——— ** ${escapeHtml(t("message.beginning_of_chat"))} ** ———</span>`,
		el: null,
	});
}

function openAssistStream() {
	closeAssistStream();
	try {
		eventSource = new EventSource(`${API_BASE}/api/stream`);
	} catch {
		enterRelayMode();
		return;
	}

	eventSource.onopen = () => {
		clearTimeout(assistFallbackTimer);
		assistFallbackTimer = null;
	};
	eventSource.onmessage = (e) => {
		let ev;
		try {
			ev = JSON.parse(e.data);
		} catch {
			return;
		}
		// no seen-pre-check: our own (already-seen) messages must still reach
		// ingestEvent so it can confirm them. ingestEvent dedups rendering itself.
		if (ev && verifyEvent(ev)) ingestEvent(ev);
	};
	eventSource.onerror = () => {
		// EventSource auto-reconnects; only fall back to relays if it can't recover
		if (assistFallbackTimer || liveSource !== "assist") return;
		assistFallbackTimer = setTimeout(() => {
			assistFallbackTimer = null;
			if (liveSource === "assist" && (!eventSource || eventSource.readyState !== EventSource.OPEN)) {
				enterRelayMode(); // transparent fallback - maintain loop re-enters when api recovers
			}
		}, ASSIST_FALLBACK_MS);
	};
}

function closeAssistStream() {
	clearTimeout(assistFallbackTimer);
	assistFallbackTimer = null;
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}
}

// assist mode: the client holds no relay sockets at all - reads come from the
// api stream, sends go through the api's /api/publish (which fans out across the
// relays it already monitors). So there's nothing to warm up or recompute when
// switching channels.
function enterAssistMode() {
	if (liveSource === "assist" && eventSource) return; // already assisting
	liveSource = "assist";
	pool.disconnect(); // drop any relay sockets - the api handles both directions
	openAssistStream(); // open the stream first so nothing arriving during the
	mirrorBuffer(); // buffer fetch is missed (dedup handles the overlap)
	renderTopbar();

	// announce the genuine activation (api reachable + switched over), not the
	// mere toggle state - fires on first connect, toggle-on, and recovery. The
	// relay count is already in the topbar, so keep the notice clean.
	appendSystem(t("system.assist_active"));
}

// pure-client mode: live reads from direct relay subscriptions (today's behavior).
function enterRelayMode() {
	liveSource = "relays";
	closeAssistStream();
	if (!allRelays.length) {
		renderTopbar();
		return;
	}
	// we only reach here when we're actually on relays (assist off, or assist on
	// but the api is unreachable / fell back), so always narrate the relay work -
	// it reflects what's genuinely happening, regardless of the toggle.
	if (focusedGeo) {
		let sorted;
		try {
			sorted = sortRelaysByGeohash(allRelays, focusedGeo).map((r) => r.url);
		} catch {
			// non-geocodable channel: it isn't a decodable location, so there's no
			// local set to compute - use the global set instead.
			pool.connectAll(allRelays.map((r) => r.url));
			appendSystem(t("system.relay_global_teleport", { geo: focusedGeo }));
			renderTopbar();
			return;
		}
		pool.connectNearest(sorted);
		appendSystem(t("system.relay_local", { geo: focusedGeo }));
	} else {
		pool.connectAll(allRelays.map((r) => r.url));
		appendSystem(t("system.relay_global"));
	}
	renderTopbar();
}

// periodic upkeep: refresh the api's relay count for the status, and recover
// into assist mode once the api is reachable again after a fallback.
function startAssistMaintain() {
	setInterval(async () => {
		if (!getAssistEnabled()) return;
		await checkApiHealth();
		if (apiAvailable && liveSource === "relays") enterAssistMode();
		else renderTopbar();
	}, ASSIST_MAINTAIN_MS);
}

// re-render the dynamic views when the locale changes at runtime (a future
// language picker / override calls setLocale). Registered here, after the views
// and `pool` exist, so it never fires against an uninitialized binding.
onLocaleChange(() => {
	renderTopbar();
	updatePlaceholder();
	updateNewMessagesBar();
	rerenderTerminal();
});

// presence/activity decays with time, so re-evaluate the focused channel on a
// timer - the count drops as users go stale even when no new messages arrive,
// and an open user list refreshes with them.
setInterval(() => {
	if (!focusedGeo) return;
	updateFocusedUserCount();
	renderTopbar();
	if (usersGate.classList.contains("show")) openUsers();
}, PRESENCE_TICK_MS);

// start our own presence heartbeat (announces only while viewing a channel)
schedulePresence();

// initial paint - done after `pool` exists since renderTopbar reads its counts
renderTopbar();

// boot ritual: a couple of dim, staggered lines while the client wakes up, in
// the same ephemeral voice as every other notice (they fade and get out of the
// way). purely cosmetic - never blocks or delays the actual init below.
function bootSequence() {
	// first line synchronously, so it's on screen before any awaited fetch can
	// interleave real output; the second lands a beat later.
	pushSystem(`<span class="boot">${escapeHtml(t("system.boot_1"))}</span>`);
	setTimeout(() => {
		pushSystem(`<span class="boot">${escapeHtml(t("system.boot_2"))}</span>`);
	}, 300);
}

(async function init() {
	bootSequence();

	// DMs are E2E-encrypted with the local key and never touch the api, so the DM
	// relay client runs independently of assist mode - start it up front.
	dmClient.start();
	updateDmPill();

	try {
		allRelays = await fetchRelayList();
	} catch (err) {
		appendSystem(t("system.relay_failed", { error: err.message }));
	}

	if (getAssistEnabled() && (await checkApiHealth())) enterAssistMode();
	else enterRelayMode();

	startAssistMaintain();
})();

function updatePlaceholder() {
	chatInput.placeholder = focusedGeo
		? t("composer.placeholder_focused", { geo: focusedGeo })
		: t("composer.placeholder_global");
}

function focusChannel(geo) {
	focusedGeo = geo;
	updatePlaceholder();
	updateFocusedUserCount();
	renderTopbar();
	rerenderTerminal(); // assist mode: focus is just an instant local filter of the buffer

	// assist mode has no client relay sockets, so focus is purely a local filter;
	// pure mode re-subscribes to the channel's nearest relays.
	if (liveSource !== "assist") enterRelayMode();
}

function exitFocus() {
	focusedGeo = null;
	suggest.hide();
	updatePlaceholder();
	updateFocusedUserCount();
	renderTopbar();
	rerenderTerminal();

	if (liveSource !== "assist") enterRelayMode();
}

function parseDraft(raw) {
	const text = raw.trim();
	if (!text) return null;

	if (focusedGeo) {
		return { geo: focusedGeo, content: text };
	}

	const parts = text.split(/\s+/);
	const first = parts[0].replace(/^#/, "");
	if (!first) return null;

	const rest = parts.slice(1).join(" ").trim();

	if (!rest) {
		focusChannel(first);
		return null;
	}

	return { geo: first, content: rest };
}

// the display name for command/bot output: your name suffixed with ".bot", so
// broadcasted command results read as "carson.bot" - clearly automated, still
// signed by (and attributed to) your own key.
function botName() {
	return `${name || "anon"}.bot`;
}

// build, sign, render, and broadcast a chat message under `displayName` (your
// name by default). shared by normal sends and bot-output commands, so command
// broadcasts get the same echo-confirmation + rebroadcast treatment as any send.
// never let a secret key go out over the wire, no matter how it got into the
// composer (e.g. a mistyped "/import"). this is the single broadcast chokepoint.
const NSEC_RE = /nsec1[0-9a-z]{20,}/i;

function transmit(content, geo, displayName = name) {
	if (NSEC_RE.test(content)) {
		appendSystem(t("system.nsec_blocked"));
		return;
	}
	const event = makeChatMessage({ content, geohash: geo, name: displayName, sk: identity.sk, pk: identity.pk });
	seen.add(event.id);
	// track before rendering so renderEvent's pendingAck picks it up, then
	// broadcast + arm the confirm/rebroadcast timer.
	pending.set(event.id, { event, firstSentAt: Date.now(), attempts: 0, timer: null });
	renderEvent(event);
	attemptBroadcast(event.id);
	// sending returns you to the live bottom - but only when the message lands in
	// the view you're looking at (a background send, e.g. an upload finishing
	// after you hopped channels, shouldn't yank your scroll position).
	if (!focusedGeo || geo === focusedGeo) jumpToBottom();
}

// --- media upload (assist-only) ----------------------------------------------

// the "+" button shows only while assist mode is live (uploads go to the api)
// AND you're focused in a channel (there's a target to send to); otherwise it's
// hidden and the feature effectively doesn't exist.
function syncMediaBtn() {
	mediaBtn.hidden = liveSource !== "assist" || !focusedGeo;
}

// clean-slate a static image client-side: repaint onto a canvas and export fresh
// bytes. EXIF/GPS never even leaves the device. GIFs skip this (canvas would
// drop the animation) - the api rebuilds their container instead.
async function cleanEncodeImage(file) {
	if (file.type === "image/gif") return file;
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, MEDIA_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	// png stays png (screenshots/text stay crisp); everything else becomes jpeg
	const type = file.type === "image/png" ? "image/png" : "image/jpeg";
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
	if (!blob) throw new Error("encode failed");
	return blob;
}

async function uploadMedia(file) {
	if (file.size > MEDIA_MAX_MB * 1024 * 1024) {
		appendSystem(t("system.upload_too_large", { max: MEDIA_MAX_MB }));
		return;
	}
	// bind the destination NOW: the upload auto-sends to the channel it was
	// started in, even if the user hops channels or exits to global before it
	// finishes. Uploads are fire-and-forget - several can run concurrently, the
	// button never blocks.
	const targetGeo = focusedGeo;
	try {
		const blob = await cleanEncodeImage(file);
		const res = await fetch(`${API_BASE}/api/media`, {
			method: "POST",
			headers: { "Content-Type": blob.type },
			body: blob,
		});
		if (!res.ok) throw new Error(`http ${res.status}`);
		const data = await res.json();
		if (!data.ok || !data.url) throw new Error("bad response");

		// absolutize the (usually relative) media path against our own origin - the
		// browser knows the real scheme (https), so shared links are never http and
		// won't get mixed-content-blocked. resolves against the api's origin when
		// it's separately hosted; leaves an already-absolute url (PUBLIC_ORIGIN) as is.
		const url = new URL(data.url, API_BASE || location.href).href;

		// "[image] {url}" is the marker native bitchat clients recognize. Started
		// in a channel -> send there; started in global view (no target) -> drop
		// it in the composer so the user can aim it at a #channel.
		const content = `[image] ${url}`;
		if (targetGeo) {
			transmit(content, targetGeo);
		} else {
			chatInput.value = chatInput.value ? `${chatInput.value} ${content}` : content;
			chatInput.focus();
		}
	} catch {
		appendSystem(t("system.upload_failed"));
	}
}

mediaBtn.addEventListener("click", () => mediaFile.click());
mediaFile.addEventListener("change", () => {
	const file = mediaFile.files && mediaFile.files[0];
	mediaFile.value = ""; // allow re-picking the same file
	if (file) uploadMedia(file);
});

function send() {
	// intercept local slash commands before anything is parsed as a message
	if (runCommand(chatInput.value)) {
		chatInput.value = "";
		suggest.hide();
		return;
	}

	const draft = parseDraft(chatInput.value);
	chatInput.value = "";
	suggest.hide();
	if (!draft) return;
	transmit(draft.content, draft.geo);
}

// --- local slash commands ----------------------------------------------------
// client-only commands (no protocol traffic). add one here and it's instantly
// runnable from the composer and discoverable via the "/" autocomplete below.
// each: { name, description, run(arg) }.
// a command's one-line description, resolved from i18n by name (commands.<name>).
function commandDesc(name) {
	return t(`commands.${name}`);
}

// normalize a /mute or /unmute argument to a bare geohash: drop a leading "#",
// lowercase it, and require it to look like a geohash. "" if it doesn't.
function parseChannelArg(arg) {
	const geo = arg.trim().replace(/^#/, "").toLowerCase();
	return /^[a-z0-9]{1,12}$/.test(geo) ? geo : "";
}

// --- identity rotation / import (replaces the old name-gate "burner" button) --
let rotating = false; // a vanity search is in flight; guards against a second one

// swap in a new identity. a new keypair means a new color + #suffix, but the
// display name is kept (rotate/import the key, not who you are here).
function applyIdentity(next) {
	identity = next;
	ownSuffix = identity.pk.slice(-4);
	updateNameHint(); // harmless if the gate is closed
	renderTopbar();
	dmClient.resubscribe(); // our pubkey changed - re-REQ gift wraps under the new key
}

// brute-force keypairs until the pubkey ends in `suffix` (a vanity #tag). runs in
// short time slices so the ui never freezes, and is bounded so it can't run away.
async function rotateVanity(suffix) {
	if (rotating) {
		appendSystem(t("system.rotate_busy"));
		return;
	}
	rotating = true;
	appendSystem(t("system.rotate_searching", { suffix }), SYSTEM_TTL_LONG_MS);
	const MAX_ATTEMPTS = 2_000_000; // ~30x the average for a 4-hex suffix - a safe ceiling
	let attempts = 0;
	try {
		while (attempts < MAX_ATTEMPTS) {
			const start = performance.now();
			while (performance.now() - start < 20) {
				// ~20ms work slice, then yield to keep the frame responsive
				const cand = candidateKeypair();
				attempts++;
				if (cand.pk.endsWith(suffix)) {
					applyIdentity(adoptIdentity(cand.skHex));
					appendSystem(t("system.rotate_found", { tag: ownSuffix }));
					return;
				}
				if (attempts >= MAX_ATTEMPTS) break;
			}
			await new Promise((r) => setTimeout(r, 0));
		}
		appendSystem(t("system.rotate_giveup", { suffix }));
	} finally {
		rotating = false;
	}
}

const COMMANDS = [
	{
		name: "clear",
		run() {
			// filter out everything up to now; new messages (ts >= cutoff) repopulate.
			clearedBefore = Math.floor(Date.now() / 1000);
			rerenderTerminal();
			appendSystem(t("system.cleared"));
		},
	},
	{
		name: "dms",
		run() {
			// always-available way into the DM inbox (the floating pill only shows
			// while there are unread messages).
			openDmList();
		},
	},
	{
		name: "unclear",
		run() {
			// drop the /clear cutoff so anything still in the buffer reappears.
			clearedBefore = 0;
			rerenderTerminal();
			appendSystem(t("system.uncleared"));
		},
	},
	{
		name: "echo",
		run(arg) {
			// a broadcast command: posts a real message to the channel as your ".bot".
			if (!focusedGeo) {
				appendSystem(t("system.needs_channel")); // no channel = no broadcast target
				return;
			}
			const msg = arg.trim();
			if (!msg) return;
			transmit(msg, focusedGeo, botName());
		},
	},
	{
		name: "mute",
		run(arg) {
			// hide a channel from the global (unfocused) feed. session-only; you can
			// still open the channel directly to read it.
			const geo = parseChannelArg(arg);
			if (!geo) {
				appendSystem(t("system.mute_usage"));
				return;
			}
			mutedChannels.add(geo);
			rerenderTerminal();
			appendSystem(t("system.muted", { geo }));
		},
	},
	{
		name: "unmute",
		run(arg) {
			const raw = arg.trim();
			if (!raw) {
				// no arg -> list what's currently muted (or say there's nothing).
				if (!mutedChannels.size) {
					appendSystem(t("system.mute_none"));
					return;
				}
				const header = `* ${t("system.muted_header")} *`;
				const lines = [...mutedChannels].sort().map((g) => `#${g}`);
				pushSystem(`<span class="ts">${escapeHtml([header, ...lines].join("\n"))}</span>`, SYSTEM_TTL_LONG_MS);
				return;
			}
			const geo = parseChannelArg(raw);
			if (!geo || !mutedChannels.has(geo)) {
				appendSystem(t("system.unmute_notmuted", { geo: geo || raw.replace(/^#/, "") }));
				return;
			}
			mutedChannels.delete(geo);
			rerenderTerminal();
			appendSystem(t("system.unmuted", { geo }));
		},
	},
	{
		name: "rotate",
		run(arg) {
			// no arg -> a fresh random keypair; a 1-4 char hex arg -> vanity #suffix.
			const suffix = arg.trim().toLowerCase();
			if (!suffix) {
				applyIdentity(regenerateIdentity());
				appendSystem(t("system.rotated", { tag: ownSuffix }));
				return;
			}
			if (!/^[0-9a-f]{1,4}$/.test(suffix)) {
				appendSystem(t("system.rotate_badhex"));
				return;
			}
			rotateVanity(suffix);
		},
	},
	{
		name: "help",
		run() {
			// generated from the command list, alphabetical: one "/cmd - description"
			// per line, with names padded so the dashes line up (monospace does the rest).
			const width = Math.max(...COMMANDS.map((c) => c.name.length + 1)); // +1 for the "/"
			const lines = [...COMMANDS]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((c) => `${`/${c.name}`.padEnd(width)} - ${commandDesc(c.name)}`);
			// header in the * emote * style, then the aligned list beneath it.
			const header = `* ${t("system.commands_header")} *`;
			// persist longer than a status blip - give the reader time to scan it.
			pushSystem(`<span class="ts">${escapeHtml([header, ...lines].join("\n"))}</span>`, SYSTEM_TTL_LONG_MS);
		},
	},
];

// run a "/command ..." line locally. returns true if it matched a known command
// (so send() won't also transmit it). an unknown "/..." returns false and falls
// through as a normal message, so a literal slash message still works.
function runCommand(raw) {
	const text = raw.trim();
	if (!text.startsWith("/")) return false;
	const [word, ...rest] = text.slice(1).split(/\s+/);
	const cmd = COMMANDS.find((c) => c.name === word.toLowerCase());
	if (!cmd) return false;
	cmd.run(rest.join(" ").trim());
	return true;
}

// suggest provider: a "/command" typed at the very start of the composer. unlike
// mentions this isn't gated to a focused channel - commands work anywhere.
function commandProvider(value, caret) {
	const before = value.slice(0, caret);
	const m = before.match(/^\/(\w*)$/);
	if (!m) return null;
	const query = m[1].toLowerCase();
	const items = COMMANDS.filter((c) => c.name.startsWith(query))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((c) => ({
			insert: `/${c.name} `,
			html: `<strong>/${escapeHtml(c.name)}</strong>`,
			meta: escapeHtml(commandDesc(c.name)), // dim description in the reusable meta slot
		}));
	return { start: 0, end: caret, items };
}

// --- @mention (and future /command) autocomplete ----------------------------
const suggest = createSuggest(suggestBox);

// the roster we can @-mention: everyone in the focused channel's "present" list
// (talkers), minus ourselves.
function mentionRoster() {
	if (!focusedGeo) return [];
	return [...talkers(focusedGeo).values()]
		.filter((u) => u.pubkey !== identity.pk)
		.map((u) => ({ who: u.who, tag: u.tag, color: u.color }));
}

// a "provider" inspects the text before the caret; if it's a trigger context it
// returns { start, end, items } - the range to replace and the ranked items.
// mentions: an "@word" at the caret, only while focused in a channel. Add more
// providers (e.g. a "/command" one) to SUGGEST_PROVIDERS; first with matches wins.
function mentionProvider(value, caret) {
	if (!focusedGeo) return null;
	const before = value.slice(0, caret);
	const m = before.match(/(?:^|\s)@(\S*)$/);
	if (!m) return null;
	const query = m[1].toLowerCase();
	const start = caret - m[1].length - 1; // index of the "@"
	const items = mentionRoster()
		.filter((u) => u.who.toLowerCase().startsWith(query))
		.sort((a, b) => a.who.toLowerCase().localeCompare(b.who.toLowerCase()))
		.map((u) => ({
			insert: `@${u.who} `,
			accent: u.color, // active-row highlight samples the user's own color
			html: `<span style="color:${u.color}">@${escapeHtml(u.who)}<span class="sfx">#${escapeHtml(u.tag)}</span></span>`,
		}));
	return { start, end: caret, items };
}

const SUGGEST_PROVIDERS = [commandProvider, mentionProvider];

function refreshSuggest() {
	const value = chatInput.value;
	const caret = chatInput.selectionStart ?? value.length;
	for (const provider of SUGGEST_PROVIDERS) {
		const ctx = provider(value, caret);
		if (ctx && ctx.items.length) {
			suggest.show(ctx.items, (item) => applySuggest(ctx.start, ctx.end, item.insert));
			return;
		}
	}
	suggest.hide();
}

// replace [start, end) with the chosen completion, drop the caret after it, and
// re-evaluate (which closes the popup - there's now a trailing space).
function applySuggest(start, end, insert) {
	const value = chatInput.value;
	chatInput.value = value.slice(0, start) + insert + value.slice(end);
	const caret = start + insert.length;
	chatInput.focus();
	chatInput.setSelectionRange(caret, caret);
	refreshSuggest();
}

sendBtn.addEventListener("click", send);
chatInput.addEventListener("input", refreshSuggest);
chatInput.addEventListener("blur", () => suggest.hide());
chatInput.addEventListener("keydown", (e) => {
	if (suggest.handleKey(e)) return; // popup consumes nav/select/escape
	if (e.key === "Enter") {
		e.preventDefault();
		send();
	}
});

// size #app from the *measured* visual viewport instead of trusting css viewport
// units. In installed/standalone mode iOS misreports 100dvh (the layout viewport
// gets stuck short after the keyboard has been open), which stranded the composer
// high above the bottom with a dead gap under it. visualViewport.height is the
// authoritative number: the full screen when idle (gap gone), and the above-
// keyboard height while typing (so the composer rides the keyboard structurally).
// The css 100dvh remains as the no-visualViewport fallback.
const appEl = document.getElementById("app");

function fitViewport() {
	const vv = window.visualViewport;
	if (!vv) return;
	const h = Math.round(vv.height);
	appEl.style.height = `${h}px`;
	// expose the same measured height to the fixed DM panels so their bottom-
	// anchored composer rides above the keyboard too (see --vvh in the css).
	document.documentElement.style.setProperty("--vvh", `${h}px`);
	// and the topbar height, so the floating DM pill anchors just beneath it
	const tb = document.getElementById("topbar");
	if (tb) document.documentElement.style.setProperty("--topbar-h", `${tb.offsetHeight}px`);
	// iOS pans the page to reveal a focused input; with the app sized to the
	// visible area the composer is already above the keyboard, so undo the pan.
	if (window.scrollY) window.scrollTo(0, 0);
	if (autoScroll) scrollToBottom();
	if (activeDmPubkey && dmGate.classList.contains("show")) dmThread.scrollTop = dmThread.scrollHeight;
}

if (window.visualViewport) {
	window.visualViewport.addEventListener("resize", fitViewport);
	window.visualViewport.addEventListener("scroll", fitViewport);
	// orientation changes settle a beat after the event on iOS
	window.addEventListener("orientationchange", () => setTimeout(fitViewport, 250));
	fitViewport();
}

updatePlaceholder();
