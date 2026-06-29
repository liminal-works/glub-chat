import { loadOrCreateIdentity, getStoredName, setStoredName } from "./nostr/identity.js";
import { fetchRelayList } from "./nostr/relayList.js";
import { RelayPool } from "./nostr/relayPool.js";
import { makeChatMessage, getGeohash, getName, CHAT_KIND, sortRelaysByGeohash, verifyEvent } from "./nostr/protocol.js";

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

const identity = loadOrCreateIdentity();
let name = getStoredName();
let focusedGeo = null;
let focusedUserCount = 0;
let allRelays = []; // [{ url, lat, lon }], populated after the CSV fetch resolves

let autoScroll = true; // stick to the bottom; false once the user scrolls up to read history
let unreadCount = 0; // messages arrived while scrolled up, shown in the banner

const nameGate = document.getElementById("nameGate");
const nameForm = document.getElementById("nameForm");
const nameInput = document.getElementById("nameInput");
const settingsGate = document.getElementById("settingsGate");
const assistToggle = document.getElementById("assistToggle");
const settingsClose = document.getElementById("settingsClose");
const terminal = document.getElementById("terminal");
const brandEl = document.getElementById("brand");
const statusEl = document.getElementById("status");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const newMessagesBar = document.getElementById("newMessagesBar");

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
	return entry.system || !focusedGeo || entry.geo === focusedGeo;
}

// builds a message line's inner html (everything after the optional #geo prefix)
// from its stored fields, collapsing an over-long name or message behind a
// "more"/"less" toggle so a single huge message can't blow out the view.
function messageInnerHtml(entry) {
	const expanded = entry.expanded;
	const text = expanded ? entry.text : clipWithEllipsis(entry.text, MAX_MSG_LEN);
	const color = entry.color;

	let body;
	let needsToggle = entry.text.length > MAX_MSG_LEN;

	if (entry.action) {
		// emote: the whole "* ... *" rendered muted like a timestamp, no username
		body = `<span class="ts">${linkify(escapeHtml(text))}</span>`;
	} else {
		const who = expanded ? entry.who : clipWithEllipsis(entry.who, MAX_NAME_LEN);
		needsToggle = needsToggle || entry.who.length > MAX_NAME_LEN;
		body =
			`<span class="bracket" style="color:${color}">&lt;</span>` +
			`<span class="user" style="color:${color}">@${escapeHtml(who)}</span>` +
			`<span class="tag" style="color:${color}">#${escapeHtml(entry.tag)}</span>` +
			`<span class="bracket" style="color:${color}">&gt;</span> ` +
			`<span class="msg" style="color:${color}">${linkify(escapeHtml(text))}</span>`;
	}

	if (needsToggle) {
		body += `<span class="toggleMore" data-toggle="${escapeHtml(entry.id)}">${expanded ? "less" : "more"}</span>`;
	}

	body += renderImagePreviews(entry);

	return body + timeTag(entry.ts) + ackTag(entry);
}

// send-confirmation badge for our own messages, styled like the timestamp:
// "…" while awaiting echo-back, the round-trip latency once a source replays it
// ("<1s" / "4s"), or "?" if it never came back (possible delivery problem).
function ackTag(entry) {
	if (!entry.mine) return "";
	if (entry.ackSecs != null) {
		return ` <span class="ts ack">${entry.ackSecs === 0 ? "&lt;1s" : `${entry.ackSecs}s`}</span>`;
	}
	if (entry.ackFailed) return ` <span class="ts ack">?</span>`;
	return ""; // pending: show nothing until it confirms (latency) or fails (?)
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
				`<div class="mediaCensorOverlay">[reveal]</div></div>`
			);
		})
		.join("");
}

