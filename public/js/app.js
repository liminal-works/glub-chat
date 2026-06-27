import { loadOrCreateIdentity, getStoredName, setStoredName } from "./nostr/identity.js";
import { fetchRelayList } from "./nostr/relayList.js";
import { RelayPool } from "./nostr/relayPool.js";
import { makeChatMessage, getGeohash, getName, CHAT_KIND, sortRelaysByGeohash } from "./nostr/protocol.js";

const MAX_LINES = 600;
const seen = new Set();
const entries = []; // [{ ts, geo, system, pubkey, html, el }], ascending by ts - all received messages

const identity = loadOrCreateIdentity();
let name = getStoredName();
let focusedGeo = null;
let focusedUserCount = 0;
let allRelays = []; // [{ url, lat, lon }], populated after the CSV fetch resolves

const nameGate = document.getElementById("nameGate");
const nameForm = document.getElementById("nameForm");
const nameInput = document.getElementById("nameInput");
const terminal = document.getElementById("terminal");
const brandEl = document.getElementById("brand");
const statusEl = document.getElementById("status");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

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

function entryVisible(entry) {
	return entry.system || !focusedGeo || entry.geo === focusedGeo;
}

// renders one entry's DOM node into the terminal at the correct chronological
// position among the other currently-visible (filter-matching) entries.
function renderEntryDom(entry) {
	const div = document.createElement("div");
	div.className = "line";
	div.innerHTML = entry.html;
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

	terminal.scrollTop = terminal.scrollHeight;
}

// rebuilds the visible terminal from `entries` under the current filter -
// used when entering/exiting a focused channel.
function rerenderTerminal() {
	terminal.innerHTML = "";
	for (const entry of entries) entry.el = null;
	for (const entry of entries) {
		if (entryVisible(entry)) renderEntryDom(entry);
	}
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

	if (entryVisible(entry)) renderEntryDom(entry);

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

// derives a stable per-user color from their pubkey (like native bitchat),
// so distinct users are visually distinguishable at a glance.
function pubkeyColor(pubkey) {
	let hash = 0;
	for (let i = 0; i < pubkey.length; i++) {
		hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 65%, 60%)`;
}

function renderEvent(ev) {
	const geo = getGeohash(ev) || "?";
	const who = getName(ev) || "anon";
	const tag = ev.pubkey.slice(-4);
	const text = String(ev.content || "");
	const color = pubkeyColor(ev.pubkey);

	const html =
		`<span class="geo">#${escapeHtml(geo)}</span> ` +
		`<span class="bracket" style="color:${color}">&lt;</span>` +
		`<span class="user" style="color:${color}">@${escapeHtml(who)}</span>` +
		`<span class="tag" style="color:${color}">#${escapeHtml(tag)}</span>` +
		`<span class="bracket" style="color:${color}">&gt;</span> ` +
		`<span class="msg" style="color:${color}">${escapeHtml(text)}</span>` +
		timeTag(ev.created_at);

	insertEntry({ ts: ev.created_at, geo, system: false, pubkey: ev.pubkey, html, el: null });
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
		brandEl.innerHTML = `#${escapeHtml(clippedGeo)}/@${escapeHtml(clipText(name || "anon", 12))}`;

		const userWord = focusedUserCount === 1 ? "USER" : "USERS";
		statusEl.innerHTML = `${focusedUserCount} ${userWord} [EXIT]`;
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
		terminal.scrollTop = terminal.scrollHeight;
	});
}

updatePlaceholder();
