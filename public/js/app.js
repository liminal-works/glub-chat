import { loadOrCreateIdentity, getStoredName, setStoredName } from "./nostr/identity.js";
import { fetchRelayList } from "./nostr/relayList.js";
import { RelayPool } from "./nostr/relayPool.js";
import { makeChatMessage, getGeohash, getName, CHAT_KIND, sortRelaysByGeohash } from "./nostr/protocol.js";

const BOOT_RELAY_COUNT = 12;
const BOOTED_AT = Math.floor(Date.now() / 1000);
const seen = new Set();

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

function appendLine(html) {
	const div = document.createElement("div");
	div.className = "line";
	div.innerHTML = html;
	terminal.appendChild(div);
	terminal.scrollTop = terminal.scrollHeight;
}

function appendSystem(text) {
	appendLine(`<span class="system">${escapeHtml(text)}</span>`);
}

function renderEvent(ev) {
	const geo = getGeohash(ev) || "?";
	const who = getName(ev) || ev.pubkey.slice(0, 8);
	const text = String(ev.content || "");

	appendLine(
		`<span class="geo">#${escapeHtml(geo)}</span> ` +
			`<span class="user">${escapeHtml(who)}</span> ` +
			`<span class="msg">${escapeHtml(text)}</span>`
	);
}

function updateStatus() {
	const connected = pool.connectedCount;
	const total = pool.total;
	const left = connected === 0 ? "--" : connected;
	const right = total === 0 ? "--" : total;
	statusEl.textContent = `RELAYS: ${left}/${right}`;
}

function renderBrand() {
	brandEl.innerHTML = `GLUB.CHAT/@${escapeHtml(clipText(name || "anon", 12))}`;
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
		if (typeof ev.created_at === "number" && ev.created_at < BOOTED_AT) return;

		if (seen.has(ev.id)) return;
		seen.add(ev.id);
		if (seen.size > 5000) seen.clear();

		if (ev.pubkey === identity.pk) return;

		renderEvent(ev);
	},
});

(async function init() {
	appendSystem("loading relay list...");

	try {
		allRelays = await fetchRelayList();
		appendSystem(`found ${allRelays.length} relays, connecting...`);
		// no channel focused yet - bootstrap with an arbitrary slice, then
		// re-sort by distance once the user focuses a real geohash.
		pool.connectNearest(allRelays.slice(0, BOOT_RELAY_COUNT).map((r) => r.url));
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

updatePlaceholder();