// renders one entry's DOM node into the terminal at the correct chronological
// position among the other currently-visible (filter-matching) entries.
function renderEntryDom(entry) {
	const div = document.createElement("div");
	div.className = entry.mention ? "line mention" : "line";
	if (entry.mine) div.className += " mine"; // your own messages render bold (like bitchat)
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
	newMessagesBar.textContent = `[ ${unreadCount} new message${unreadCount === 1 ? "" : "s"} ]`;
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
		renderEntryDom(entry);
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

function appendSystem(text) {
	const ts = Date.now() / 1000;
	insertEntry({
		ts,
		geo: null,
		system: true,
		pubkey: null,
		html: `<span class="system">${escapeHtml(text)}</span>${timeTag(ts)}`,
		el: null,
	});
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
function pubkeyRgb(pubkey) {
	if (pubkey.toLowerCase() === identity.pk.toLowerCase()) return SELF_RGB; // "you" is always orange

	const h = djb2("nostr:" + pubkey.toLowerCase());

	let hue = Number(h % 1000n) / 1000;
	const orange = 30 / 360;
	if (Math.abs(hue - orange) < 0.05) hue = (hue + 0.12) % 1.0; // avoid orange (reserved for you)

	const sRand = Number((h >> 17n) & 0x3ffn) / 1023;
	const bRand = Number((h >> 27n) & 0x3ffn) / 1023;
	const saturation = Math.min(1, Math.max(0.5, 0.8 + (sRand - 0.5) * 0.2));
	const brightness = Math.min(1, Math.max(0.35, 0.75 + (bRand - 0.5) * 0.16));

	return hsbToRgb(hue, saturation, brightness);
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

	insertEntry({
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
		mine: ev.pubkey.toLowerCase() === identity.pk.toLowerCase(), // bitchat bolds your own messages
		pendingAck: pending.has(ev.id), // a message we just sent, awaiting echo-back confirmation
		action: isActionMessage(text),
		images: extractImageUrls(text),
		expanded: false,
		el: null,
	});
}

function updateFocusedUserCount() {
	if (!focusedGeo) {
		focusedUserCount = 0;
		return;
	}
	const users = new Set();
	for (const entry of entries) {
		if (!entry.system && entry.geo === focusedGeo) users.add(entry.pubkey);
	}
	focusedUserCount = users.size;
}

function renderTopbar() {
	if (focusedGeo) {
		const clippedGeo = clipText(focusedGeo, 12);
		brandEl.innerHTML = `<strong>#${escapeHtml(clippedGeo)}</strong>/@${escapeHtml(clipText(name || "anon", 12))}`;

		const userWord = focusedUserCount === 1 ? "USER" : "USERS";
		statusEl.innerHTML = `${focusedUserCount} ${userWord} - <strong>[EXIT]</strong>`;
		statusEl.classList.add("tapExit");
	} else {
		brandEl.innerHTML = `<strong>GLUB.CHAT</strong>/@${escapeHtml(clipText(name || "anon", 12))}`;
		statusEl.classList.remove("tapExit");

		if (liveSource === "assist") {
			// assist active: show the api's relay coverage (connected / list size)
			const r = apiHealth?.relays;
			const left = r?.connected == null ? "--" : r.connected;
			const right = r?.monitored == null ? "--" : r.monitored;
			statusEl.innerHTML = `<strong>RELAYS</strong>: ${left}/${right}`;
		} else {
			const connected = pool.connectedCount;
			const total = pool.total;
			const left = connected === 0 ? "--" : connected;
			const right = total === 0 ? "--" : total;
			statusEl.innerHTML = `<strong>RELAYS</strong>: ${left}/${right}`;
		}
	}
}

function openNameGate() {
	nameInput.value = name || "";
	nameGate.classList.add("show");
	setTimeout(() => nameInput.focus(), 0);
}

function closeNameGate() {
	nameGate.classList.remove("show");
}

function openSettings() {
	assistToggle.checked = getAssistEnabled();
	settingsGate.classList.add("show");
}

function closeSettings() {
	settingsGate.classList.remove("show");
}

if (name) {
	closeNameGate();
} else {
	openNameGate();
}

brandEl.addEventListener("click", openNameGate);

// the status doubles as [EXIT] when focused on a channel, and the settings
// entry point otherwise.
statusEl.addEventListener("click", () => {
	if (focusedGeo) exitFocus();
	else openSettings();
});

assistToggle.addEventListener("change", async () => {
	setAssistEnabled(assistToggle.checked);
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
});
settingsClose.addEventListener("click", closeSettings);
// tapping the dimmed backdrop (outside the card) dismisses settings
settingsGate.addEventListener("click", (e) => {
	if (e.target === settingsGate) closeSettings();
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

nameForm.addEventListener("submit", (e) => {
	e.preventDefault();

	const value = nameInput.value.trim().slice(0, 24);
	name = value || `anon${Math.floor(1000 + Math.random() * 9000)}`;

	setStoredName(name);
	renderTopbar();
	closeNameGate();
});

// single entry point for every event source (relays + history api): filter to
// geohash chat, dedup by id, then render. Both paths share one dedup set.
function rerenderEntryEl(entry) {
	if (entry.el) entry.el.innerHTML = (focusedGeo ? "" : entry.geoPrefix || "") + messageInnerHtml(entry);
}

// (re)broadcast a tracked message and arm its confirmation timeout
function attemptBroadcast(id) {
	const rec = pending.get(id);
	if (!rec) return;
	rec.attempts += 1;
	pool.broadcast(rec.event);
	clearTimeout(rec.timer);
	rec.timer = setTimeout(() => onSendTimeout(id), ACK_TIMEOUT_MS);
}

// no echo in time: rebroadcast the identical signed event (relays have warmed /
// the broadcast set has healed since) until attempts run out, then flag it.
function onSendTimeout(id) {
	const rec = pending.get(id);
	if (!rec) return;
	if (rec.attempts < MAX_SEND_ATTEMPTS) {
		attemptBroadcast(id);
		return;
	}
	pending.delete(id);
	const entry = entries.find((e) => e.id === id);
	if (entry) {
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
	entry.ackSecs = Math.max(0, Math.floor((Date.now() - rec.firstSentAt) / 1000));
	rerenderEntryEl(entry);
}

function ingestEvent(ev) {
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
		html: `<span class="barrier">——— ** beginning of chat ** ———</span>`,
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

// nearest-first relay urls for the current channel (first-available for global
// or a non-geocodable channel).
function broadcastUrls() {
	if (!allRelays.length) return [];
	const reliable = allRelays.map((r) => r.url); // list order: well-connected, api-watched
	if (!focusedGeo) return reliable;

	let nearest;
	try {
		nearest = sortRelaysByGeohash(allRelays, focusedGeo).map((r) => r.url);
	} catch {
		return reliable; // non-geocodable channel
	}
	// lead with a few nearest relays (to reach native bitchat clients subscribed
	// near that geohash), but always fold in the reliable list-order relays so a
	// send still lands on relays the api and wider network see well - the nearest
	// set alone can be sparse/flaky.
	return [...new Set([...nearest.slice(0, 8), ...reliable])];
}

function connectBroadcastRelays() {
	const urls = broadcastUrls();
	if (urls.length) pool.connectBroadcast(urls);
}

// assist mode: live reads from the api stream, relays kept only for sending.
function enterAssistMode() {
	if (liveSource === "assist" && eventSource) return; // already assisting
	liveSource = "assist";
	connectBroadcastRelays(); // relays become send-only (drops the ~200 read subs)
	openAssistStream(); // open the stream first so nothing arriving during the
	mirrorBuffer(); // buffer fetch is missed (dedup handles the overlap)
	renderTopbar();
}

// pure-client mode: live reads from direct relay subscriptions (today's behavior).
function enterRelayMode() {
	liveSource = "relays";
	closeAssistStream();
	if (!allRelays.length) {
		renderTopbar();
		return;
	}
	const announce = !getAssistEnabled(); // relay chatter is for the pure-client experience
	if (focusedGeo) {
		let sorted;
		try {
			sorted = sortRelaysByGeohash(allRelays, focusedGeo).map((r) => r.url);
		} catch {
			// non-geocodable channel: it isn't a decodable location, so there's no
			// local set to compute - use the global set instead.
			pool.connectAll(allRelays.map((r) => r.url));
			if (announce) appendSystem(`#${focusedGeo}: not a location, connecting to global relay set...`);
			renderTopbar();
			return;
		}
		pool.connectNearest(sorted);
		if (announce) appendSystem(`#${focusedGeo}: connecting to local relay set...`);
	} else {
		pool.connectAll(allRelays.map((r) => r.url));
		if (announce) appendSystem(`connecting to global relay set...`);
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

// initial paint - done after `pool` exists since renderTopbar reads its counts
renderTopbar();

(async function init() {
	try {
		allRelays = await fetchRelayList();
	} catch (err) {
		appendSystem(`failed to load relays: ${err.message}`);
	}

	if (getAssistEnabled() && (await checkApiHealth())) enterAssistMode();
	else enterRelayMode();

	startAssistMaintain();
})();

function updatePlaceholder() {
	chatInput.placeholder = focusedGeo ? `message -> #${focusedGeo}` : "#channel message...";
}

function focusChannel(geo) {
	focusedGeo = geo;
	updatePlaceholder();
	updateFocusedUserCount();
	renderTopbar();
	rerenderTerminal(); // assist mode: focus is just an instant local filter of the buffer

	// in assist mode reads come from the stream, so only repoint the send relays;
	// in pure mode, re-subscribe to the channel's nearest relays.
	if (liveSource === "assist") connectBroadcastRelays();
	else enterRelayMode();
}

function exitFocus() {
	focusedGeo = null;
	updatePlaceholder();
	updateFocusedUserCount();
	renderTopbar();
	rerenderTerminal();

	if (liveSource === "assist") connectBroadcastRelays();
	else enterRelayMode();
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

function send() {
	const draft = parseDraft(chatInput.value);
	chatInput.value = "";
	if (!draft) return;

	const event = makeChatMessage({
		content: draft.content,
		geohash: draft.geo,
		name,
		sk: identity.sk,
		pk: identity.pk,
	});

	seen.add(event.id);
	// track before rendering so renderEvent's pendingAck picks it up ("…"), then
	// broadcast + arm the confirm/rebroadcast timer.
	pending.set(event.id, { event, firstSentAt: Date.now(), attempts: 0, timer: null });
	renderEvent(event);
	attemptBroadcast(event.id);
	jumpToBottom(); // sending always returns you to the live bottom
}

sendBtn.addEventListener("click", send);
chatInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		send();
	}
});

// iOS Safari doesn't honor interactive-widget=resizes-content yet, so when the
// keyboard opens/closes it just scrolls the page instead of resizing it - pull
// the latest messages back into view whenever the visual viewport changes.
if (window.visualViewport) {
	window.visualViewport.addEventListener("resize", () => {
		if (autoScroll) scrollToBottom();
	});
}

updatePlaceholder();
