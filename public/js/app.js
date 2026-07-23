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
import { buildChatEvent, buildPresenceEvent, signEvent, makeProfileEvent, getGeohash, getName, getClient, CHAT_KIND, PRESENCE_KIND, sortRelaysByGeohash, geohashCell, encodeGeohash, verifyEvent } from "./nostr/protocol.js";
import { mineNonceTag, POW_DIFFICULTY, idDifficulty, committedDifficulty } from "./nostr/pow.js";
import { createMessageRateLimiter, createPresenceRateLimiter } from "./ratelimit.js";
import { t, formatAgo, setLocale, detectLocale, onLocaleChange, preferredContentLanguage } from "./i18n/index.js";
import { createSuggest } from "./ui/suggest.js";
import { createMap } from "./ui/map.js";
import { createDmClient, DM_MAX_CONTENT_BYTES } from "./nostr/dm.js";
import { createNotesClient } from "./nostr/notes.js";
import { uploadImageToNostrBuild, NOSTR_BUILD_MAX_BYTES, NOSTR_BUILD_MAX_MB } from "./nostr/nip96.js";
import { fetchProfileMetadata, publishProfileMetadata } from "./nostr/profileEdit.js";
import { isProfane } from "./censor.js";
import { fetchConditions, wmoDescribe, geocodePlace, parseLatLon } from "./weather.js";
import { THEMES, themeNames, activeTheme, applyTheme, persistTheme, initTheme, hexToRgb } from "./themes.js";

// re-apply the persisted theme before anything renders (module scripts run
// before first paint, so a saved theme doesn't flash bitchat green first).
initTheme();

const MAX_LINES = 600;
const NEAR_BOTTOM_PX = 60;
const MAX_GEO_LEN = 12; // geohash precision tops out here; clip the prefix so a huge "g" tag can't flood a line
const MAX_CHANNEL_LEN = 64; // /join accepts arbitrary channel strings; cap the length defensively
const MAX_NAME_LEN = 22; // collapse longer names behind a "more" toggle
const MAX_MSG_LEN = 450; // collapse longer messages behind a "more" toggle
const HARD_MAX_MSG_LEN = 8000; // absolute ceiling, even when expanded, to bound DOM/memory
const MAX_IMAGES_PER_MESSAGE = 6; // anti-flood: cap how many previews one message can spam in
const MAX_FUTURE_SECS = 120; // drop events timestamped more than this far ahead (skewed/forged clocks)
// broadcast-spam suppression, GLOBAL feed only: a message present in the buffer
// as a big cluster of one content signature reads as a broadcast, not chat, so
// it's omitted from the aggregated global view (entering its channel still shows
// every copy - we just don't let the firehose be flooded). counted over the whole
// buffer with NO time window, so even a slow drip accumulates into a flag. two
// shapes, distinguished by tracking counts PER KEY:
//   flood - one key repeating the same message (any length): "still here" x30.
//   spray - a distinctive long message across many burner keys: temu copypasta.
const SPAM_FLOOD_PER_KEY = 4; // one key sending the same signature this many times = flood (length-agnostic)
const SPAM_SPRAY_TOTAL = 5; // the same signature across keys this many times = spray
const SPAM_SPRAY_MIN_SIG = 24; // ...but the spray rule only fires on messages this long, so common short lines said by many people aren't caught
const SPAM_SIG_MIN = 3; // ignore signatures shorter than this entirely (bare reactions / "gm" / punctuation)
const seen = new Set();
const entries = []; // [{ ts, geo, system, pubkey, html, el }], ascending by ts - all received messages

// client-only, session-only block list (lowercased pubkeys). deliberately not
// persisted: nearly everyone here is on a burner key, so a Set that dies with
// the tab beats spending localStorage on it. blocked = their messages are
// filtered out of the feed + roster locally; nothing is sent, they aren't told.
const blockedPubkeys = new Set();
function isBlocked(pubkey) {
	return !!pubkey && blockedPubkeys.has(pubkey.toLowerCase());
}

// client-side censorship (the settings-window toggles), persisted to localStorage.
// media: images blurred + tap-to-reveal (default on) vs auto-load (off).
// text: messages containing listed profanity collapse to a nameless
//   "* censored message *" placeholder, tap to reveal (default off).
const STORAGE_CENSOR_MEDIA = "glub_censor_media";
const STORAGE_CENSOR_TEXT = "glub_censor_text";
const mediaSettings = { censorImages: localStorage.getItem(STORAGE_CENSOR_MEDIA) !== "false" };
let censorMessages = localStorage.getItem(STORAGE_CENSOR_TEXT) === "true";
const revealedImages = new Set(); // "entryId:idx" keys for images tapped open
const revealedMessages = new Set(); // entry ids of censored messages tapped open

function setCensorMedia(on) {
	mediaSettings.censorImages = on;
	localStorage.setItem(STORAGE_CENSOR_MEDIA, on ? "true" : "false");
}

function setCensorText(on) {
	censorMessages = on;
	localStorage.setItem(STORAGE_CENSOR_TEXT, on ? "true" : "false");
}

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
const retroToggle = document.getElementById("retroToggle");
const clientToggle = document.getElementById("clientToggle");
const localToggle = document.getElementById("localToggle");
const blurToggle = document.getElementById("blurToggle");
const censorToggle = document.getElementById("censorToggle");
const powSelect = document.getElementById("powSelect");
const profilesRow = document.getElementById("profilesRow");
const profileEditSection = document.getElementById("profileEditSection");
const profileEditBannerImg = document.getElementById("profileEditBannerImg");
const profileEditBannerBtn = document.getElementById("profileEditBannerBtn");
const profileEditAvatarImg = document.getElementById("profileEditAvatarImg");
const profileEditAvatarBtn = document.getElementById("profileEditAvatarBtn");
const profileEditUploadStatus = document.getElementById("profileEditUploadStatus");
const profileEditName = document.getElementById("profileEditName");
const profileEditAbout = document.getElementById("profileEditAbout");
const profileEditLud16 = document.getElementById("profileEditLud16");
const profileEditNip05 = document.getElementById("profileEditNip05");
const profileEditWebsite = document.getElementById("profileEditWebsite");
const profileEditSave = document.getElementById("profileEditSave");
const profileEditStatus = document.getElementById("profileEditStatus");
const profileEditFile = document.getElementById("profileEditFile");
const nsecInput = document.getElementById("nsecInput");
const revealNsecBtn = document.getElementById("revealNsecBtn");
const copyNsecBtn = document.getElementById("copyNsecBtn");
const pasteNsecBtn = document.getElementById("pasteNsecBtn");
const nsecStatus = document.getElementById("nsecStatus");
const settingsClose = document.getElementById("settingsClose");
const settingsList = document.getElementById("settingsList");
const settingsDesc = document.getElementById("settingsDesc");
const nameGateSettings = document.getElementById("nameGateSettings");
const usersGate = document.getElementById("usersGate");
const usersTitle = document.getElementById("usersTitle");
const usersLocation = document.getElementById("usersLocation");
const usersList = document.getElementById("usersList");
const usersClose = document.getElementById("usersClose");
const usersMap = document.getElementById("usersMap");
const mapGate = document.getElementById("mapGate");
const mapClose = document.getElementById("mapClose");
const mapCanvas = document.getElementById("mapCanvas");
const mapFeed = document.getElementById("mapFeed");
const mapMenuBtn = document.getElementById("mapMenuBtn");
const mapMenu = document.getElementById("mapMenu");
const mapHint = document.getElementById("mapHint");
const usersNotes = document.getElementById("usersNotes");
const notesGate = document.getElementById("notesGate");
const notesTitle = document.getElementById("notesTitle");
const notesClose = document.getElementById("notesClose");
const notesDraft = document.getElementById("notesDraft");
const notesMenu = document.getElementById("notesMenu");
const notesList = document.getElementById("notesList");
const notesInput = document.getElementById("notesInput");
const notesExpiry = document.getElementById("notesExpiry");
const notesPost = document.getElementById("notesPost");
const notesAttach = document.getElementById("notesAttach");
const notesFile = document.getElementById("notesFile");
const notesUploadHint = document.getElementById("notesUploadHint");
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
const actionPreview = document.getElementById("actionPreview");
const actionDm = document.getElementById("actionDm");
const actionGrid = document.getElementById("actionGrid");
const actionMention = document.getElementById("actionMention");
const actionCopyNpub = document.getElementById("actionCopyNpub");
const actionReply = document.getElementById("actionReply");
const actionTranslate = document.getElementById("actionTranslate");
const actionCopy = document.getElementById("actionCopy");
const actionHug = document.getElementById("actionHug");
const actionSlap = document.getElementById("actionSlap");
const actionBlock = document.getElementById("actionBlock");
const actionClose = document.getElementById("actionClose");
const replyBanner = document.getElementById("replyBanner");
const replyBannerText = document.getElementById("replyBannerText");
const replyBannerCancel = document.getElementById("replyBannerCancel");
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

// "retro terminal": the CRT dressing - scanlines, vignette, phosphor glow, the
// topbar cursor + relay dot, the name-gate typewriter. purely cosmetic and
// CSS-gated on a `retro` class on <html> (see style.css). defaults OFF (clean
// modern skin); opting in brings the full terminal aesthetic. persisted in
// localStorage.
// the cross-client "client" tag: we stamp outgoing events with this so other
// nostr clients can show "via glub.chat", the way amethyst/primal/etc do. on by
// default; the settings toggle opts out (nothing is stamped when off).
const GLUB_CLIENT = "glub.chat";
const STORAGE_CLIENT_KEY = "glub_client_tag";

function getClientTagEnabled() {
	return localStorage.getItem(STORAGE_CLIENT_KEY) !== "false"; // default on
}

function setClientTagEnabled(on) {
	localStorage.setItem(STORAGE_CLIENT_KEY, on ? "true" : "false");
}

// the value to stamp on outgoing events (or null to omit the tag entirely)
function outgoingClient() {
	return getClientTagEnabled() ? GLUB_CLIENT : null;
}

// "local tag": bitchat has no explicit local tag - the ABSENCE of the teleport
// tag reads as local. So "local tag on" just omits teleport from our events;
// off (default) keeps teleport, which is what a location-agnostic web client
// honestly is. Persisted, default off.
const STORAGE_LOCAL_KEY = "glub_local_tag";

function getLocalTagEnabled() {
	return localStorage.getItem(STORAGE_LOCAL_KEY) === "true"; // default off
}

function setLocalTagEnabled(on) {
	localStorage.setItem(STORAGE_LOCAL_KEY, on ? "true" : "false");
}

// whether outgoing chat/presence carry the teleport tag (local tag on => omit it)
function outgoingTeleport() {
	return !getLocalTagEnabled();
}

const STORAGE_RETRO_KEY = "glub_retro";

function getRetroEnabled() {
	return localStorage.getItem(STORAGE_RETRO_KEY) === "true";
}

function setRetroEnabled(on) {
	localStorage.setItem(STORAGE_RETRO_KEY, on ? "true" : "false");
}

function syncRetro() {
	document.documentElement.classList.toggle("retro", getRetroEnabled());
}
syncRetro(); // apply before first paint, alongside the theme

// inbound NIP-13 filter: drop events that don't carry at least this much
// proof-of-work. OFF by default and deliberately so - iOS bitchat doesn't mine
// at all, so any nonzero setting hides every iOS (and legacy-web) user, not
// just bots. it's the big gun for when a channel is actively under attack.
const STORAGE_POW_FILTER_KEY = "glub_pow_filter";

function getPowFilter() {
	const n = parseInt(localStorage.getItem(STORAGE_POW_FILTER_KEY), 10);
	return Number.isFinite(n) && n > 0 ? Math.min(n, 32) : 0;
}

