import { loadOrCreateIdentity, getStoredName, setStoredName } from "./nostr/identity.js";
import { fetchRelayList } from "./nostr/relayList.js";
import { RelayPool } from "./nostr/relayPool.js";
import { makeChatMessage, getGeohash, getName, CHAT_KIND, sortRelaysByGeohash } from "./nostr/protocol.js";

const MAX_LINES = 600;
const NEAR_BOTTOM_PX = 60;
const MAX_GEO_LEN = 12; // geohash precision tops out here; clip the prefix so a huge "g" tag can't flood a line
const MAX_NAME_LEN = 22; // collapse longer names behind a "more" toggle
const MAX_MSG_LEN = 450; // collapse longer messages behind a "more" toggle
const HARD_MAX_MSG_LEN = 8000; // absolute ceiling, even when expanded, to bound DOM/memory
const seen = new Set();
const entries = []; // [{ ts, geo, system, pubkey, html, el }], ascending by ts - all received messages

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
const terminal = document.getElementById("terminal");
const brandEl = document.getElementById("brand");
const statusEl = document.getElementById("status");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const newMessagesBar = document.getElementById("newMessagesBar");

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
	const who = expanded ? entry.who : clipWithEllipsis(entry.who, MAX_NAME_LEN);
	const text = expanded ? entry.text : clipWithEllipsis(entry.text, MAX_MSG_LEN);
	const needsToggle = entry.who.length > MAX_NAME_LEN || entry.text.length > MAX_MSG_LEN;
	const color = entry.color;

	let html =
		`<span class="bracket" style="color:${color}">&lt;</span>` +
		`<span class="user" style="color:${color}">@${escapeHtml(who)}</span>` +
		`<span class="tag" style="color:${color}">#${escapeHtml(entry.tag)}</span>` +
		`<span class="bracket" style="color:${color}">&gt;</span> ` +
		`<span class="msg" style="color:${color}">${linkify(escapeHtml(text))}</span>`;

	if (needsToggle) {
		html += `<span class="toggleMore" data-toggle="${escapeHtml(entry.id)}">${expanded ? "less" : "more"}</span>`;
	}

	return html + timeTag(entry.ts);
}

// renders one entry's DOM node into the terminal at the correct chronological
// position among the other currently-visible (filter-matching) entries.
function renderEntryDom(entry) {
	const div = document.createElement("div");
	div.className = entry.mention ? "line mention" : "line";
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

// derives a stable per-user hue from their pubkey (like native bitchat),
// so distinct users are visually distinguishable at a glance.
function pubkeyHue(pubkey) {
	let hash = 0;
	for (let i = 0; i < pubkey.length; i++) {
		hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 360;
}

function pubkeyColor(pubkey) {
	return `hsl(${pubkeyHue(pubkey)}, 65%, 60%)`;
}

// translucent version of the sender's color, for tinting their mention highlight
function pubkeyTint(pubkey) {
	return `hsla(${pubkeyHue(pubkey)}, 65%, 60%, 0.16)`;
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

		const connected = pool.connectedCount;
		const total = pool.total;
		const left = connected === 0 ? "--" : connected;
		const right = total === 0 ? "--" : total;
		statusEl.innerHTML = `<strong>RELAYS</strong>: ${left}/${right}`;
		statusEl.classList.remove("tapExit");
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

if (name) {
	closeNameGate();
} else {
	openNameGate();
}

brandEl.addEventListener("click", openNameGate);

statusEl.addEventListener("click", () => {
	if (!focusedGeo) return;
	exitFocus();
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

nameForm.addEventListener("submit", (e) => {
	e.preventDefault();

	const value = nameInput.value.trim().slice(0, 24);
	name = value || `anon${Math.floor(1000 + Math.random() * 9000)}`;

	setStoredName(name);
	renderTopbar();
	closeNameGate();
});

const pool = new RelayPool({
	onStatusChange: renderTopbar,
	onEvent: (ev) => {
		if (ev.kind !== CHAT_KIND) return;
		if (!getGeohash(ev)) return;

		if (seen.has(ev.id)) return;
		seen.add(ev.id);
		if (seen.size > 5000) seen.clear();

		renderEvent(ev);
	},
});

// initial paint - done after `pool` exists since renderTopbar reads its counts
renderTopbar();

(async function init() {
	try {
		allRelays = await fetchRelayList();
		// no channel focused yet - cast as wide a net as possible to absorb
		// whatever backlog/history relays are still rebroadcasting.
		pool.connectAll(allRelays.map((r) => r.url));
	} catch (err) {
		appendSystem(`failed to load relays: ${err.message}`);
	}
})();

function updatePlaceholder() {
	chatInput.placeholder = focusedGeo ? `message -> #${focusedGeo}` : "#channel message";
}

function focusChannel(geo) {
	focusedGeo = geo;
	updatePlaceholder();
	updateFocusedUserCount();
	renderTopbar();
	rerenderTerminal();

	if (!allRelays.length) return;

	try {
		const sorted = sortRelaysByGeohash(allRelays, geo);
		pool.connectNearest(sorted.map((r) => r.url));
	} catch (err) {
		appendSystem(`#${geo}: invalid geohash, keeping current relays`);
	}
}

function exitFocus() {
	focusedGeo = null;
	updatePlaceholder();
	updateFocusedUserCount();
	renderTopbar();
	rerenderTerminal();

	if (allRelays.length) pool.connectAll(allRelays.map((r) => r.url));
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
	pool.broadcast(event);
	renderEvent(event);
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
