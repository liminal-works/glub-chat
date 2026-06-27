import { loadOrCreateIdentity, getStoredName, setStoredName } from "./nostr/identity.js";
import { fetchRelayList } from "./nostr/relayList.js";
import { RelayPool } from "./nostr/relayPool.js";
import { makeChatMessage, getGeohash, getName, CHAT_KIND, sortRelaysByGeohash } from "./nostr/protocol.js";

const seen = new Set();
const lines = []; // [{ ts, el }], kept ascending by ts so history renders in order

const identity = loadOrCreateIdentity();
let name = getStoredName();
let focusedGeo = null;
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

// inserts a line in chronological order by ts (relay backlog can arrive
// out of order), so history replays in the order it actually happened.
function insertLine(ts, html) {
	const div = document.createElement("div");
	div.className = "line";
	div.innerHTML = html;

	let lo = 0, hi = lines.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (lines[mid].ts <= ts) lo = mid + 1;
		else hi = mid;
	}

	if (lo === lines.length) terminal.appendChild(div);
	else terminal.insertBefore(div, lines[lo].el);

	lines.splice(lo, 0, { ts, el: div });
	terminal.scrollTop = terminal.scrollHeight;
}

function appendSystem(text) {
	insertLine(Date.now() / 1000, `<span class="system">${escapeHtml(text)}</span>`);
}

function renderEvent(ev) {
	const geo = getGeohash(ev) || "?";
	const who = getName(ev) || "anon";
	const tag = ev.pubkey.slice(-4);
	const text = String(ev.content || "");

	insertLine(
		ev.created_at,
		`<span class="geo">#${escapeHtml(geo)}</span> ` +
			`<span class="user">${escapeHtml(who)}#${escapeHtml(tag)}</span> ` +
			`<span class="msg">${escapeHtml(text)}</span>`
	);
}

function updateStatus() {
	const connected = pool.connectedCount;
	const total = pool.total;
	const left = connected === 0 ? "--" : connected;
	const right = total === 0 ? "--" : total;
	statusEl.innerHTML = `<strong>RELAYS</strong>: ${left}/${right}`;
}

function renderBrand() {
	brandEl.innerHTML = `<strong>GLUB.CHAT</strong>/@${escapeHtml(clipText(name || "anon", 12))}`;
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

renderBrand();
brandEl.addEventListener("click", openNameGate);

nameForm.addEventListener("submit", (e) => {
	e.preventDefault();

	const value = nameInput.value.trim().slice(0, 24);
	name = value || `anon${Math.floor(1000 + Math.random() * 9000)}`;

	setStoredName(name);
	renderBrand();
	closeNameGate();
});

const pool = new RelayPool({
	onStatusChange: updateStatus,
	onEvent: (ev) => {
		if (ev.kind !== CHAT_KIND) return;

		if (seen.has(ev.id)) return;
		seen.add(ev.id);
		if (seen.size > 5000) seen.clear();

		renderEvent(ev);
	},
});

(async function init() {
	try {
		allRelays = await fetchRelayList();
		appendSystem(`connecting to ${allRelays.length} relays...`);
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

	if (!allRelays.length) return;

	try {
		const sorted = sortRelaysByGeohash(allRelays, geo);
		appendSystem(`#${geo}: connecting to nearest relays...`);
		pool.connectNearest(sorted.map((r) => r.url));
	} catch (err) {
		appendSystem(`#${geo}: invalid geohash, keeping current relays`);
	}
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