function setPowFilter(n) {
	localStorage.setItem(STORAGE_POW_FILTER_KEY, String(n));
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
function fetchProfile(pubkey, { force = false } = {}) {
	if (!profilesActive()) return Promise.resolve(null);
	if (!force && profileCache.has(pubkey)) {
		const age = Date.now() - (profileFetchedAt.get(pubkey) || 0);
		if (age >= CLIENT_FRESH_MS && !profileInflight.has(pubkey)) revalidateProfile(pubkey);
		return Promise.resolve(profileCache.get(pubkey));
	}
	if (profileInflight.has(pubkey)) return profileInflight.get(pubkey);
	return revalidateProfile(pubkey, { force });
}

// (re)fetch a profile from the api and update the cache; if it changed under us,
// repaint every surface showing it. shared across concurrent callers. force skips
// the api's own 20-minute cache too - used when you open your own profile card,
// since that's the moment you're most likely checking a fresh edit landed.
function revalidateProfile(pubkey, { force = false } = {}) {
	const promise = (async () => {
		try {
			const url = `${API_BASE}/api/profile?pubkey=${pubkey}${force ? "&force=1" : ""}`;
			const res = await fetch(url, { cache: "no-store" });
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
const ACK_TIMEOUT_MS = 15_000; // wait this long for an echo before rebroadcasting
const MAX_SEND_ATTEMPTS = 3; // initial broadcast + up to 2 quick automatic rebroadcasts
const UNVERIFIED_RETRY_MIN_MS = 10_000; // once the quick attempts are spent, keep rechecking on a slower cadence
const UNVERIFIED_RETRY_MAX_MS = 30_000;
const ACK_LATENCY_TTL_MS = 4_000; // show the confirmed round-trip briefly, then let it fade away
const PRESENCE_FRESH_MS = 5 * 60_000; // a user counts as "present" within this window (fresh message or presence)
const PRESENCE_TICK_MS = 30_000; // re-evaluate presence/count on this cadence so stale users drop off without new activity
// how often WE announce our own presence in the channel we're viewing. a semi-
// random interval (per bitchat) so clients don't all heartbeat in lockstep.
const PRESENCE_BROADCAST_MIN_MS = 47_000;
const PRESENCE_BROADCAST_MAX_MS = 60_000;
const MEDIA_MAX_MB = 10; // client-side pre-check; the api enforces its own limit too
const MEDIA_MAX_DIMENSION = 2048; // static images are downscaled to fit this before upload
const SYSTEM_TTL_MS = 7_000; // default lifetime of an ephemeral status notice before it fades
const SYSTEM_TTL_SHORT_MS = 1_800; // a blink of feedback that erases itself fast (e.g. panic)
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

// a glub reply: a message whose content quotes the message it answers, in the
// form "> @user: quoted text\n\nreply body" (an optional leading "#geo " channel
// prefix is tolerated so replies from the old prototype still parse). native
// clients that don't know the format just show it as plain text. returns
// { targetUser, quotedText, body } or null.
const REPLY_RE = /^(?:#[a-z0-9]{1,12}\s+)?>\s+@?([^:\n]+):[ \t]*([^\n]*)\n\s*\n([\s\S]+)$/i;
function parseReplyMessage(text) {
	const raw = String(text || "").replace(/\r\n/g, "\n").trim();
	const m = raw.match(REPLY_RE);
	if (!m) return null;
	return { targetUser: String(m[1] || "").trim(), quotedText: String(m[2] || "").trim(), body: String(m[3] || "").trim() };
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

// screen-wall heuristics: content that eats vertical space without saying much
// gets collapsed by default (never deleted - the more/less toggle reveals it).
// three shapes: tall multiline blocks, ascii art (long + mostly non-letters,
// like box-drawing/punctuation walls), and link dumps.
const WALL_CLIP_LEN = 120; // how much of a collapsed wall stays visible
const WALL_MAX_LINES = 10;
const WALL_MIN_ART_LEN = 80;
const WALL_MAX_LETTER_RATIO = 0.35; // below this share of letters/digits, it's art not prose
const WALL_MAX_LINKS = 4;

function looksLikeWall(text) {
	const str = String(text || "");
	if (str.split("\n").length > WALL_MAX_LINES) return true;
	if (extractUrls(str).length > WALL_MAX_LINKS) return true;
	if (str.length >= WALL_MIN_ART_LEN) {
		const letters = (str.match(/[\p{L}\p{N}]/gu) || []).length;
		if (letters / str.length < WALL_MAX_LETTER_RATIO) return true;
	}
	return false;
}

// mention-bomb guard: a message @-ing half the channel shouldn't light up as a
// personal mention for everyone in it.
const MENTION_BOMB_MAX = 5;

function countMentions(text) {
	return (String(text || "").match(/@[\p{L}\p{N}_]/gu) || []).length;
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

// payment instruments bitchat surfaces in chat: cashu ecash tokens and
// bolt11 / lnurl / lightning: invoices. the raw strings are long unreadable
// blobs, so we swap each for a compact tap-to-copy chip (see richBody). Patterns
// mirror bitchat's own detector so the two clients agree on what counts.
const PAYMENT_SPECS = [
	{ kind: "cashu", re: /\bcashu[AB][A-Za-z0-9._-]{40,}/g },
	{ kind: "lightning", re: /\blightning:[^\s]+/gi }, // scheme-prefixed (matched first so it wins over the bare bolt11 inside it)
	{ kind: "lightning", re: /\bln(?:bc|tb|bcrt)[0-9][a-z0-9]{50,}/gi }, // bare bolt11
	{ kind: "lnurl", re: /\blnurl1[a-z0-9]{20,}/gi },
];

// find payment tokens in raw (un-escaped) text, as [{ start, end, raw, kind }]
// sorted by position with overlaps dropped (the earliest, longest match wins),
// capped so a paste-bomb of tokens can't spray hundreds of chips.
function paymentTokens(text) {
	const hits = [];
	for (const { kind, re } of PAYMENT_SPECS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(text))) {
			let raw = m[0];
			// a trailing sentence mark shouldn't ride along in a copied invoice
			if (kind === "lightning" && /^lightning:/i.test(raw)) raw = raw.replace(/[.,;:!?)\]}>]+$/, "");
			hits.push({ start: m.index, end: m.index + raw.length, raw, kind });
			if (hits.length > 200) break;
		}
	}
	hits.sort((a, b) => a.start - b.start || b.end - a.end);
	const out = [];
	let lastEnd = 0;
	for (const h of hits) {
		if (h.start < lastEnd) continue; // overlaps an earlier chip
		out.push(h);
		lastEnd = h.end;
		if (out.length >= 6) break;
	}
	return out;
}

// message body html: like linkify(escapeHtml(text)), but any payment token is
// spliced out and rendered as a chip. plain runs still get the usual url/geo
// linkification; the raw token is preserved verbatim in data-invoice for copy.
function richBody(text) {
	const toks = paymentTokens(text);
	if (!toks.length) return linkify(escapeHtml(text));
	let html = "";
	let i = 0;
	for (const tk of toks) {
		if (tk.start > i) html += linkify(escapeHtml(text.slice(i, tk.start)));
		html += payChipHtml(tk);
		i = tk.end;
	}
	if (i < text.length) html += linkify(escapeHtml(text.slice(i)));
	return html;
}

function payChipHtml(tk) {
	const icon = tk.kind === "cashu" ? "" : "⚡"; // ⚡ already reads as lightning in-app (profile zap line)
	return (
		`<button type="button" class="payChip" data-kind="${tk.kind}" data-invoice="${escapeHtml(tk.raw)}">` +
		(icon ? `<span class="payChipIcon" aria-hidden="true">${icon}</span>` : "") +
		`<span class="payChipLabel">${escapeHtml(t("payment." + tk.kind))}</span>` +
		`</button>`
	);
}

// true if entry clears the active proof-of-work bar (android's semantics: a
// nonce must be present AND its committed difficulty AND the delivered id must
// both reach the bar). your own messages always pass.
function entryPassesPow(entry) {
	const required = getPowFilter();
	if (!required || entry.mine) return true;
	return entry.powCommitted >= required && entry.pow >= required;
}

// content signature for spam grouping: letters only (case-folded, width/accent
// normalized), urls stripped so a rotating link slug can't split a cluster. "" for
// anything too short to be a meaningful signature (bare reactions / punctuation).
function messageSignature(text) {
	const sig = String(text || "")
		.toLowerCase()
		.normalize("NFKC")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^\p{L}]+/gu, " ")
		.trim();
	return sig.length >= SPAM_SIG_MIN ? sig : "";
}

// per-signature, per-key counts over the current buffer - the basis for global
// broadcast-spam suppression, maintained incrementally as entries enter/leave.
const sigStats = new Map(); // sig -> Map<pubkey, count>
const flaggedSpamSigs = new Set(); // signatures already swept from the global feed (avoids re-sweeping)
function sigBump(entry, delta) {
	const s = entry && entry.sig;
	if (!s) return;
	const pk = entry.pubkey || "";
	let byKey = sigStats.get(s);
	if (!byKey) {
		if (delta <= 0) return;
		sigStats.set(s, (byKey = new Map()));
	}
	const n = (byKey.get(pk) || 0) + delta;
	if (n <= 0) byKey.delete(pk);
	else byKey.set(pk, n);
	if (byKey.size === 0) sigStats.delete(s);
}
// a signature reads as a broadcast (not chat) when either one key floods it, or a
// long distinctive line is sprayed across many keys.
function isGlobalSpam(entry) {
	if (!entry.sig) return false;
	const byKey = sigStats.get(entry.sig);
	if (!byKey) return false;
	let total = 0,
		max = 0;
	for (const n of byKey.values()) {
		total += n;
		if (n > max) max = n;
	}
	if (max >= SPAM_FLOOD_PER_KEY) return true; // one key hammering the same line (any length)
	return total >= SPAM_SPRAY_TOTAL && entry.sig.length >= SPAM_SPRAY_MIN_SIG; // distinctive line across many keys
}

function entryVisible(entry) {
	if (entry.ts < clearedBefore) return false; // hidden by /clear (local view filter)
	if (entry.system) return true;
	if (isBlocked(entry.pubkey)) return false; // blocked author (session-only, local)
	if (!entryPassesPow(entry)) return false; // below the proof-of-work bar (live view filter)
	if (focusedGeo) return entry.geo === focusedGeo; // focused: this channel, everything shown (spam included - you opened it on purpose)
	if (isGlobalSpam(entry)) return false; // global feed: omit broadcast-spam clusters (still visible in-channel)
	return !mutedChannels.has(entry.geo); // global feed: drop muted channels
}

// builds a message line's inner html (everything after the optional #geo prefix)
// from its stored fields, collapsing an over-long name or message behind a
// "more"/"less" toggle so a single huge message can't blow out the view.
function messageInnerHtml(entry) {
	const expanded = entry.expanded;
	// a payment token is a long blob whose whole point is to become a compact chip.
	// clipping it would just show a truncated blob + a "more" toggle, defeating that,
	// so a message carrying one renders in full (the chip does the shortening).
	const hasPayment = !entry.action && paymentTokens(entry.text).length > 0;
	// walls (ascii art / link dumps / tall multiline blocks) collapse much harder
	// than the plain over-length case - a taste of the content, then the toggle.
	const clipLen = entry.wall ? WALL_CLIP_LEN : MAX_MSG_LEN;
	const text = expanded || hasPayment ? entry.text : clipWithEllipsis(entry.text, clipLen);
	// your own color depends on the live profiles state (orange vs. real per-key
	// color), so recompute it each render; peers' colors never change (baked).
	const color = entry.mine ? pubkeyColor(entry.pubkey) : entry.color;

	let body;
	let needsToggle = !hasPayment && entry.text.length > clipLen;

	if (entry.action) {
		// emote: the whole "* ... *" rendered muted like a timestamp, no username
		body = `<span class="ts">${linkify(escapeHtml(text))}</span>`;
	} else if (entry.reply) {
		// a reply: the sender's handle, then the quoted message in a left-bordered
		// block, then the reply body. the whole thing is one tap target.
		const reply = entry.reply;
		const who = expanded ? entry.who : clipWithEllipsis(entry.who, MAX_NAME_LEN);
		const bodyText = expanded || hasPayment ? reply.body : clipWithEllipsis(reply.body, MAX_MSG_LEN);
		needsToggle = entry.who.length > MAX_NAME_LEN || (!hasPayment && reply.body.length > MAX_MSG_LEN);
		const quoted = clipWithEllipsis(`@${reply.targetUser}: ${reply.quotedText}`, 140);
		body =
			`<span class="msgTap" data-user="${escapeHtml(entry.pubkey)}">` +
			avatarHtml(entry.pubkey, { inline: true }) +
			`<span class="bracket" style="color:${color}">&lt;</span>` +
			`<span class="user" style="color:${color}">@${escapeHtml(who)}</span>` +
			`<span class="tag" style="color:${color}">#${escapeHtml(entry.tag)}</span>` +
			`<span class="bracket" style="color:${color}">&gt;</span>` +
			`<span class="replyBlock">` +
			`<span class="replyQuote">${linkify(escapeHtml(quoted))}</span>` +
			`<span class="replyBody" style="color:${color}">${richBody(bodyText)}</span>` +
			`</span>` +
			`</span>`;
	} else {
		const who = expanded ? entry.who : clipWithEllipsis(entry.who, MAX_NAME_LEN);
		needsToggle = needsToggle || entry.who.length > MAX_NAME_LEN;
		// the whole message (name + body) is one tap target: tapping anywhere on it
		// opens the per-user action popup (DM, copy, hug/slap...). data-user carries
		// the full pubkey; links/geo/toggles inside keep their own behavior via the
		// bail check in the click handler.
		body =
			`<span class="msgTap" data-user="${escapeHtml(entry.pubkey)}">` +
			avatarHtml(entry.pubkey, { inline: true }) + // nostr avatar prefixing the name, if any
			`<span class="bracket" style="color:${color}">&lt;</span>` +
			`<span class="user" style="color:${color}">@${escapeHtml(who)}</span>` +
			`<span class="tag" style="color:${color}">#${escapeHtml(entry.tag)}</span>` +
			`<span class="bracket" style="color:${color}">&gt;</span> ` +
			`<span class="msg" style="color:${color}">${richBody(text)}</span>` +
			`</span>`;
	}

	if (needsToggle) {
		body += `<span class="toggleMore" data-toggle="${escapeHtml(entry.id)}">${escapeHtml(t(expanded ? "message.less" : "message.more"))}</span>`;
	}

	// a collapsed wall stays collapsed: a link-dump's image previews rendering
	// anyway would defeat the whole point
	if (!entry.wall || expanded) body += renderImagePreviews(entry);
	body += renderTranslation(entry);

	return body + timeTag(entry.ts) + ackTag(entry);
}

// whether a message is currently hidden by text-censorship (setting on, content
// flagged, not yet revealed). system lines are never censored.
function isMessageCensored(entry) {
	return censorMessages && !entry.system && entry.profane && !revealedMessages.has(entry.id);
}

// the complete inner html for an entry's line, including the optional #geo
// prefix. A censored message collapses to a nameless "* censored message *"
// placeholder (tap to reveal) with no prefix and no name; system + normal lines
// are unchanged. This is the single composition point for every render path.
function messageHtml(entry) {
	if (isMessageCensored(entry)) {
		return `<span class="ts censoredMsg" data-censor-reveal="${escapeHtml(entry.id)}">${escapeHtml(t("system.censored"))}</span>`;
	}
	const body = entry.system ? entry.html : messageInnerHtml(entry);
	return (focusedGeo ? "" : entry.geoPrefix || "") + body;
}

// the translation block shown beneath a message once you've translated it (or
// while it's in flight). rendered as its own legible line - accent-bordered, a
// small "translated" label, then the text at full readability - rather than the
// old dim timestamp styling.
function renderTranslation(entry) {
	if (entry.translating) {
		return `<span class="translationBlock"><span class="translationLabel">${escapeHtml(t("translate.working"))}</span></span>`;
	}
	const tr = entry.translation;
	if (!tr || !tr.text) return "";
	const label = tr.detected
		? t("translate.label_from", { lang: tr.detected.toUpperCase() })
		: t("translate.label");
	return (
		`<span class="translationBlock">` +
		`<span class="translationLabel">${escapeHtml(label)}</span>` +
		`<span class="translationText">${linkify(escapeHtml(tr.text))}</span>` +
		`</span>`
	);
}

// send-confirmation badge for our own messages, styled like the timestamp:
// "sending…" while the first attempt is in flight (so a not-yet-confirmed send
// never reads as done), "resending…" once we start rebroadcasting (the first
// attempt timed out without an echo), the round-trip latency once a source
// replays it ("<1s" / "4s") - which lingers a few seconds then clears itself
// (see confirmSent) - or "unverified" once the quick rebroadcasts are spent and
// we've dropped to the slow background recheck (still no confirmed echo, but
// never gives up outright - see scheduleUnverifiedRetry).
function ackTag(entry) {
	if (!entry.mine) return "";
	if (entry.ackSecs != null) {
		const latency = entry.ackSecs === 0 ? t("ack.latency_lt1s") : t("ack.latency_secs", { count: entry.ackSecs });
		return ` <span class="ts ack">${escapeHtml(latency)}</span>`;
	}
	if (entry.ackUnverified) return ` <span class="ts ack ackFail">${escapeHtml(t("ack.unverified"))}</span>`;
	if (entry.resending) return ` <span class="ts ack">${escapeHtml(t("ack.resending"))}</span>`;
	// still awaiting the echo-back that confirms this send propagated
	if (pending.has(entry.id)) return ` <span class="ts ack">${escapeHtml(t("ack.sending"))}</span>`;
	return ""; // historical line, or a confirmed one whose latency has since faded
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
	// channel), so only prepend it in global view. messageHtml also handles the
	// censored-message placeholder.
	div.innerHTML = messageHtml(entry);
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
	sigBump(entry, 1);

	while (entries.length > MAX_LINES) {
		const oldest = entries.shift();
		sigBump(oldest, -1);
		if (oldest.el) oldest.el.remove();
	}

	// the moment a cluster crosses into broadcast-spam territory, pull its already-
	// rendered copies out of the global feed (later copies simply won't render). in
	// a channel we're not filtering, so this only matters in the global view. the
	// flagged set makes the sweep run once per signature, not on every later copy.
	if (!focusedGeo && entry.sig && !flaggedSpamSigs.has(entry.sig) && isGlobalSpam(entry)) {
		flaggedSpamSigs.add(entry.sig);
		if (flaggedSpamSigs.size > 500) flaggedSpamSigs.clear();
		for (const e of entries) {
			if (e.sig === entry.sig && e.el) {
				e.el.remove();
				e.el = null;
			}
		}
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
	sigBump(entry, -1); // keep the spam-cluster count in step (no-op for signature-less system entries)
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
//
// themes can constrain this: when the active theme defines a color band, the
// same hash instead picks a hue inside the theme's range (with the same
// per-user sat/brightness jitter), so every name sits in the theme's palette.
function peerRgb(pubkey) {
	const h = djb2("nostr:" + pubkey.toLowerCase());
	const hueRand = Number(h % 1000n) / 1000;
	const sRand = Number((h >> 17n) & 0x3ffn) / 1023;
	const bRand = Number((h >> 27n) & 0x3ffn) / 1023;

	const band = activeTheme().band;
	if (band) {
		const hue = (((band.hue + (hueRand - 0.5) * band.spread) % 360) + 360) % 360;
		const saturation = Math.min(1, Math.max(0, band.sat / 100 + (sRand - 0.5) * 0.12));
		const brightness = Math.min(1, Math.max(0.3, band.bri / 100 + (bRand - 0.5) * 0.14));
		return hsbToRgb(hue / 360, saturation, brightness);
	}

	let hue = hueRand;
	const orange = 30 / 360;
	if (Math.abs(hue - orange) < 0.05) hue = (hue + 0.12) % 1.0; // avoid orange (reserved for "you")

	const saturation = Math.min(1, Math.max(0.5, 0.8 + (sRand - 0.5) * 0.2));
	const brightness = Math.min(1, Math.max(0.35, 0.75 + (bRand - 0.5) * 0.16));

	return hsbToRgb(hue, saturation, brightness);
}

function pubkeyRgb(pubkey) {
	// "you" render in the reserved self color - bitchat's orange, or the active
	// theme's own (tron hands you clu's orange, matrix a white glow...) - but only
	// until nostr profiles are active. once your identity is legible (avatar/name/
	// npub on show), you appear in your real per-key color, exactly as everyone
	// else already sees you.
	if (pubkey.toLowerCase() === identity.pk.toLowerCase() && !profilesActive()) {
		const self = activeTheme().self;
		return self ? hexToRgb(self) : SELF_RGB;
	}
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
	// so it stays visually cohesive (includes our own messages @-ing ourselves) -
	// unless it's a mention bomb @-ing half the channel.
	const mention = isMention(text, name) && countMentions(text) <= MENTION_BOMB_MAX;
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
		reply: parseReplyMessage(text), // { targetUser, quotedText, body } if this quotes another message
		pow: idDifficulty(ev.id), // NIP-13 leading-zero bits actually delivered
		powCommitted: committedDifficulty(ev), // difficulty its nonce tag claims (0 = no nonce)
		client: getClient(ev), // ["client",…] tag if the sender stamped one ("" if not)
		wall: looksLikeWall(text), // screen-eating content starts hard-collapsed
		images: extractImageUrls(text),
		profane: isProfane(text), // flagged once; the text-censor setting gates display live
		sig: messageSignature(text), // "" unless long enough to judge as broadcast spam

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

// live "where can i talk right now" list, for the global composer's channel
// picker. a channel is active if someone has *spoken* within the last 5
// minutes; ranked by distinct talkers, then recency. presence heartbeats
// (kind-20001 ghosts) deliberately do not count - the picker should point new
// users at rooms with real conversation, not lurkers. muted channels and
// ourselves are excluded. built from state we already hold, so it works whether
// or not server assist is on.
function activeChannels(limit = 12) {
	const cutoffSec = Math.floor((Date.now() - PRESENCE_FRESH_MS) / 1000);
	const byGeo = new Map(); // geo -> { people:Set<pubkey>, freshest:sec }

	const bump = (geo, pubkey, tsSec) => {
		if (!geo || mutedChannels.has(geo) || pubkey === identity.pk) return;
		let e = byGeo.get(geo);
		if (!e) byGeo.set(geo, (e = { people: new Set(), freshest: 0 }));
		e.people.add(pubkey);
		if (tsSec > e.freshest) e.freshest = tsSec;
	};

	for (const e of entries) {
		if (!e.system && e.geo && e.ts >= cutoffSec) bump(e.geo, e.pubkey, e.ts);
	}

	return [...byGeo]
		.map(([geo, e]) => ({ geo, count: e.people.size, freshest: e.freshest }))
		.sort((a, b) => b.count - a.count || b.freshest - a.freshest)
		.slice(0, limit);
}

function renderTopbar() {
	syncMediaBtn(); // renderTopbar fires on every mode/status change, so piggyback
	const cursor = `<span class="cursor" aria-hidden="true"></span>`;
	if (focusedGeo) {
		const clippedGeo = clipText(focusedGeo, 12);
		// the channel keeps its real case (class "chan" opts out of the topbar's
		// uppercase) so case-sensitive /join channels read faithfully - "#AB" and
		// "#ab" are different channels and should look different.
		brandEl.innerHTML = `<strong class="chan">#${escapeHtml(clippedGeo)}</strong>/<span class="handle">@${escapeHtml(clipText(name || "anon", 12))}</span>${cursor}`;

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

// the settings description blurb swaps to whatever setting you touch; it opens
// on the server-assist copy and resets there each time settings is reopened.
const DEFAULT_SETTINGS_DESC = "settings.assist_description";
let currentSettingsDesc = DEFAULT_SETTINGS_DESC;

function renderSettingsDesc() {
	settingsDesc.textContent = t(currentSettingsDesc);
}

function showSettingsDesc(key) {
	if (!key) return;
	currentSettingsDesc = key;
	renderSettingsDesc();
	settingsDesc.scrollTop = 0;
}

function openSettings() {
	assistToggle.checked = getAssistEnabled();
	profilesToggle.checked = getProfilesEnabled();
	retroToggle.checked = getRetroEnabled();
	clientToggle.checked = getClientTagEnabled();
	localToggle.checked = getLocalTagEnabled();
	blurToggle.checked = mediaSettings.censorImages;
	censorToggle.checked = censorMessages;
	powSelect.value = String(getPowFilter());
	syncProfilesRow();
	syncProfileEditVisibility();
	nsecRevealed = false;
	renderNsecField();
	setNsecStatus("");
	currentSettingsDesc = DEFAULT_SETTINGS_DESC; // reset the blurb to the default
	renderSettingsDesc();
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
		.filter((p) => p && typeof p.pubkey === "string" && !excludePubkeys.has(p.pubkey) && !isBlocked(p.pubkey))
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

// --- channel location readout (beneath the users title) ---------------------

// a geohash's cell size is pure client-side math (see geohashCell); the place
// name needs the assist api and is best-effort. session cache keyed by geohash
// (a geohash -> place never changes).
const geoPlaceCache = new Map();

// 2-letter ISO country code -> flag emoji (regional-indicator letters)
function flagEmoji(cc) {
	if (!/^[a-z]{2}$/i.test(cc || "")) return "";
	return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// distance unit follows the device's region: the handful of miles-first places
// get mi, everyone else km (matching how native picks a single unit per line).
function usesImperial() {
	try {
		const region = (new Intl.Locale(navigator.language).region || "").toUpperCase();
		return ["US", "GB", "MM", "LR"].includes(region);
	} catch {
		return false;
	}
}

// native's coverage style: a "~" prefix, one decimal below 100, whole numbers
// above (~777 mi, ~24.3 mi, ~3.0 mi, ~0.1 mi).
function formatDistance(km) {
	const imperial = usesImperial();
	const val = imperial ? km * 0.621371 : km;
	const n = val < 100 ? val.toFixed(1) : String(Math.round(val));
	return `~${n} ${imperial ? "mi" : "km"}`;
}

// tri-state: a place object (geocoded), null (api answered but it's nowhere -
// open ocean etc. -> "international"), or undefined (api unreachable / pure mode
// -> we simply don't know, show coverage only). only the first two are cached.
async function fetchGeoPlace(geo) {
	const key = geo.toLowerCase();
	if (geoPlaceCache.has(key)) return geoPlaceCache.get(key);
	try {
		// cache:"default" lets the browser reuse the api's 24h-cacheable response across reloads
		const res = await fetch(`${API_BASE}/api/geocode?geo=${encodeURIComponent(geo)}`);
		if (!res.ok) return undefined;
		const data = await res.json();
		if (!data || !data.ok) return undefined;
		const place = data.place || null; // null = confirmed non-place
		geoPlaceCache.set(key, place);
		return place;
	} catch {
		return undefined; // no api reachable (pure mode) - coverage line stands alone
	}
}

function renderUsersLocation(geo) {
	let cell;
	try {
		cell = geohashCell(geo); // throws on a non-geohash (word) channel
	} catch {
		usersLocation.hidden = true;
		usersLocation.innerHTML = "";
		return;
	}
	// meta line: the channel's coverage distance and the cell-center coordinates
	// (decimals scale with the geohash precision), bullet-separated like native.
	// always available - pure client math, offline too.
	const dp = Math.max(1, Math.min(5, geo.length - 1));
	const coords = `${cell.lat.toFixed(dp)}, ${cell.lon.toFixed(dp)}`;
	const meta = `${formatDistance(cell.spanKm)} • ${coords}`;
	usersLocation.innerHTML =
		`<div id="usersPlace" class="usersPlace"></div>` +
		`<div class="usersCoverage">${escapeHtml(meta)}</div>`;
	usersLocation.hidden = false;

	// decorate with the place name once (if) the api answers - guard against the
	// panel having closed or the channel having changed in the meantime.
	fetchGeoPlace(geo).then((place) => {
		if (focusedGeo !== geo || !usersGate.classList.contains("show")) return;
		const el = document.getElementById("usersPlace");
		if (!el || place === undefined) return; // api unreachable - leave coverage-only
		if (!place || !place.country) {
			// geocodable coordinates that resolve to nowhere (open ocean, poles...)
			el.textContent = t("users.international");
			return;
		}
		const parts = [place.city, place.region, place.country].filter(Boolean);
		const flag = flagEmoji(place.cc);
		// "~" marks an approximate sub-country locale (like native); a bare country
		// name (a 1-2 char geohash) isn't approximate - it IS the whole country.
		const approx = place.city || place.region ? "~" : "";
		el.textContent = approx + parts.join(", ") + (flag ? " " + flag : "");
	});
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
	const talking = [...latest.values()].filter((u) => !isBlocked(u.pubkey)).sort((a, b) => b.ts - a.ts);
	const talkingPubkeys = new Set(latest.keys());
	talkingPubkeys.add(identity.pk); // never show yourself as a ghost (assist snapshot includes you)

	usersTitle.textContent = t("users.title", { geo: clipText(geo, 14) });
	updateNotesButton();
	renderUsersLocation(geo);
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

	const profile = await fetchProfile(pubkey, { force: pubkey === identity.pk });
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

// --- geohash globe map ------------------------------------------------------

// live activity per geohash, from the recent message buffer: each message's
// channel scores by recency (a smooth decay over the last ~20 min), so busy
// channels glow brighter and quiet ones fade. keyed by full geohash; the map
// rolls these up to whatever depth it's showing.
const ACTIVITY_WINDOW_MS = 20 * 60_000;
function buildActivityMap() {
	const now = Date.now();
	const out = new Map();
	for (const e of entries) {
		if (e.system || !e.geo || e.geo === "?") continue;
		if (!/^[0-9a-z]{1,12}$/.test(e.geo)) continue; // geohash channels only
		// only count messages you could actually see on join: a cell shouldn't glow
		// off /clear'd, blocked, or below-pow traffic and then open empty.
		if (e.ts < clearedBefore) continue;
		if (isBlocked(e.pubkey)) continue;
		if (!entryPassesPow(e)) continue;
		const ageMs = now - e.ts * 1000;
		if (ageMs > ACTIVITY_WINDOW_MS || ageMs < -60_000) continue;
		const w = 1 - ageMs / ACTIVITY_WINDOW_MS; // 1 = just now, 0 = window edge
		out.set(e.geo, Math.min(1, (out.get(e.geo) || 0) + w * 0.5));
	}
	return out;
}

// distinct talkers per geohash within the "here" window (last 5 min), for the
// map's cell labels - same visibility rules as the activity glow and the same
// spoken-within-5-min rule the in-channel count uses. keyed by full geohash; the
// map sums these up to whatever depth it's showing.
function buildCountMap() {
	const cutoffSec = Math.floor((Date.now() - PRESENCE_FRESH_MS) / 1000);
	const byGeo = new Map(); // geo -> Set<pubkey>
	for (const e of entries) {
		if (e.system || !e.geo || e.geo === "?") continue;
		if (!/^[0-9a-z]{1,12}$/.test(e.geo)) continue;
		if (e.ts < clearedBefore || e.ts < cutoffSec) continue;
		if (isBlocked(e.pubkey)) continue;
		if (!entryPassesPow(e)) continue;
		let s = byGeo.get(e.geo);
		if (!s) byGeo.set(e.geo, (s = new Set()));
		s.add(e.pubkey);
	}
	const out = new Map();
	for (const [geo, s] of byGeo) out.set(geo, s.size);
	return out;
}

let mapInstance = null;
let mapActivityTimer = null;

function mapColors() {
	const cs = getComputedStyle(document.documentElement);
	return {
		accent: cs.getPropertyValue("--accent").trim() || "#30d158",
		fg: cs.getPropertyValue("--fg").trim() || "#8fe89c",
		muted: cs.getPropertyValue("--muted").trim() || "#7a828c",
		bg: cs.getPropertyValue("--bg").trim() || "#000",
	};
}

// --- map configuration (the title-dropdown menu) -----------------------------
// the whole map setup - overlay mode ("live" heat map vs "notes" pins) plus the
// display toggles (day/night shading, street tiles, idle globe spin) - persists
// as one blob, so the map reopens exactly the way you left it. everything but
// mode reads on the map object as an option; mode drives the overlay swap.
const STORAGE_MAP_KEY = "glub_map";
const mapConfig = loadMapConfig();

function loadMapConfig() {
	const cfg = { mode: "live", night: true, tiles: true, spin: true };
	try {
		const s = JSON.parse(localStorage.getItem(STORAGE_MAP_KEY) || "{}");
		if (s.mode === "notes") cfg.mode = "notes";
		for (const k of ["night", "tiles", "spin"]) if (s[k] === false) cfg[k] = false;
	} catch {}
	return cfg;
}
function saveMapConfig() {
	try {
		localStorage.setItem(STORAGE_MAP_KEY, JSON.stringify(mapConfig));
	} catch {}
}

function renderMapMenu() {
	for (const btn of mapMenu.querySelectorAll("[data-map-mode]")) {
		btn.querySelector(".mmMark").textContent = btn.dataset.mapMode === mapConfig.mode ? "●" : "○";
	}
	for (const btn of mapMenu.querySelectorAll("[data-map-opt]")) {
		btn.querySelector(".mmMark").textContent = mapConfig[btn.dataset.mapOpt] ? "[x]" : "[ ]";
	}
}

function toggleMapMenu(show) {
	const on = show !== undefined ? show : mapMenu.hidden;
	if (on) renderMapMenu();
	mapMenu.hidden = !on;
}

// push the current mode into the map + surrounding chrome. safe to call any
// time; the notes fetch loop only actually runs while the map gate is up.
function applyMapMode() {
	if (mapInstance) mapInstance.setMode(mapConfig.mode);
	// the hint line follows the mode; keep data-i18n in sync so a language
	// switch re-translates the right key
	const hintKey = mapConfig.mode === "notes" ? "map.hint_notes" : "map.hint";
	mapHint.setAttribute("data-i18n", hintKey);
	mapHint.textContent = t(hintKey);
	if (mapConfig.mode === "notes") {
		if (mapFeed) mapFeed.innerHTML = ""; // the live ticker has no place among pins
		if (mapGate.classList.contains("show")) startMapNotes();
	} else {
		stopMapNotes();
	}
}

function openMap() {
	if (!mapInstance) {
		mapInstance = createMap({
			canvas: mapCanvas,
			colors: mapColors,
			onPick: (gh) => {
				closeMap();
				closeUsers();
				focusChannel(gh);
			},
			// notes mode: any tap means "show me the notes here" - the sheet opens
			// over the map, so [EXIT] drops you right back on it
			onNotesPick: (gh) => openNotesForGeo(gh),
		});
		mapInstance.setOptions(mapConfig);
	}
	closeUsers();
	if (mapFeed) mapFeed.innerHTML = ""; // start the live-chat ticker empty
	mapGate.classList.add("show");
	mapInstance.setActivity(buildActivityMap(), buildCountMap());
	// the canvas has no size until the gate is visible - size it next frame
	requestAnimationFrame(() => {
		mapInstance.resize();
		// drop onto your current channel if you're focused on a geohash one
		if (focusedGeo && /^[0-9a-z]{1,12}$/.test(focusedGeo)) mapInstance.focusGeohash(focusedGeo);
		mapInstance.open();
	});
	// refresh the activity glow while the map is up (new messages keep arriving)
	clearInterval(mapActivityTimer);
	mapActivityTimer = setInterval(() => mapInstance.setActivity(buildActivityMap(), buildCountMap()), 4000);
	applyMapMode();
}

function closeMap() {
	mapGate.classList.remove("show");
	clearInterval(mapActivityTimer);
	mapActivityTimer = null;
	toggleMapMenu(false);
	stopMapNotes();
	if (mapFeed) mapFeed.innerHTML = "";
	if (mapInstance) mapInstance.close();
}

// --- map notes: fetch what's under the viewport, pin it -----------------------
// a second notes client feeds the map. the client itself retargets (and clears)
// on every open(), so pins accumulate here instead: an id-keyed store that
// survives panning - scroll around and the notes you've swept over stay pinned.
let mapNotesClient = null;
let mapNotesTimer = null;
let mapNotesPrefix = null;
const mapNotesStore = new Map(); // note id -> note
const MAP_NOTES_MAX = 500; // cap the sweep cache; oldest fall off first

function ensureMapNotesClient() {
	if (!mapNotesClient) {
		mapNotesClient = createNotesClient({
			getIdentity: () => identity,
			getRelays: geoRelaysFor,
			onChange: (snap) => {
				const now = Math.floor(Date.now() / 1000);
				for (const n of (snap && snap.notes) || []) {
					if (n.expiresAt && n.expiresAt <= now) continue;
					mapNotesStore.set(n.id, n);
				}
				pruneMapNotes(now);
				pushMapNotes();
			},
			assist: notesAssistBridge,
		});
	}
	return mapNotesClient;
}

function pruneMapNotes(nowSecs) {
	for (const [id, n] of mapNotesStore) {
		if (n.expiresAt && n.expiresAt <= nowSecs) mapNotesStore.delete(id);
	}
	if (mapNotesStore.size > MAP_NOTES_MAX) {
		const keep = [...mapNotesStore.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAP_NOTES_MAX);
		mapNotesStore.clear();
		for (const n of keep) mapNotesStore.set(n.id, n);
	}
}

function pushMapNotes() {
	if (!mapInstance) return;
	mapInstance.setNotes([...mapNotesStore.values()].filter((n) => !isBlocked(n.pubkey)));
}

// poll the view center and retarget the fetch when it moves to a new prefix.
// fetching one level above the display depth roughly covers the viewport (a
// parent cell is 32 children), and the store keeps everything already swept.
function mapNotesTick() {
	if (!mapInstance) return;
	const v = mapInstance.view();
	const prefix = v.gh.slice(0, Math.max(1, Math.min(v.gh.length, v.depth - 1)));
	if (prefix && prefix !== mapNotesPrefix) {
		mapNotesPrefix = prefix;
		ensureMapNotesClient().open(prefix);
	}
}

function startMapNotes() {
	if (mapNotesTimer) return;
	pushMapNotes(); // pins from earlier sweeps show immediately
	mapNotesTick();
	mapNotesTimer = setInterval(mapNotesTick, 1200);
}

function stopMapNotes() {
	clearInterval(mapNotesTimer);
	mapNotesTimer = null;
	mapNotesPrefix = null;
	if (mapNotesClient) mapNotesClient.close();
}

// the globe's live-chat ticker: push one fading line per live message while the
// map is open. it's ambient - a glimpse of what the world is saying right now,
// languages and all - so it stays lightweight (capped, self-removing) and never
// blocks the globe underneath (pointer-events: none in css).
const MAP_FEED_MAX = 5; // most lines visible at once; a burst evicts the oldest early
function pushMapFeed(ev, geo) {
	if (!mapFeed) return;
	const text = String(ev.content || "").replace(/\s+/g, " ").trim();
	if (!text) return;
	const who = clipWithEllipsis(getName(ev) || "anon", 14);
	const line = document.createElement("div");
	line.className = "mapFeedLine";
	line.innerHTML =
		`<span class="mfGeo">#${escapeHtml(geo)}</span> ` +
		`<span class="mfWho" style="color:${pubkeyColor(ev.pubkey)}">${escapeHtml(who)}</span> ` +
		`<span class="mfMsg">${escapeHtml(clipWithEllipsis(text, 90))}</span>`;
	line.addEventListener("animationend", () => line.remove());
	mapFeed.appendChild(line);
	while (mapFeed.childElementCount > MAP_FEED_MAX) mapFeed.firstElementChild.remove();
}

// --- location notes ---------------------------------------------------------
// bitchat's per-geohash bulletin board: persistent (stored) nostr kind-1 notes
// tagged to the focused channel's geohash + its 8 neighbors, fetched on demand
// over their own relay client (nostr/notes.js) - independent of the chat pool
// and assist mode, the same way DMs are. Notes can expire via NIP-40 and own
// notes are deletable via NIP-09.

let notesClient = null;
let notesGeo = null; // the exact channel the sheet is open on (splits local vs nearby)

// nearest-first relay urls for a channel - the same source the chat pool uses.
function geoRelaysFor(geohash) {
	if (!allRelays.length) return [];
	return sortRelaysByGeohash(allRelays, geohash).map((r) => r.url);
}

// notes are channel-scoped, so the surface only exists while focused on a real
// geohash (word-channels like #🥩 have no location and are excluded).
function notesEnabledGeo() {
	return focusedGeo && /^[0-9a-z]{1,12}$/.test(focusedGeo) ? focusedGeo : null;
}

function updateNotesButton() {
	usersNotes.hidden = !notesEnabledGeo();
}

// with server assist on, read/write notes through the API: it keeps a
// persistent cache and answers a geohash PREFIX query, so a channel gets
// every note nested under it at any depth (relays can't prefix-filter).
// shared by the channel notes sheet and the map's pin fetcher.
const notesAssistBridge = {
	isActive: () => liveSource === "assist",
	fetchNotes: async (geo) => {
		const res = await fetch(`${API_BASE}/api/notes?geo=${encodeURIComponent(geo)}`, { cache: "no-store" });
		if (!res.ok) return [];
		const data = await res.json();
		return Array.isArray(data.notes) ? data.notes : [];
	},
	publish: (event) => publishViaApi(event),
};

function ensureNotesClient() {
	if (!notesClient) {
		notesClient = createNotesClient({
			getIdentity: () => identity,
			getRelays: geoRelaysFor,
			onChange: renderNotes,
			assist: notesAssistBridge,
		});
	}
	return notesClient;
}

function openNotes() {
	const geo = notesEnabledGeo();
	if (!geo) return;
	closeUsers();
	openNotesForGeo(geo);
}

// open the notes sheet for an arbitrary geohash - this is where map pin/cell
// taps land. the map stays open (and running) underneath, so [EXIT] on the
// sheet drops you straight back onto it, and the composer posts to whatever
// cell you tapped: leave a note exactly where you're looking.
function openNotesForGeo(geo) {
	geo = String(geo || "").toLowerCase();
	if (!/^[0-9a-z]{1,12}$/.test(geo)) return;
	notesGeo = geo;
	ensureNotesClient();
	notesTitle.innerHTML = `${escapeHtml(t("notes.title"))} <span class="notesTitleGeo">#${escapeHtml(geo)}</span>`;
	notesInput.value = "";
	setNotesUploadHint("");
	updateNotesPostBtn();
	toggleNotesMenu(false);
	notesGate.classList.add("show");
	notesClient.open(geo);
}

function closeNotes() {
	notesGate.classList.remove("show");
	toggleNotesMenu(false);
	if (notesClient) notesClient.close();
}

// --- [DRAFT]: pin a note where you actually are ------------------------------
// rather than guessing your cell on the map, the browser geolocation API gives
// us a coordinate we encode to a geohash at the chosen precision, then open the
// notes sheet on it (composer posts to that exact cell). scopes mirror bitchat's
// building/city bands: length 7 ~150m up to length 4 ~40km.
function toggleNotesMenu(show) {
	const on = show !== undefined ? show : notesMenu.hidden;
	notesMenu.hidden = !on;
	notesDraft.classList.toggle("active", on);
}

function draftNoteAtScope(len) {
	toggleNotesMenu(false);
	if (!navigator.geolocation) {
		setNotesUploadHint(t("notes.loc_failed"), true);
		notesGate.classList.add("show");
		return;
	}
	// show the sheet immediately with a "locating…" status so the tap has feedback
	notesGate.classList.add("show");
	notesList.innerHTML = `<div class="notesStatus">${escapeHtml(t("notes.locating"))}</div>`;
	navigator.geolocation.getCurrentPosition(
		(pos) => {
			const gh = encodeGeohash(pos.coords.latitude, pos.coords.longitude, len);
			openNotesForGeo(gh);
			notesInput.focus();
		},
		() => {
			// keep whatever cell was open; surface the failure in the composer hint
			if (notesGeo) openNotesForGeo(notesGeo);
			else notesList.innerHTML = `<div class="notesStatus">${escapeHtml(t("notes.loc_failed"))}</div>`;
			setNotesUploadHint(t("notes.loc_failed"), true);
		},
		{ enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
	);
}

// compact "fades in 23h / 2d" for a NIP-40 expiry (epoch secs).
function notesFadesIn(expiresAt) {
	const s = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
	const d = Math.floor(s / 86400);
	const h = Math.ceil(s / 3600);
	const span = d >= 1 ? `${d}d` : h >= 1 ? `${h}h` : "<1h";
	return t("notes.fades_in", { time: span });
}

// translations of notes, keyed by note id, live here (not on the notes-client
// snapshot, which is rebuilt on every refetch) so a translated note stays
// translated across re-renders. value: { translating:true } | { text, detected }.
const noteTranslations = new Map();

// note ids the reader has expanded past the length cap. kept out of the client
// snapshot (rebuilt on refetch) so an expanded note stays open across repaints.
const expandedNotes = new Set();

// the translated-note block, mirroring chat's renderTranslation but reading the
// per-note translation map. reuses the same .translation* CSS.
function renderNoteTranslation(id, content) {
	const tr = noteTranslations.get(id);
	if (!tr) return "";
	if (tr.translating) {
		return `<span class="translationBlock"><span class="translationLabel">${escapeHtml(t("translate.working"))}</span></span>`;
	}
	if (!tr.text) return "";
	const label = tr.detected
		? t("translate.label_from", { lang: tr.detected.toUpperCase() })
		: t("translate.label");
	return (
		`<span class="translationBlock">` +
		`<span class="translationLabel">${escapeHtml(label)}</span>` +
		`<span class="translationText">${linkify(escapeHtml(tr.text))}</span>` +
		`</span>`
	);
}

function noteRowHtml(n) {
	const who = (n.name || "").trim() || "anon";
	const color = pubkeyColor(n.pubkey);
	// the cell the note was actually posted to - shown so you can see which
	// channel under here it came from (a #9q view surfaces #9qh5 notes, etc).
	const origin = `<span class="noteGeo">#${escapeHtml(clipText(n.geohash, 12))}</span>`;
	const expiry = n.expiresAt
		? `<span class="noteExpiry">· ${escapeHtml(notesFadesIn(n.expiresAt))}</span>`
		: "";
	const del = n.mine
		? `<button class="noteDelete" data-note-del="${escapeHtml(n.id)}">${escapeHtml(t("notes.delete"))}</button>`
		: "";
	// same safety cap as chat messages: collapse an over-long body behind a
	// more/less toggle (with an absolute ceiling even when expanded) so one giant
	// note can't blow out the list. our composer caps at 500, but notes from other
	// clients carry no such limit.
	const raw = String(n.content || "").slice(0, HARD_MAX_MSG_LEN);
	const expanded = expandedNotes.has(n.id);
	const shown = expanded ? raw : clipWithEllipsis(raw, MAX_MSG_LEN);
	const toggle = raw.length > MAX_MSG_LEN
		? `<span class="toggleMore" data-note-toggle="${escapeHtml(n.id)}">${escapeHtml(t(expanded ? "message.less" : "message.more"))}</span>`
		: "";
	// the row is tappable (data-note-id + data-pubkey) to open the action popup -
	// translate/copy/mention/dm/block - just like tapping a chat message.
	return (
		`<div class="noteItem${n.mine ? " mine" : ""}" data-note-id="${escapeHtml(n.id)}" data-pubkey="${escapeHtml(n.pubkey)}">` +
		`<div class="noteMeta">` +
		`<span class="noteAuthor" style="color:${color}">@${escapeHtml(clipText(who, 22))}</span>` +
		origin +
		`<span class="noteTime">${escapeHtml(formatAgo(n.createdAt))}</span>` +
		expiry +
		del +
		`</div>` +
		`<div class="noteBody">${linkify(escapeHtml(shown))}${toggle}</div>` +
		// image previews, same blurred tap-to-reveal treatment as chat (renderImage-
		// Previews reads .id + .images, so a lightweight shim is all it needs)
		renderImagePreviews({ id: n.id, images: extractImageUrls(n.content) }) +
		renderNoteTranslation(n.id, n.content) +
		`</div>`
	);
}

function renderNotes(snapshot) {
	const snap = snapshot || (notesClient ? notesClient.getState() : { state: "idle", notes: [] });
	// blocking a note author hides their notes too, mirroring the chat feed
	const notes = (snap.notes || []).filter((n) => !isBlocked(n.pubkey));
	if (!notes.length) {
		const key =
			snap.state === "no_relays" ? "notes.no_relays" : snap.state === "loading" ? "notes.loading" : "notes.empty";
		notesList.innerHTML = `<div class="notesStatus">${escapeHtml(t(key))}</div>`;
		return;
	}
	// drop expand-state for notes no longer present (channel switch, expiry) so the
	// set can't accrue stale ids across visits
	if (expandedNotes.size) {
		const live = new Set(notes.map((n) => n.id));
		for (const id of expandedNotes) if (!live.has(id)) expandedNotes.delete(id);
	}
	// two sections, each newest-first (the client already hands us reverse-chron):
	// notes pinned to THIS exact cell up top, then everything from the surrounding
	// neighborhood (neighbors + deeper-nested + broader-scoped) under a divider.
	const local = [];
	const nearby = [];
	for (const n of notes) (n.geohash === notesGeo ? local : nearby).push(n);
	let html = local.map(noteRowHtml).join("");
	if (nearby.length) {
		html +=
			`<div class="usersBarrier notesBarrier">${escapeHtml(t("notes.nearby"))}</div>` +
			nearby.map(noteRowHtml).join("");
	}
	notesList.innerHTML = html;
}

// find a note by id in the current snapshot (for the action popup + translate)
function noteById(id) {
	const snap = notesClient ? notesClient.getState() : null;
	return snap ? (snap.notes || []).find((n) => n.id === id) : null;
}

// tapping a note opens the same action popup as a chat message, scoped to notes
// (translate/copy/mention/dm/block). bails on the delete button + links so those
// keep their own behavior, and on a text selection.
function openNoteActionPopup(note) {
	const pubkey = note.pubkey;
	const name = (note.name || "").trim() || displayNameForPubkey(pubkey) || "anon";
	actionContext = { pubkey, name, geo: note.geohash || "", content: note.content || "", entryId: null, noteId: note.id };
	// notes carry no PoW, but may carry a client tag - show it like chat does
	const clientBadge = note.client
		? ` <span class="clientBadge">${escapeHtml(t("actions.client_badge", { name: clipText(note.client, 24) }))}</span>`
		: "";
	actionTitle.innerHTML = handleHtml(name, pubkey) + clientBadge;
	actionPreview.textContent = note.content || "";
	actionPreview.hidden = !note.content;
	const isSelf = pubkey.toLowerCase() === identity.pk.toLowerCase();
	// notes action set: translate, copy, mention, dm, block. reply/hug/slap are
	// chat-channel concepts that don't map to a note, so they're hidden.
	actionDm.hidden = isSelf;
	actionBlock.hidden = isSelf;
	// notes swap the chat "mention" for "copy npub" (there's no channel context to
	// mention into from a note, but grabbing the author's npub is useful)
	actionMention.hidden = true;
	actionCopyNpub.hidden = false;
	actionReply.hidden = true;
	actionHug.hidden = true;
	actionSlap.hidden = true;
	actionGrid.classList.add("solo"); // only one action remains - let it span full width
	actionTranslate.hidden = liveSource !== "assist" || !note.content.trim();
	const tr = noteTranslations.get(note.id);
	actionTranslate.textContent = tr && tr.text ? t("actions.untranslate") : t("actions.translate");
	actionGate.classList.add("show");
}

// translate a tapped note (assist api), storing the result in noteTranslations
// and repainting the list. mirrors translateTapped for chat.
async function translateTappedNote() {
	const ctx = actionContext;
	closeActionPopup();
	if (!ctx || !ctx.noteId) return;
	const id = ctx.noteId;
	const existing = noteTranslations.get(id);
	if (existing && existing.text) {
		noteTranslations.delete(id); // toggle off
		renderNotes();
		return;
	}
	noteTranslations.set(id, { translating: true });
	renderNotes();
	const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	try {
		const res = await fetch(`${API_BASE}/api/translate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: ctx.content, target: preferredContentLanguage() }),
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok && data.ok && data.text && norm(data.text) !== norm(ctx.content)) {
			noteTranslations.set(id, { text: data.text, detected: data.detected || "" });
		} else {
			noteTranslations.delete(id);
			if (res.ok && data.ok && data.text) appendSystem(t("translate.same"));
			else appendSystem(t(res.status === 503 ? "translate.unavailable" : "translate.failed"));
		}
	} catch {
		noteTranslations.delete(id);
		appendSystem(t("translate.failed"));
	}
	renderNotes();
}

function updateNotesPostBtn() {
	notesPost.disabled = !notesInput.value.trim();
}

function submitNote() {
	const content = notesInput.value.trim();
	if (!content || !notesClient) return;
	if (NSEC_RE.test(content)) {
		appendSystem(t("system.nsec_blocked"));
		return;
	}
	const expiresInSecs = Number(notesExpiry.value) || 0;
	const res = notesClient.post({ content, name, expiresInSecs, client: outgoingClient() });
	if (!res.ok) return;
	notesInput.value = "";
	updateNotesPostBtn();
}

// --- note image attach (nostr.build) ----------------------------------------
// notes can persist forever, so their media needs a permanent host - the api's
// media store is temporary. Uploads go straight from the browser to nostr.build
// (NIP-96 + NIP-98, signed with the local identity key; no api key, no server
// hop, works with assist on or off) and the returned url is appended to the
// note text, where it renders through the existing image-preview path.

let notesUploadBusy = false;
let notesHintTimer = null;

function setNotesUploadHint(text, isError) {
	clearTimeout(notesHintTimer);
	notesUploadHint.textContent = text || "";
	notesUploadHint.classList.toggle("error", !!isError);
	if (isError) {
		notesHintTimer = setTimeout(() => {
			notesUploadHint.textContent = "";
			notesUploadHint.classList.remove("error");
		}, 5000);
	}
}

async function attachNoteImage(file) {
	if (!file || notesUploadBusy) return;
	if (!file.type.startsWith("image/")) return;
	if (file.size > NOSTR_BUILD_MAX_BYTES) {
		setNotesUploadHint(t("notes.too_large", { max: NOSTR_BUILD_MAX_MB }), true);
		return;
	}
	notesUploadBusy = true;
	notesAttach.disabled = true;
	setNotesUploadHint(t("notes.uploading"));
	try {
		const { url } = await uploadImageToNostrBuild(file, identity);
		// append the hosted url to whatever's typed; it ships inside the note text
		const cur = notesInput.value.replace(/\s+$/, "");
		notesInput.value = cur ? `${cur} ${url}` : url;
		updateNotesPostBtn();
		setNotesUploadHint("");
	} catch {
		setNotesUploadHint(t("notes.upload_failed"), true);
	}
	notesUploadBusy = false;
	notesAttach.disabled = false;
}

// --- nostr profile editing (kind-0 metadata) --------------------------------
// Edit your own public nostr profile from settings: display name / bio / zap
// address (lud16) / nip05 / website, plus an avatar + banner uploaded to
// nostr.build. A save MERGES onto your current kind-0 (so fields set in other
// clients aren't clobbered) and republishes the whole directory to the profile
// relays - see nostr/profileEdit.js. Gated on the "nostr profiles" setting;
// publishing works relay-direct regardless of server assist.

let profileEditLoaded = false; // has the form been prefilled this session?
let profileEditLoadedPk = null; // the identity that prefill belongs to
let loadedProfileContent = {}; // the full kind-0 json we merge onto at save
let profilePicUrl = ""; // current avatar url (prefilled / freshly uploaded)
let profileBannerUrl = ""; // current banner url
let profileUploadTarget = null; // "picture" | "banner" while the file dialog is open
let profileUploadBusy = false;
let profileSaveBusy = false;

// show/hide the editor with the profiles setting; kick a one-time prefill when
// it first becomes visible.
function syncProfileEditVisibility() {
	const show = getProfilesEnabled();
	profileEditSection.hidden = !show;
	if (show) loadProfileEdit();
}

function renderProfileImages() {
	profileEditAvatarImg.hidden = !profilePicUrl;
	if (profilePicUrl) profileEditAvatarImg.src = profilePicUrl;
	profileEditBannerImg.hidden = !profileBannerUrl;
	if (profileBannerUrl) profileEditBannerImg.src = profileBannerUrl;
}

function setProfileEditStatus(text, kind) {
	profileEditStatus.textContent = text || "";
	profileEditStatus.className = `profileEditSaveStatus ${kind || ""}`;
}

function setProfileUploadStatus(text, isError) {
	profileEditUploadStatus.textContent = text || "";
	profileEditUploadStatus.classList.toggle("error", !!isError);
}

// fetch the current kind-0 and fill the form. Done once per identity per session
// (re-reading on every settings-open would hammer relays); a rotate/import that
// reloads the page resets it, and a changed identity re-fetches.
async function loadProfileEdit() {
	if (profileEditLoaded && profileEditLoadedPk === identity.pk) return;
	profileEditLoaded = true;
	profileEditLoadedPk = identity.pk;
	setProfileEditStatus(t("settings.profile_loading"));
	let content = {};
	try {
		const res = await fetchProfileMetadata(identity.pk);
		content = res.content || {};
	} catch {
		content = {};
	}
	if (profileEditLoadedPk !== identity.pk) return; // identity changed mid-fetch
	loadedProfileContent = content;
	const str = (v) => (typeof v === "string" ? v : "");
	profileEditName.value = str(content.name) || str(content.display_name);
	profileEditAbout.value = str(content.about);
	profileEditLud16.value = str(content.lud16);
	profileEditNip05.value = str(content.nip05);
	profileEditWebsite.value = str(content.website);
	profilePicUrl = str(content.picture);
	profileBannerUrl = str(content.banner);
	renderProfileImages();
	setProfileEditStatus("");
}

async function uploadProfileImage(file, target) {
	if (!file || profileUploadBusy) return;
	if (!file.type.startsWith("image/")) return;
	if (file.size > NOSTR_BUILD_MAX_BYTES) {
		setProfileUploadStatus(t("notes.too_large", { max: NOSTR_BUILD_MAX_MB }), true);
		return;
	}
	profileUploadBusy = true;
	profileEditAvatarBtn.disabled = true;
	profileEditBannerBtn.disabled = true;
	setProfileUploadStatus(t("notes.uploading"));
	try {
		const { url } = await uploadImageToNostrBuild(file, identity);
		if (target === "banner") profileBannerUrl = url;
		else profilePicUrl = url;
		renderProfileImages();
		setProfileUploadStatus("");
	} catch {
		setProfileUploadStatus(t("notes.upload_failed"), true);
	}
	profileUploadBusy = false;
	profileEditAvatarBtn.disabled = false;
	profileEditBannerBtn.disabled = false;
}

profileEditAvatarBtn.addEventListener("click", () => {
	profileUploadTarget = "picture";
	profileEditFile.click();
});
profileEditBannerBtn.addEventListener("click", () => {
	profileUploadTarget = "banner";
	profileEditFile.click();
});
profileEditFile.addEventListener("change", () => {
	const file = profileEditFile.files && profileEditFile.files[0];
	const target = profileUploadTarget;
	profileEditFile.value = ""; // reset so the same file can be re-picked
	if (file) uploadProfileImage(file, target);
});

async function saveProfile() {
	if (profileSaveBusy) return;
	profileSaveBusy = true;
	profileEditSave.disabled = true;
	setProfileEditStatus(t("settings.profile_saving"));

	// merge onto whatever we loaded (preserving keys we don't surface); a cleared
	// text field deletes its key rather than writing an empty string.
	const merged = { ...loadedProfileContent };
	const setOrDel = (key, val) => {
		const v = (val || "").trim();
		if (v) merged[key] = v;
		else delete merged[key];
	};
	setOrDel("name", profileEditName.value);
	setOrDel("about", profileEditAbout.value);
	setOrDel("lud16", profileEditLud16.value);
	setOrDel("nip05", profileEditNip05.value);
	setOrDel("website", profileEditWebsite.value);
	if (profilePicUrl) merged.picture = profilePicUrl;
	else delete merged.picture;
	if (profileBannerUrl) merged.banner = profileBannerUrl;
	else delete merged.banner;

	try {
		const event = makeProfileEvent({
			content: JSON.stringify(merged),
			sk: identity.sk,
			pk: identity.pk,
			client: outgoingClient(),
		});
		const { accepted } = await publishProfileMetadata(event);
		loadedProfileContent = merged; // a follow-up save merges onto the new state
		if (accepted > 0) {
			setProfileEditStatus(t("settings.profile_saved", { count: accepted }), "ok");
			bustSelfProfile();
		} else {
			setProfileEditStatus(t("settings.profile_save_failed"), "error");
		}
	} catch {
		setProfileEditStatus(t("settings.profile_save_failed"), "error");
	}
	profileSaveBusy = false;
	profileEditSave.disabled = false;
}

profileEditSave.addEventListener("click", saveProfile);

// after a successful publish, drop our cached self-profile so the app re-pulls
// the fresh kind-0 (avatar/name reflect without a reload) - only meaningful when
// profiles are active (the api supplies avatars).
function bustSelfProfile() {
	const pk = identity.pk;
	profileCache.delete(pk);
	profileFetchedAt.delete(pk);
	if (profilesActive()) {
		fetchProfile(pk);
		repaintProfile(pk);
	}
}

// ===========================================================================
// Direct messages (bitchat NIP-17 gift wraps). E2E-encrypted with the local
// key, so this rides its own always-on relay client independent of assist mode.
// See nostr/dm.js for the wire protocol.
// ===========================================================================

// pubkey(lower) -> { pubkey, name, messages: [{ id, mine, content, ts, status }], unread, readSent:Set }
const conversations = new Map();
let activeDmPubkey = null; // pubkey of the open thread, or null

// --- local DM history --------------------------------------------------------
// conversations persist to localStorage so a reload restores BOTH sides of a
// thread. relays only ever replay gift wraps addressed to us - our own sent
// wraps are addressed to the recipient (under throwaway keys), so without this
// your half of every conversation would vanish on reload. replayed wraps dedup
// against the restored messages by id, and restored unread counts carry over,
// so reloading is seamless instead of "everything is new and half is missing".
// the store is owned by the current identity; a different key starts fresh.
const STORAGE_DMS_KEY = "glub_dms";
const DMS_MAX_CONVOS = 30; // most-recent conversations kept
const DMS_MAX_MSGS = 200; // most-recent messages kept per conversation

let saveDmsTimer = null;

function scheduleSaveDms() {
	if (saveDmsTimer) return;
	saveDmsTimer = setTimeout(() => {
		saveDmsTimer = null;
		saveDmHistory();
	}, 400); // batch bursts (backlog replay, rapid exchanges) into one write
}

function saveDmHistory() {
	try {
		const convos = [...conversations.values()]
			.filter((c) => c.messages.length)
			.sort((a, b) => lastTs(b) - lastTs(a))
			.slice(0, DMS_MAX_CONVOS)
			.map((c) => ({
				pubkey: c.pubkey,
				name: c.name,
				unread: c.unread,
				readSent: [...c.readSent], // receipts already sent - don't re-send after reload
				messages: c.messages.slice(-DMS_MAX_MSGS),
			}));
		localStorage.setItem(STORAGE_DMS_KEY, JSON.stringify({ owner: identity.pk.toLowerCase(), convos }));
	} catch {
		// quota/serialization trouble - history just won't survive this reload
	}
}

function loadDmHistory() {
	let stored;
	try {
		stored = JSON.parse(localStorage.getItem(STORAGE_DMS_KEY) || "null");
	} catch {
		return;
	}
	if (!stored || stored.owner !== identity.pk.toLowerCase() || !Array.isArray(stored.convos)) return;
	for (const c of stored.convos) {
		if (!c || typeof c.pubkey !== "string" || !Array.isArray(c.messages)) continue;
		conversations.set(c.pubkey, {
			pubkey: c.pubkey,
			name: typeof c.name === "string" ? c.name : "anon",
			unread: Number(c.unread) || 0,
			readSent: new Set(Array.isArray(c.readSent) ? c.readSent : []),
			messages: c.messages.filter((m) => m && typeof m.id === "string"),
		});
	}
}
let actionContext = null; // { pubkey, name, geo, content } for the open action popup
let pendingReply = null; // { pubkey, name, geo, quoted } while composing a reply

const dmClient = createDmClient({
	getIdentity: () => identity,
	onMessage: onDmMessage,
	onAck: onDmAck,
	onStatusChange: () => {},
});
// console helper for interop debugging: call glubDmStats() to see how many gift
// wraps arrived and where they dropped (verify/decrypt/decode) vs surfaced.
window.glubDmStats = () => dmClient.stats();

// restore both sides of every conversation before the relay backlog replays
// (replays dedup against these by message id), and re-show the unread pill for
// anything that was genuinely unread when the last session ended.
loadDmHistory();
updateDmPill();

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
// appears when there are unread DMs and hides once you're caught up; otherwise
// the contacts list is reached by opening any DM and hitting exit.
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
		// notification lines are capped (burst of 3, then ~3/min): a DM flood
		// still lands in the inbox and counts on the pill, but can't turn the
		// chat feed into a wall of "new message from" notices.
		if (allowDmNotify()) appendSystem(t("dm.received", { name: conv.name }), SYSTEM_TTL_LONG_MS);
	}
	updateDmPill();
	if (dmListGate.classList.contains("show")) renderDmList();
	scheduleSaveDms();
}

// token bucket for the in-feed DM notices (see onDmMessage)
const dmNotifyBucket = { tokens: 3, last: Date.now() };
function allowDmNotify() {
	const now = Date.now();
	dmNotifyBucket.tokens = Math.min(3, dmNotifyBucket.tokens + ((now - dmNotifyBucket.last) / 1000) * 0.05);
	dmNotifyBucket.last = now;
	if (dmNotifyBucket.tokens < 1) return false;
	dmNotifyBucket.tokens -= 1;
	return true;
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
	scheduleSaveDms();
}

// --- action popup (tap a user) ---------------------------------------------

function openActionPopup(pubkey, entry) {
	const name = entry && !entry.system ? entry.who : displayNameForPubkey(pubkey);
	// for a reply, act on the reply body (not the raw "> @user: quote" wire form)
	// so the preview/copy/quote stay clean.
	const content = entry && entry.reply ? entry.reply.body : (entry && entry.text) || "";
	// keep the channel + text of the tapped message so copy/reply/hug/slap act on
	// the right thing (in global view the message may be from a channel you're not in).
	actionContext = {
		pubkey,
		name,
		geo: (entry && entry.geo) || focusedGeo || "",
		content,
		entryId: entry && entry.id ? entry.id : null, // translate acts on the stored entry
	};
	// handle line, with the tapped message's delivered proof-of-work appended as a
	// muted badge - a way to eyeball a sender's effort without cluttering chat.
	const powBadge =
		entry && !entry.system && typeof entry.pow === "number"
			? ` <span class="powBadge">${escapeHtml(t("actions.pow_badge", { n: entry.pow }))}</span>`
			: "";
	// the sender's client tag, if any. omitted entirely when absent - most users
	// are native bitchat, which sends no client tag, so "unknown" would be noise.
	const clientBadge =
		entry && !entry.system && entry.client
			? ` <span class="clientBadge">${escapeHtml(t("actions.client_badge", { name: clipText(entry.client, 24) }))}</span>`
			: "";
	actionTitle.innerHTML = handleHtml(name, pubkey) + powBadge + clientBadge;
	// cropped preview of the tapped message, so you can see what you're acting on
	actionPreview.textContent = content;
	actionPreview.hidden = !content;
	// can't DM or block yourself
	const isSelf = pubkey.toLowerCase() === identity.pk.toLowerCase();
	actionDm.hidden = isSelf;
	actionBlock.hidden = isSelf;
	// restore the chat-only actions (a preceding note popup may have hidden them)
	actionReply.hidden = false;
	actionHug.hidden = false;
	actionSlap.hidden = false;
	actionMention.hidden = false;
	actionCopyNpub.hidden = true; // notes-only action
	actionGrid.classList.remove("solo"); // full 2x2 quick-actions grid
	// translation runs through the assist api; hide it when the api isn't live, or
	// when there's no real message text / no stored entry to attach the result to.
	actionTranslate.hidden = liveSource !== "assist" || !content.trim() || !actionContext.entryId;
	// once translated, the button offers to hide it again (a clean toggle)
	const tappedEntry = actionContext.entryId ? entries.find((e) => e.id === actionContext.entryId) : null;
	actionTranslate.textContent = tappedEntry && tappedEntry.translation ? t("actions.untranslate") : t("actions.translate");
	actionGate.classList.add("show");
}

// copy the tapped message's text to the clipboard
async function copyTappedMessage() {
	const text = actionContext && actionContext.content;
	closeActionPopup();
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		appendSystem(t("system.msg_copied"));
	} catch {
		appendSystem(t("system.copy_failed"));
	}
}

// copy the tapped author's npub (bech32 pubkey) - the notes-popup action
async function copyTappedNpub() {
	const pubkey = actionContext && actionContext.pubkey;
	closeActionPopup();
	if (!pubkey) return;
	try {
		await navigator.clipboard.writeText(pkToNpub(pubkey));
		appendSystem(t("profile.npub_copied"));
	} catch {
		appendSystem(t("profile.npub_copy_failed"));
	}
}

// send a hug/slap emote into the tapped message's channel. other-user emotes use
// bitchat's exact wording (so native clients recognize them); self-emotes use our
// own comedic templates.
function sendEmote(kind) {
	const ctx = actionContext;
	closeActionPopup();
	if (!ctx || !ctx.geo) return;
	const me = clipText(name || "anon", 24);
	const them = clipText(ctx.name || "anon", 24);
	const isSelf = ctx.pubkey.toLowerCase() === identity.pk.toLowerCase();
	const key = `emote.${kind}${isSelf ? "_self" : ""}`;
	transmit(t(key, { me, them }), ctx.geo);
}

function closeActionPopup() {
	actionGate.classList.remove("show");
	actionContext = null;
}

// prefill the composer with "@name " (prefixed with "#geo " when you're in the
// global feed so the send still targets the right channel), then focus it.
function startMention() {
	const ctx = actionContext;
	closeActionPopup();
	if (!ctx) return;
	if (ctx.noteId) closeNotes(); // mentioning from a note: reveal the composer behind it
	cancelReply(); // a mention replaces whatever you were composing
	const prefix = focusedGeo ? "" : `#${ctx.geo} `;
	chatInput.value = `${prefix}@${ctx.name} `;
	chatInput.focus();
	chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
	refreshSuggest();
}

// arm a reply to the tapped message: remember who/where/what we're quoting and
// show the reply banner above the composer. the next send quotes it.
function startReply() {
	const ctx = actionContext;
	closeActionPopup();
	if (!ctx || !ctx.geo) return;
	const quoted = clipText(String(ctx.content || "").replace(/\s+/g, " ").trim(), 120);
	pendingReply = { pubkey: ctx.pubkey, name: ctx.name, geo: ctx.geo, quoted };
	replyBannerText.textContent = t("actions.reply_banner", { name: ctx.name });
	replyBanner.hidden = false;
	chatInput.placeholder = t("composer.placeholder_reply", { name: ctx.name });
	chatInput.focus();
}

function cancelReply() {
	pendingReply = null;
	replyBanner.hidden = true;
	updatePlaceholder();
}

// block the tapped user for this session: their messages vanish from the feed
// and roster immediately. purely local - nothing is broadcast. reversible in-
// session with /unblock.
function blockUser() {
	const ctx = actionContext;
	closeActionPopup();
	if (!ctx || ctx.pubkey.toLowerCase() === identity.pk.toLowerCase()) return;
	blockedPubkeys.add(ctx.pubkey.toLowerCase());
	rerenderTerminal();
	if (usersGate.classList.contains("show")) openUsers();
	if (notesGate.classList.contains("show")) renderNotes(); // blocked authors' notes vanish too
	appendSystem(t("system.blocked", { name: clipText(ctx.name || "anon", 24), tag: ctx.pubkey.slice(-4) }));
}

// translate the tapped message into your ui language via the assist api, and
// render the result under it. a second tap on an already-translated message
// hides the translation (clean toggle).
async function translateTapped() {
	const ctx = actionContext;
	closeActionPopup();
	if (!ctx || !ctx.entryId) return;
	const entry = entries.find((e) => e.id === ctx.entryId);
	if (!entry) return;

	if (entry.translation) {
		// toggle off
		entry.translation = null;
		rerenderEntryEl(entry);
		return;
	}

	entry.translating = true;
	rerenderEntryEl(entry);
	try {
		const res = await fetch(`${API_BASE}/api/translate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// target the language the user reads (browser preference / manual
			// override), not the ui locale - translation supports far more
			// languages than we have ui dictionaries for.
			body: JSON.stringify({ text: ctx.content, target: preferredContentLanguage() }),
		});
		const data = await res.json().catch(() => ({}));
		entry.translating = false;
		// strip everything but letters/numbers so punctuation or spacing tweaks
		// don't count as a "different" translation
		const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
		if (res.ok && data.ok && data.text) {
			if (norm(data.text) === norm(ctx.content)) {
				// the message was already in the reader's language - say so quietly
				// instead of rendering an identical copy under it
				appendSystem(t("translate.same"));
			} else {
				entry.translation = { text: data.text, detected: data.detected || "" };
			}
		} else {
			// 503 = provider not configured; anything else = a transient failure
			appendSystem(t(res.status === 503 ? "translate.unavailable" : "translate.failed"));
		}
	} catch {
		entry.translating = false;
		appendSystem(t("translate.failed"));
	}
	rerenderEntryEl(entry);
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

// send read receipts for any of their messages we haven't acked yet - but only
// in conversations we've actually engaged with (we've sent them something).
// merely opening an unsolicited thread shouldn't signal "seen" to a stranger:
// read receipts are an engagement signal, and spam that gets read-confirmed
// invites more spam. (delivered acks still flow - that's protocol plumbing.)
function markConversationRead(conv) {
	if (conv.unread) {
		conv.unread = 0;
		updateDmPill();
	}
	const engaged = conv.messages.some((m) => m.mine);
	for (const m of conv.messages) {
		if (!m.mine && engaged && !conv.readSent.has(m.id)) {
			conv.readSent.add(m.id);
			dmClient.sendRead(m.id, conv.pubkey);
		}
	}
	scheduleSaveDms();
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

// exiting a conversation drops back to the DM contacts list (not straight to
// the public feed); the contacts list's own exit is what returns to chat. this
// also makes the contacts screen reachable with no command: tap a user -> dm ->
// exit lands you there.
function closeDm() {
	dmGate.classList.remove("show");
	activeDmPubkey = null;
	openDmList();
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
	scheduleSaveDms();
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

// --- panic wipe (triple-tap the brand, like native bitchat's title) ----------
// three taps inside a second nukes everything local: localStorage is cleared
// (nsec, name, DM history, mutes, theme, every preference), a fresh random name
// is written for the new identity, and the page reloads - the reload is the
// actual wipe, since no in-memory state (feed, conversations, caches, blocks)
// can survive it. a fresh keypair mints itself on boot because glub_sk is gone.
function panic() {
	const anon = randomAnonName();
	try {
		localStorage.clear();
		setStoredName(anon); // land directly in chat as a fresh anon - no name gate
		sessionStorage.setItem("glub_panic", "1"); // one-shot boot notice after the reload
	} catch {
		// storage may be unavailable (private mode edge) - reload still resets the session
	}
	location.reload();
}

// single tap still opens the name gate, but on a short fuse so a triple-tap can
// preempt it (the gate is a full-screen overlay - once it opens, later taps
// would never reach the brand).
let brandTaps = [];
let brandOpenTimer = null;
brandEl.addEventListener("click", () => {
	const now = Date.now();
	brandTaps = brandTaps.filter((t) => now - t < 900);
	brandTaps.push(now);
	if (brandTaps.length >= 3) {
		clearTimeout(brandOpenTimer);
		brandOpenTimer = null;
		brandTaps = [];
		panic();
		return;
	}
	clearTimeout(brandOpenTimer);
	brandOpenTimer = setTimeout(openNameGate, 350);
});

// tapping the topbar envelope opens the DM inbox
dmPill.addEventListener("click", openDmList);

// --- DM event wiring ---

// tap a message -> per-user action popup. bail on any interactive child (channel
// link, url, more/less, image) so those keep their own behavior, and bail when
// the user is selecting text rather than tapping.
terminal.addEventListener("click", (e) => {
	const chip = e.target.closest(".payChip");
	if (chip) {
		copyPayChip(chip);
		return;
	}
	if (e.target.closest(".inlineLink, .inlineGeo, .geo, .toggleMore, [data-img-toggle]")) return;
	if (window.getSelection && String(window.getSelection())) return; // don't hijack a text selection
	const tap = e.target.closest("[data-user]");
	if (!tap) return;
	const entry = entries.find((en) => en.el && en.el.contains(tap));
	openActionPopup(tap.dataset.user, entry || null);
});

// tap a payment chip -> copy the raw invoice/token, and flash the chip label so
// it's clear it landed on the clipboard. no wallet redirect: copy is universal
// (desktop has no lightning: handler) and keeps glub hands-off - you paste into
// whatever wallet you already trust.
let payFlashTimer = null;
function copyPayChip(chip) {
	const raw = chip.dataset.invoice || "";
	const kind = chip.dataset.kind || "";
	const label = chip.querySelector(".payChipLabel");
	const flash = (key) => {
		if (!label) return;
		label.textContent = t(key);
		chip.classList.add("copied");
		clearTimeout(payFlashTimer);
		payFlashTimer = setTimeout(() => {
			label.textContent = t("payment." + kind);
			chip.classList.remove("copied");
		}, 1500);
	};
	navigator.clipboard.writeText(raw).then(() => flash("payment.copied"), () => flash("payment.copy_failed"));
}

actionClose.addEventListener("click", closeActionPopup);
actionGate.addEventListener("click", (e) => {
	if (e.target === actionGate) closeActionPopup();
});
actionDm.addEventListener("click", () => {
	if (actionContext) openDmConversation(actionContext.pubkey);
});
actionMention.addEventListener("click", startMention);
actionCopyNpub.addEventListener("click", copyTappedNpub);
actionReply.addEventListener("click", startReply);
actionTranslate.addEventListener("click", () => {
	// same button, two subjects: a tapped note translates via the notes path, a
	// tapped chat message via the chat path.
	if (actionContext && actionContext.noteId) translateTappedNote();
	else translateTapped();
});
actionCopy.addEventListener("click", copyTappedMessage);
actionHug.addEventListener("click", () => sendEmote("hug"));
actionSlap.addEventListener("click", () => sendEmote("slap"));
actionBlock.addEventListener("click", blockUser);
replyBannerCancel.addEventListener("click", cancelReply);

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
	syncProfileEditVisibility(); // show/hide the profile editor with the setting
	if (usersGate.classList.contains("show")) openUsers(); // reflect avatars on/off
});

retroToggle.addEventListener("change", () => {
	setRetroEnabled(retroToggle.checked);
	syncRetro(); // pure CSS gate - takes effect instantly, nothing to re-render
});

clientToggle.addEventListener("change", () => {
	setClientTagEnabled(clientToggle.checked); // applies to the next event you send
});

localToggle.addEventListener("change", () => {
	setLocalTagEnabled(localToggle.checked); // on => next events omit the teleport tag
});

blurToggle.addEventListener("change", () => {
	setCensorMedia(blurToggle.checked); // on => images blur + tap-to-reveal
	rerenderTerminal();
	if (notesGate.classList.contains("show")) renderNotes();
});

censorToggle.addEventListener("change", () => {
	setCensorText(censorToggle.checked); // on => profanity-flagged messages hide
	rerenderTerminal();
});

powSelect.addEventListener("change", () => {
	setPowFilter(parseInt(powSelect.value, 10) || 0);
	// live view filter: re-run visibility over the whole buffer so raising the
	// bar hides sub-threshold lines and lowering it brings them right back.
	rerenderTerminal();
});

settingsClose.addEventListener("click", closeSettings);
// tapping the dimmed backdrop (outside the panel) dismisses settings
settingsGate.addEventListener("click", (e) => {
	if (e.target === settingsGate) closeSettings();
});
// touching any setting swaps the description blurb to that setting's copy.
// pointerdown covers mouse + touch; focusin covers keyboard tabbing.
function onSettingsInteract(e) {
	const row = e.target.closest("[data-desc]");
	if (row) showSettingsDesc(row.getAttribute("data-desc"));
}
settingsList.addEventListener("pointerdown", onSettingsInteract);
settingsList.addEventListener("focusin", onSettingsInteract);
// the name gate's own way into settings (more discoverable than the topbar)
nameGateSettings.addEventListener("click", openSettings);

usersClose.addEventListener("click", closeUsers);
usersGate.addEventListener("click", (e) => {
	if (e.target === usersGate) closeUsers();
});
usersMap.addEventListener("click", openMap);
mapClose.addEventListener("click", closeMap);
mapMenuBtn.addEventListener("click", (e) => {
	e.stopPropagation();
	toggleMapMenu();
});
mapMenu.addEventListener("click", (e) => {
	const item = e.target.closest(".mapMenuItem");
	if (!item) return;
	e.stopPropagation();
	if (item.dataset.mapMode) {
		// mode is a radio: picking one closes the menu
		if (mapConfig.mode !== item.dataset.mapMode) {
			mapConfig.mode = item.dataset.mapMode;
			saveMapConfig();
			applyMapMode();
		}
		toggleMapMenu(false);
	} else if (item.dataset.mapOpt) {
		// display toggles stay open so several can be flipped in one visit
		const k = item.dataset.mapOpt;
		mapConfig[k] = !mapConfig[k];
		saveMapConfig();
		if (mapInstance) mapInstance.setOptions(mapConfig);
		renderMapMenu();
	}
});
// any click outside the open menu dismisses it (canvas taps included)
document.addEventListener("click", (e) => {
	if (!mapMenu.hidden && !mapMenu.contains(e.target) && !mapMenuBtn.contains(e.target)) toggleMapMenu(false);
});
usersNotes.addEventListener("click", openNotes);
notesClose.addEventListener("click", closeNotes);
notesDraft.addEventListener("click", (e) => {
	e.stopPropagation();
	toggleNotesMenu();
});
notesMenu.addEventListener("click", (e) => {
	const item = e.target.closest("[data-note-scope]");
	if (!item) return;
	e.stopPropagation();
	draftNoteAtScope(parseInt(item.dataset.noteScope, 10));
});
// a tap anywhere outside the open scope menu dismisses it
document.addEventListener("click", (e) => {
	if (!notesMenu.hidden && !notesMenu.contains(e.target) && !notesDraft.contains(e.target)) toggleNotesMenu(false);
});
notesGate.addEventListener("click", (e) => {
	if (e.target === notesGate) closeNotes();
});
notesInput.addEventListener("input", updateNotesPostBtn);
// Enter posts, Shift+Enter inserts a newline (the note body is multi-line).
notesInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		submitNote();
	}
});
notesPost.addEventListener("click", submitNote);
notesAttach.addEventListener("click", () => {
	if (!notesUploadBusy) notesFile.click();
});
notesFile.addEventListener("change", () => {
	const file = notesFile.files && notesFile.files[0];
	notesFile.value = ""; // let the same file be re-picked after a failure
	attachNoteImage(file);
});
notesList.addEventListener("click", (e) => {
	const del = e.target.closest("[data-note-del]");
	if (del) {
		if (notesClient) notesClient.remove(del.getAttribute("data-note-del"));
		return;
	}
	// tap a blurred image preview to reveal it, tap again to re-blur (same store +
	// key format as chat), then repaint the list
	const imgToggle = e.target.closest("[data-img-toggle]");
	if (imgToggle && imgToggle.dataset.imgToggle) {
		const key = imgToggle.dataset.imgToggle;
		if (revealedImages.has(key)) revealedImages.delete(key);
		else revealedImages.add(key);
		renderNotes();
		return;
	}
	// expand/collapse an over-long note body in place, same as chat's more/less
	const moreToggle = e.target.closest("[data-note-toggle]");
	if (moreToggle) {
		const id = moreToggle.getAttribute("data-note-toggle");
		if (expandedNotes.has(id)) expandedNotes.delete(id);
		else expandedNotes.add(id);
		renderNotes();
		return;
	}
	if (e.target.closest(".inlineLink")) return; // links keep their own behavior
	if (window.getSelection && String(window.getSelection())) return; // don't hijack a text selection
	const item = e.target.closest("[data-note-id]");
	if (!item) return;
	const note = noteById(item.getAttribute("data-note-id"));
	if (note) openNoteActionPopup(note);
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
	entry.el.innerHTML = messageHtml(entry);
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
	entry.el.innerHTML = messageHtml(entry);
});

// tap a censored message to reveal it (one-way for the session; the whole
// message, name and all, comes back and taps normally after that)
terminal.addEventListener("click", (e) => {
	const rev = e.target.closest("[data-censor-reveal]");
	if (!rev) return;
	const id = rev.dataset.censorReveal;
	revealedMessages.add(id);
	const entry = entries.find((en) => en.id === id);
	if (entry) rerenderEntryEl(entry);
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
	if (entry.el) entry.el.innerHTML = messageHtml(entry);
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

// a theme switch changes every hashed user color (the theme's band recolors the
// whole roster), so recompute the colors baked into entries and rebuild the view.
// chrome (borders, glow, scrollbars...) follows the CSS vars on its own.
function refreshThemedColors() {
	for (const entry of entries) {
		if (entry.system || !entry.pubkey) continue;
		entry.color = pubkeyColor(entry.pubkey);
		if (entry.mention) entry.mentionTint = pubkeyTint(entry.pubkey);
	}
	rerenderTerminal();
	if (usersGate.classList.contains("show")) openUsers(); // recolor the open roster
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
async function broadcastPresence() {
	if (!focusedGeo) return;
	const geo = focusedGeo;
	// mined like chat messages (see transmit) so PoW-filtering peers list us
	const unsigned = buildPresenceEvent({
		geohash: geo,
		name: name || "anon",
		pk: identity.pk,
		client: outgoingClient(),
		teleport: outgoingTeleport(),
	});
	const nonceTag = await mineNonceTag(unsigned, POW_DIFFICULTY);
	if (nonceTag) unsigned.tags.push(nonceTag);
	if (focusedGeo !== geo) return; // hopped channels while mining - stale announce
	const event = signEvent(unsigned, identity.sk);
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
// the broadcast set has healed since) on a quick cadence for the first few
// attempts, then drop to a slow background recheck rather than giving up - a
// send that truly landed just hasn't echoed back to us yet. the entry shows
// "resending…" during the quick attempts and "unverified" once it's moved to
// the slow recheck; either clears the moment confirmSent sees the echo.
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
	const entry = entries.find((e) => e.id === id);
	if (entry && !entry.ackUnverified) {
		entry.resending = false;
		entry.ackUnverified = true;
		rerenderEntryEl(entry);
	}
	scheduleUnverifiedRetry(id);
}

// slow background recheck loop: rebroadcast on a randomized 10-30s cadence,
// indefinitely, until confirmSent clears `id` from `pending`. jittered so a
// batch of unverified sends doesn't all retry in lockstep.
function scheduleUnverifiedRetry(id) {
	const rec = pending.get(id);
	if (!rec) return;
	const delay = UNVERIFIED_RETRY_MIN_MS + Math.random() * (UNVERIFIED_RETRY_MAX_MS - UNVERIFIED_RETRY_MIN_MS);
	clearTimeout(rec.timer);
	rec.timer = setTimeout(() => {
		const r = pending.get(id);
		if (!r) return;
		r.attempts += 1;
		deliver(r.event);
		scheduleUnverifiedRetry(id);
	}, delay);
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
	// the latency reads as a brief confirmation, then clears itself - it's no
	// longer in `pending`, so with ackSecs gone the badge falls back to blank.
	setTimeout(() => {
		entry.ackSecs = null;
		rerenderEntryEl(entry);
	}, ACK_LATENCY_TTL_MS);
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

// inbound anti-spam (see ratelimit.js): iOS bitchat's dual token buckets on
// chat, a looser sender-only bucket on presence. our own events always pass -
// filtering must never eat the echo that confirms a send. stats surface via
// the glubSpamStats() console helper.
const chatLimiter = createMessageRateLimiter();
const presenceLimiter = createPresenceRateLimiter();
const spamStats = { mined: 0, presenceDrops: 0, powDrops: 0 };
window.glubSpamStats = () => ({ ...chatLimiter.stats, ...spamStats });

function isOwnEvent(ev) {
	return ev.pubkey.toLowerCase() === identity.pk.toLowerCase();
}

// presence-only NIP-13 gate (android's semantics). chat uses the equivalent
// entryPassesPow() as a live VIEW filter instead of dropping here, so sliding
// the level restores/hides stored messages instantly; presence has no stored
// buffer to re-filter, so it's gated at ingest and repopulates on the next
// heartbeat. own events always pass.
function presencePassesPow(ev) {
	const required = getPowFilter();
	if (!required || isOwnEvent(ev)) return true;
	if (committedDifficulty(ev) < required || idDifficulty(ev.id) < required) {
		spamStats.powDrops++;
		return false;
	}
	return true;
}

// `live` = arrived after its source's EOSE (or via the assist live stream), as
// opposed to a stored-backlog replay. rate buckets only bite live events: a
// backlog replay compresses hours of legitimate history into one burst of
// arrivals, and metering that by arrival time would eat real messages on every
// reload. backlog damage is separately bounded (REQ limit + MAX_LINES buffer).
function ingestEvent(ev, live = true) {
	if (ev.kind === PRESENCE_KIND) {
		if (!presencePassesPow(ev)) return;
		if (live && !isOwnEvent(ev) && !presenceLimiter.allow("nostr:" + ev.pubkey.toLowerCase())) {
			spamStats.presenceDrops++;
			return;
		}
		trackPresence(ev);
		return;
	}
	if (ev.kind !== CHAT_KIND) return;
	if (!getGeohash(ev)) return;
	// chat pow is a view filter (entryPassesPow), not an ingest drop - see above
	// reject far-future timestamps (a skewed/forged clock) - they'd otherwise sit
	// permanently pinned below every real message
	if (ev.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECS) return;

	// detect our own message echoing back (before the dedup skip) so we can
	// confirm it propagated and time it
	if (pending.has(ev.id)) confirmSent(ev.id);

	if (seen.has(ev.id)) return;
	seen.add(ev.id);
	if (seen.size > 5000) seen.clear();

	// rate buckets last: everything cheaper (kind, geohash, dedup) already ran,
	// and dedup ensures a relayed copy of an allowed event can't double-spend
	// its sender's tokens.
	if (live && !isOwnEvent(ev) && !chatLimiter.allow("nostr:" + ev.pubkey.toLowerCase(), ev.content)) return;

	renderEvent(ev);

	// ripple the globe wherever a live message just landed, and drift its text into
	// the ambient chat ticker (map open only, live mode only - notes mode swaps
	// the whole live overlay out for pins). backlog replays (live=false) don't -
	// they're history, not a heartbeat. blocked authors and muted channels are kept
	// out of the ticker, matching what you'd see everywhere else.
	if (live && mapInstance && mapActivityTimer && mapConfig.mode === "live") {
		const geo = getGeohash(ev);
		if (geo && /^[0-9a-z]{1,12}$/.test(geo)) {
			mapInstance.ping(geo);
			// only surface a message whose ping is actually on-screen right now - if you
			// can see the dot fire, you see the words; otherwise it's out of view.
			if (mapInstance.isOnScreen(geo) && !isActionMessage(ev.content) && !isBlocked(ev.pubkey) && !mutedChannels.has(geo)) {
				pushMapFeed(ev, geo);
			}
		}
	}
}

const pool = new RelayPool({
	onStatusChange: renderTopbar,
	// (ev, relayUrl, live) - drop the url, keep the live/backlog phase flag
	onEvent: (ev, _url, live) => ingestEvent(ev, live),
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
			// historical: a mirrored buffer is a compressed replay, not live traffic
			if (!seen.has(ev.id) && verifyEvent(ev)) ingestEvent(ev, false);
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
	renderSettingsDesc(); // the settings blurb is set imperatively, not via data-i18n
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
	// one-shot confirmation after a panic wipe (set just before that reload)
	try {
		if (sessionStorage.getItem("glub_panic")) {
			sessionStorage.removeItem("glub_panic");
			appendSystem(t("system.panic"), SYSTEM_TTL_SHORT_MS);
		}
	} catch {}
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
	updateSendLabel();
}

// the global composer only ever joins (it's a channel picker), so the button
// reads "join" the whole time you're in global; focused mode always "send".
function updateSendLabel() {
	sendBtn.textContent = t(focusedGeo ? "composer.send" : "composer.join");
}

function focusChannel(geo) {
	focusedGeo = geo;
	updatePlaceholder();
	updateFocusedUserCount();
	updateNotesButton();
	renderTopbar();
	rerenderTerminal(); // assist mode: focus is just an instant local filter of the buffer

	// assist mode has no client relay sockets, so focus is purely a local filter;
	// pure mode re-subscribes to the channel's nearest relays.
	if (liveSource !== "assist") enterRelayMode();
}

function exitFocus() {
	focusedGeo = null;
	suggest.hide();
	closeNotes(); // notes are channel-scoped; leaving the channel closes them
	updatePlaceholder();
	updateFocusedUserCount();
	updateNotesButton();
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

	// global mode is a channel picker, not a message box: whatever's typed is a
	// channel to JOIN (leading "#" optional). no message is ever sent from global,
	// so a new user can't accidentally fragment a sentence into "#firstword rest".
	const channel = text.replace(/^#/, "").trim();
	if (channel) focusChannel(channel);
	return null;
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

async function transmit(content, geo, displayName = name) {
	if (NSEC_RE.test(content)) {
		appendSystem(t("system.nsec_blocked"));
		return;
	}
	// NIP-13: grind a nonce tag into the unsigned event (~0.1s at difficulty 12,
	// off-thread) before signing. android's default inbound filter drops events
	// without one, so this is as much interop as spam defense. mining failure
	// falls back to an unmined send - spam defense never blocks a message.
	const unsigned = buildChatEvent({ content, geohash: geo, name: displayName, pk: identity.pk, client: outgoingClient(), teleport: outgoingTeleport() });
	const nonceTag = await mineNonceTag(unsigned, POW_DIFFICULTY);
	if (nonceTag) {
		unsigned.tags.push(nonceTag);
		spamStats.mined++;
	}
	const event = signEvent(unsigned, identity.sk);
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

	// a pending reply short-circuits normal parsing: the whole composer is the
	// reply body, the channel is fixed to the quoted message's, and we prepend the
	// "> @user: quote" wire prefix so it renders as a reply everywhere.
	if (pendingReply) {
		const body = chatInput.value.trim();
		if (!body) return; // keep the banner; nothing to send yet
		chatInput.value = "";
		suggest.hide();
		const prefix = `> @${pendingReply.name}: ${pendingReply.quoted}\n\n`;
		const geo = pendingReply.geo;
		cancelReply();
		transmit(prefix + body, geo);
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

// the canonical 20 Magic 8-Ball answers, lowercased with no trailing period to
// match the bot house style (public content everyone sees the same way).
const EIGHTBALL_ANSWERS = [
	"it is certain",
	"it is decidedly so",
	"without a doubt",
	"yes definitely",
	"you may rely on it",
	"as i see it, yes",
	"most likely",
	"outlook good",
	"yes",
	"signs point to yes",
	"reply hazy, try again",
	"ask again later",
	"better not tell you now",
	"cannot predict now",
	"concentrate and ask again",
	"don't count on it",
	"my reply is no",
	"my sources say no",
	"outlook not so good",
	"very doubtful",
];

// resolve a location for /weather + /time: an explicit place/"lat,lon" arg, else
// the current channel's geohash. Returns { lat, lon, label } or null (after
// surfacing the reason locally). Label is lowercased to match the house style.
async function resolveBotLocation(arg) {
	const q = arg.trim();
	if (q) {
		const coords = parseLatLon(q);
		if (coords) return { lat: coords.lat, lon: coords.lon, label: `${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)}` };
		try {
			const place = await geocodePlace(q);
			if (!place) {
				appendSystem(t("system.place_notfound", { q }));
				return null;
			}
			return { lat: place.lat, lon: place.lon, label: place.label.toLowerCase() };
		} catch {
			appendSystem(t("system.place_notfound", { q }));
			return null;
		}
	}
	// no arg: the current channel's coordinates (word channels have none)
	try {
		const { lat, lon } = geohashCell(focusedGeo);
		return { lat, lon, label: `#${focusedGeo}` };
	} catch {
		appendSystem(t("system.not_a_location", { geo: focusedGeo }));
		return null;
	}
}

// --- wordle: a solo word game you play out loud via your ".bot" --------------
// you guess a random 5-letter word over 6 tries; each board posts to the channel
// as your ".bot" (like /echo), so the room can watch you play. only you guess -
// your guesses are typed as /wordle commands. the word list lives in
// /data/wordle-words.json (a plain array of lowercase 5-letter words, or
// { "words": [...] }) so it can be swapped or grown without touching code. state
// is per-session and in-memory: a reload starts fresh.
const WORDLE_LEN = 5;
const WORDLE_TRIES = 6;
let wordleGame = null; // { secret, guesses: [] } while a game is in progress
let wordleWordsPromise = null; // cache the fetched + cleaned word list

function loadWordleWords() {
	if (!wordleWordsPromise) {
		wordleWordsPromise = fetch("/data/wordle-words.json", { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : []))
			.then((data) => (Array.isArray(data) ? data : Array.isArray(data?.words) ? data.words : []))
			.then((arr) => arr.map((w) => String(w).toLowerCase()).filter((w) => new RegExp(`^[a-z]{${WORDLE_LEN}}$`).test(w)))
			.catch(() => []);
	}
	return wordleWordsPromise;
}

// begin a new game from a random word; false (with a notice) if the list is
// missing or empty, so callers can bail cleanly.
async function startWordle() {
	const words = await loadWordleWords();
	if (!words.length) {
		appendSystem(t("system.wordle_nolist"));
		return false;
	}
	wordleGame = { secret: words[Math.floor(Math.random() * words.length)], guesses: [] };
	return true;
}

// per-letter feedback for a guess against the secret, duplicate-safe: greens
// first, then yellows only while an unmatched copy of the letter remains.
function wordleScore(guess, secret) {
	const res = Array(WORDLE_LEN).fill("⬛");
	const counts = {};
	for (const ch of secret) counts[ch] = (counts[ch] || 0) + 1;
	for (let i = 0; i < WORDLE_LEN; i++) {
		if (guess[i] === secret[i]) {
			res[i] = "🟩";
			counts[guess[i]]--;
		}
	}
	for (let i = 0; i < WORDLE_LEN; i++) {
		if (res[i] === "🟩") continue;
		if (counts[guess[i]] > 0) {
			res[i] = "🟨";
			counts[guess[i]]--;
		}
	}
	return res.join("");
}

// the board so far: a header, then one line per guess (emoji row + the word).
function wordleBoard(game, header) {
	const rows = game.guesses.map((g) => `${wordleScore(g, game.secret)}  ${g}`);
	return `${header}\n\n${rows.join("\n")}`;
}

// a wordle board goes out to the channel as your ".bot", the same broadcast path
// /echo uses - so a game is visible to the room. needs a focused channel (the
// command guards for it before calling this).
function wordlePrint(text) {
	transmit(text, focusedGeo, botName());
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
		name: "join",
		run(arg) {
			// join any literal channel string - case and spaces preserved. This
			// reaches names the "#channel" composer syntax can't: ones with spaces,
			// or ones that would otherwise be read as a command. A leading "#" is
			// optional. Non-geocodable channels fall back to the global relay set
			// (see the try/catch in enterRelayMode).
			const channel = arg.replace(/^#/, "").trim().slice(0, MAX_CHANNEL_LEN);
			if (!channel) {
				appendSystem(t("system.join_usage"));
				return;
			}
			focusChannel(channel);
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
		name: "weather",
		// posts weather as your ".bot" for the current channel's geohash, or for a
		// place / "lat,lon" given as an argument (open-meteo, no key). Posting needs
		// a channel to send into; the location can be the arg or this channel.
		async run(arg) {
			if (!focusedGeo) {
				appendSystem(t("system.needs_channel"));
				return;
			}
			const loc = await resolveBotLocation(arg);
			if (!loc) return;
			try {
				const w = await fetchConditions(loc.lat, loc.lon);
				if (typeof w.tempC !== "number") throw new Error("no data");
				const { text, emoji } = wmoDescribe(w.code, w.isDay);
				const tempF = Math.round((w.tempC * 9) / 5 + 32);
				const wind = typeof w.windKmh === "number" ? `\nwind ${Math.round(w.windKmh)}km/h` : "";
				transmit(`${loc.label}:\n\n${emoji} ${text}\n${Math.round(w.tempC)}°c · ${tempF}°f${wind}`, focusedGeo, botName());
			} catch {
				appendSystem(t("system.weather_failed"));
			}
		},
	},
	{
		name: "time",
		// posts local time (12h + 24h + utc offset) as your ".bot" for the current
		// channel, or a place / "lat,lon" argument, resolved from its timezone.
		async run(arg) {
			if (!focusedGeo) {
				appendSystem(t("system.needs_channel"));
				return;
			}
			const loc = await resolveBotLocation(arg);
			if (!loc) return;
			try {
				const { timezone, isDay } = await fetchConditions(loc.lat, loc.lon);
				if (!timezone) throw new Error("no tz");
				const d = new Date();
				const t12 = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true })
					.format(d)
					.toLowerCase();
				const t24 = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
				const offParts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" }).formatToParts(d);
				const off = (offParts.find((p) => p.type === "timeZoneName")?.value || "utc").replace("GMT", "utc");
				// ☀️/🌙 reflects whether it's day or night at the location right now
				const glyph = isDay ? "☀️" : "🌙";
				transmit(`${loc.label}:\n\n${glyph} ${t12} · ${t24}\n${off} · ${timezone.toLowerCase()}`, focusedGeo, botName());
			} catch {
				appendSystem(t("system.time_failed"));
			}
		},
	},
	{
		name: "roll",
		// dice roll posted as your ".bot". forms: /roll, /roll d20, /roll 3d6, /roll 100
		run(arg) {
			if (!focusedGeo) {
				appendSystem(t("system.needs_channel"));
				return;
			}
			const spec = arg.trim().toLowerCase() || "1d6";
			const m = spec.match(/^(?:(\d+)?d)?(\d+)$/); // "3d6" | "d20" | "100"
			let n = m && m[1] ? parseInt(m[1], 10) : 1;
			let sides = m ? parseInt(m[2], 10) : 0;
			if (!m || !(n >= 1) || !(sides >= 2)) {
				appendSystem(t("system.roll_usage"));
				return;
			}
			n = Math.min(n, 20); // caps keep the output (and abuse surface) sane
			sides = Math.min(sides, 1000);
			const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
			const sum = rolls.reduce((a, b) => a + b, 0);
			const detail = n > 1 ? `${rolls.join(", ")} · ${sum}` : `${rolls[0]}`;
			transmit(`🎲 ${n}d${sides}\n${detail}`, focusedGeo, botName());
		},
	},
	{
		name: "8ball",
		// magic 8-ball. unlike the other broadcast commands it posts under your own
		// name (not your ".bot"), so it reads as a natural little dialogue - your
		// question as your message, then the ball answering: "🎱: answer".
		run(arg) {
			if (!focusedGeo) {
				appendSystem(t("system.needs_channel"));
				return;
			}
			const q = arg.replace(/\s+/g, " ").trim();
			if (!q) {
				appendSystem(t("system.eightball_usage"));
				return;
			}
			const question = q.length > 120 ? q.slice(0, 120) + "…" : q;
			const answer = EIGHTBALL_ANSWERS[Math.floor(Math.random() * EIGHTBALL_ANSWERS.length)];
			transmit(`${question}\n\n🎱: ${answer}`, focusedGeo); // no ".bot" - defaults to your own name
		},
	},
	{
		name: "wordle",
		// a solo wordle whose board posts to the channel as your ".bot". no arg
		// starts a game (or reshows the board); an arg is a 5-letter guess. needs a
		// channel to post into, like /echo. see wordleScore/wordleBoard above.
		async run(arg) {
			if (!focusedGeo) {
				appendSystem(t("system.needs_channel")); // no channel = nowhere to post the board
				return;
			}
			const guess = arg.trim().toLowerCase();

			// no arg: show the running board, or start a fresh game.
			if (!guess) {
				if (wordleGame) {
					wordlePrint(`${wordleBoard(wordleGame, `wordle · ${wordleGame.guesses.length}/${WORDLE_TRIES}:`)}\n\n/wordle <word> to guess`);
					return;
				}
				if (!(await startWordle())) return;
				wordlePrint("wordle:\n\nguess a 5 letter word\n/wordle <word>");
				return;
			}

			// a guess with no game running just begins one, so "/wordle crane" works cold.
			if (!wordleGame && !(await startWordle())) return;

			if (!/^[a-z]{5}$/.test(guess)) {
				appendSystem(t("system.wordle_badguess"));
				return;
			}

			wordleGame.guesses.push(guess);
			const solved = guess === wordleGame.secret;
			const over = solved || wordleGame.guesses.length >= WORDLE_TRIES;

			let header, footer;
			if (solved) {
				header = t("system.wordle_solved", { n: wordleGame.guesses.length });
				footer = `\n\n${wordleGame.guesses.length === 1 ? t("system.wordle_first_try") : t("system.wordle_win")}`;
			} else if (over) {
				header = t("system.wordle_over");
				footer = `\n\n${t("system.wordle_reveal", { word: wordleGame.secret })}`;
			} else {
				header = `wordle · ${wordleGame.guesses.length}/${WORDLE_TRIES}:`;
				footer = "";
			}
			const board = wordleBoard(wordleGame, header);
			if (over) wordleGame = null;
			wordlePrint(board + footer);
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
				const header = `${t("system.muted_header")}:`;
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
		name: "unblock",
		run(arg) {
			const raw = arg.trim().toLowerCase();
			if (!blockedPubkeys.size) {
				appendSystem(t("system.block_none"));
				return;
			}
			if (!raw) {
				// no arg -> list who's blocked, by #suffix + last-known name, so you
				// know what to pass back in.
				const header = `${t("system.blocked_header")}:`;
				const lines = [...blockedPubkeys].map((pk) => `#${pk.slice(-4)} @${displayNameForPubkey(pk)}`);
				pushSystem(`<span class="ts">${escapeHtml([header, ...lines].join("\n"))}</span>`, SYSTEM_TTL_LONG_MS);
				return;
			}
			if (raw === "all") {
				blockedPubkeys.clear();
				rerenderTerminal();
				if (usersGate.classList.contains("show")) openUsers();
				appendSystem(t("system.unblocked_all"));
				return;
			}
			// match by the 4-hex #suffix shown in every handle
			const suffix = raw.replace(/^#/, "");
			const pk = [...blockedPubkeys].find((p) => p.endsWith(suffix));
			if (!pk) {
				appendSystem(t("system.unblock_notblocked", { tag: suffix }));
				return;
			}
			blockedPubkeys.delete(pk);
			rerenderTerminal();
			if (usersGate.classList.contains("show")) openUsers();
			appendSystem(t("system.unblocked", { tag: pk.slice(-4) }));
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
		name: "theme",
		run(arg) {
			const query = arg.trim().toLowerCase();
			if (!query) {
				// list every theme, current one marked, in the same aligned style as /help
				const width = Math.max(...themeNames().map((n) => n.length));
				const lines = themeNames().map(
					(n) => `${n.padEnd(width)}${n === activeTheme().name ? ` <- ${t("system.theme_current")}` : ""}`
				);
				const header = `${t("system.themes_header")}:`;
				pushSystem(`<span class="ts">${escapeHtml([header, ...lines].join("\n"))}</span>`, SYSTEM_TTL_LONG_MS);
				return;
			}
			// exact name first, then a unique prefix ("/theme tron" -> tron-legacy)
			const matches = themeNames().filter((n) => n.startsWith(query));
			const name = themeNames().includes(query) ? query : matches.length === 1 ? matches[0] : null;
			if (!name || !applyTheme(name)) {
				appendSystem(t("system.theme_unknown", { name: query }));
				return;
			}
			persistTheme(name);
			refreshThemedColors();
			appendSystem(t("system.theme_set", { name }));
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
			const header = `${t("system.commands_header")}:`;
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

// theme-name completion for "/theme <partial>" - the one command whose argument
// space is small and fixed enough that completing it is pure win.
function themeArgProvider(value, caret) {
	const before = value.slice(0, caret);
	const m = before.match(/^\/theme\s+(\S*)$/i);
	if (!m) return null;
	const query = m[1].toLowerCase();
	const start = caret - m[1].length;
	const items = themeNames()
		.filter((n) => n.startsWith(query))
		.map((n) => ({
			insert: n,
			html: `<strong>${escapeHtml(n)}</strong>${n === activeTheme().name ? ` <span class="sfx">- ${escapeHtml(t("system.theme_current"))}</span>` : ""}`,
		}));
	return { start, end: caret, items };
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

// the global composer is a channel picker, not a message box: in global mode any
// non-command input is a channel to JOIN, and this offers the active channels as
// live suggestions (filtered by what's typed). purely a helper - you can still
// type any channel, active or not, and join it. picking a row joins immediately,
// so this provider carries its own onPick instead of the default text-insert.
function channelProvider(value, caret) {
	if (focusedGeo) return null; // only in global mode
	const text = value.trimStart();
	if (text.startsWith("/")) return null; // commands win
	const query = text.trim().replace(/^#/, "").toLowerCase();
	const items = activeChannels(8)
		.filter((c) => !query || c.geo.toLowerCase().startsWith(query))
		.map((c) => ({
			insert: c.geo, // unused (onPick joins), but kept for shape consistency
			geo: c.geo,
			html: `#${escapeHtml(c.geo)}`,
			meta: t("suggest.here", { count: c.count }),
		}));
	// no auto-highlight: Enter joins exactly what you typed (so "#s" joins "#s", not
	// the popular "#st" it suggests); tap a row or arrow onto it to pick one instead.
	return { items, onPick: (item) => joinFromSuggest(item.geo), autoHighlight: false };
}

// join a channel chosen from the picker, clearing the composer + popup.
function joinFromSuggest(geo) {
	chatInput.value = "";
	suggest.hide();
	focusChannel(geo);
	updateSendLabel();
	setTimeout(() => chatInput.focus(), 0);
}

const SUGGEST_PROVIDERS = [commandProvider, themeArgProvider, mentionProvider, channelProvider];

function refreshSuggest() {
	const value = chatInput.value;
	const caret = chatInput.selectionStart ?? value.length;
	for (const provider of SUGGEST_PROVIDERS) {
		const ctx = provider(value, caret);
		if (ctx && ctx.items.length) {
			const pick = ctx.onPick || ((item) => applySuggest(ctx.start, ctx.end, item.insert));
			suggest.show(ctx.items, pick, { autoHighlight: ctx.autoHighlight !== false });
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
chatInput.addEventListener("input", updateSendLabel);
// focusing the empty global composer surfaces the active-channels picker straight
// away (discovery before you even type); in a channel there's no channel picker.
chatInput.addEventListener("focus", () => {
	if (!focusedGeo) refreshSuggest();
});
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

// resolves env(safe-area-inset-*) to real pixels (getComputedStyle resolves env
// in computed padding) - the viewport probes below use it to catch ios lying
// about the bottom inset.
const insetProbe = document.createElement("div");
insetProbe.style.cssText =
	"position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
	"padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);";
document.body.appendChild(insetProbe);

function measuredInsets() {
	const ps = getComputedStyle(insetProbe);
	return { top: parseFloat(ps.paddingTop) || 0, bottom: parseFloat(ps.paddingBottom) || 0 };
}

function fitViewport() {
	const vv = window.visualViewport;
	if (!vv) return;
	let h = Math.round(vv.height);
	// with no input focused there is no on-screen keyboard, so the app must fill
	// the whole layout viewport. standalone (home-screen) iOS can report a stale,
	// browser-chrome-sized vv.height at cold launch and never fire the corrective
	// resize, stranding the composer above a dead band where the url bar used to
	// be; the layout viewport is authoritative in that idle state. while typing,
	// vv.height is the one that knows about the keyboard, so it stays in charge.
	const ae = document.activeElement;
	const typing = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
	if (!typing) {
		// the layout viewport is the truth when idle: ios keyboards never shrink it
		// (the reason vv.height governs while typing), and - measured on a real
		// device - it reports the standalone window honestly even when
		// vv.height goes stale. do NOT floor to screen.height here: in portrait
		// standalone ios gives the webview a window of screen minus the status bar,
		// so a screen-sized floor overflows the window and buries the composer.
		h = Math.max(h, Math.round(document.documentElement.clientHeight || 0), Math.round(window.innerHeight || 0));
	}
	// ios can also report a ZERO bottom safe-area in that same lying state - the
	// top inset stays honest - so with the app floored to the full screen the
	// composer sank into the home indicator. a notched phone (top inset > 0)
	// reporting no bottom inset in a home-screen app is that lie: supply the
	// indicator inset ourselves (34pt portrait / 21pt landscape). css takes it
	// via max(env(), var(--standalone-inset-b)), so an honest env() always wins
	// and browser/android layouts never see it.
	let standaloneInsetB = 0;
	if (navigator.standalone === true && Math.min(screen.width, screen.height) <= 500) {
		const ins = measuredInsets();
		if (ins.top > 20 && ins.bottom < 10) {
			standaloneInsetB = matchMedia("(orientation: portrait)").matches ? 34 : 21;
		}
	}
	document.documentElement.style.setProperty("--standalone-inset-b", `${standaloneInsetB}px`);
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
	// standalone iOS corrects its viewport without always telling visualViewport,
	// so listen wider: window resize, returning from background, bfcache restores.
	window.addEventListener("resize", fitViewport);
	window.addEventListener("pageshow", fitViewport);
	document.addEventListener("visibilitychange", fitViewport);
	// orientation changes settle a beat after the event on iOS
	window.addEventListener("orientationchange", () => setTimeout(fitViewport, 250));
	// ...and a cold standalone launch can settle a beat after first paint with no
	// event at all - re-measure a few times so boot can't bake in a stale height.
	for (const ms of [150, 500, 1200]) setTimeout(fitViewport, ms);
	fitViewport();
}

updatePlaceholder();
