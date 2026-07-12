// Publishing side of nostr profiles: reads and writes your own kind-0 metadata.
// The rest of the app only *reads* other people's profiles (via the server-assist
// API, which keeps its own profile relay pool); this module is what lets you edit
// your own. kind-0 is a replaceable event that lives on general/profile relays -
// not the geohash chat relays - so this owns short-lived sockets to a dedicated
// profile relay set, opened per operation and closed as soon as it resolves,
// exactly like a one-shot version of the DM/notes clients. Independent of assist
// mode: publishing works straight to relays whether or not the api is up.
//
// The profile relays mirror what the api aggregator reads (api/profiles.mjs), so
// what you publish here is what it re-fetches to show your avatar/name in-app,
// plus a couple of high-reach general relays for propagation to other clients.

import { verifyEvent, METADATA_KIND } from "./protocol.js";

export const PROFILE_RELAYS = [
	"wss://purplepag.es", // the api reads these three (api/profiles.mjs) - keep them first
	"wss://relay.damus.io",
	"wss://relay.nostr.band",
	"wss://nos.lol", // extra reach so other clients pick the edit up quickly
	"wss://relay.primal.net",
];

// resolved at call time so a page can point profile reads/writes at a local
// relay for testing (window.GLUB_PROFILE_RELAYS); production uses the set above.
function defaultRelays() {
	if (typeof window !== "undefined" && Array.isArray(window.GLUB_PROFILE_RELAYS) && window.GLUB_PROFILE_RELAYS.length) {
		return window.GLUB_PROFILE_RELAYS;
	}
	return PROFILE_RELAYS;
}

const FETCH_TIMEOUT_MS = 6000; // give up reading the current profile after this
const FETCH_GRACE_MS = 700; // once we have a hit, wait briefly for a newer one
const PUBLISH_TIMEOUT_MS = 7000; // stop waiting for relay OKs after this
const PUBLISH_SETTLE_MS = 1500; // ...but resolve early this long after the first OK

// open sockets to every relay; `onOpen(ws)` fires per socket as it connects and
// `onFrame(frame, ws)` for each parsed array frame. returns a close() that tears
// them all down. errors are swallowed (a dead relay just never contributes).
function openPool(relays, { onOpen, onFrame }) {
	const sockets = [];
	for (const url of relays) {
		let ws;
		try {
			ws = new WebSocket(url);
		} catch {
			continue;
		}
		sockets.push(ws);
		ws.addEventListener("open", () => onOpen?.(ws));
		ws.addEventListener("error", () => {});
		ws.addEventListener("message", (msg) => {
			let frame;
			try {
				frame = JSON.parse(msg.data);
			} catch {
				return;
			}
			if (Array.isArray(frame)) onFrame?.(frame, ws);
		});
	}
	return () => {
		for (const ws of sockets) {
			try {
				ws.close();
			} catch {}
		}
	};
}

// fetch your newest kind-0 and hand back its parsed content object (the JSON
// directory), plus the created_at of the event it came from (or 0). Resolves {}
// if you've never published a profile. Signature-verified; the highest
// created_at across relays wins. Never rejects - a total miss just resolves {}.
export function fetchProfileMetadata(pubkey, { relays = defaultRelays() } = {}) {
	return new Promise((resolve) => {
		if (!/^[0-9a-f]{64}$/.test(pubkey || "")) return resolve({ content: {}, updated: 0 });

		const subId = "glub-prof-" + Math.random().toString(36).slice(2, 8);
		let best = null; // newest verified kind-0 event
		let graceTimer = null;
		let done = false;

		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(graceTimer);
			clearTimeout(hardTimer);
			close();
			let content = {};
			if (best) {
				try {
					content = JSON.parse(best.content) || {};
				} catch {
					content = {};
				}
			}
			resolve({ content: content && typeof content === "object" ? content : {}, updated: best?.created_at || 0 });
		};

		const req = JSON.stringify(["REQ", subId, { kinds: [METADATA_KIND], authors: [pubkey], limit: 1 }]);
		const close = openPool(relays, {
			onOpen: (ws) => ws.send(req),
			onFrame: (frame) => {
				const [type, sid, ev] = frame;
				if (sid !== subId) return;
				if (type === "EVENT" && ev && ev.kind === METADATA_KIND && ev.pubkey === pubkey) {
					if ((!best || ev.created_at > best.created_at) && verifyEvent(ev)) {
						best = ev;
						if (!graceTimer) graceTimer = setTimeout(finish, FETCH_GRACE_MS);
					}
				} else if (type === "EOSE" && best && !graceTimer) {
					graceTimer = setTimeout(finish, FETCH_GRACE_MS);
				}
			},
		});

		const hardTimer = setTimeout(finish, FETCH_TIMEOUT_MS);
	});
}

// broadcast a signed kind-0 to the profile relays. Resolves { accepted } - the
// number of relays that acknowledged with an OK-true (best-effort; some relays
// stay silent). Resolves early once acknowledgements settle, or on timeout.
// Never rejects; accepted:0 means nothing confirmed (caller decides how loud).
export function publishProfileMetadata(event, { relays = defaultRelays() } = {}) {
	return new Promise((resolve) => {
		let accepted = 0;
		let settleTimer = null;
		let done = false;

		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(settleTimer);
			clearTimeout(hardTimer);
			close();
			resolve({ accepted });
		};

		const payload = JSON.stringify(["EVENT", event]);
		const close = openPool(relays, {
			onOpen: (ws) => ws.send(payload),
			onFrame: (frame) => {
				// ["OK", <id>, <bool>, <msg>] - count only accepts for our event
				if (frame[0] === "OK" && frame[1] === event.id && frame[2] === true) {
					accepted++;
					clearTimeout(settleTimer);
					settleTimer = setTimeout(finish, PUBLISH_SETTLE_MS);
				}
			},
		});

		const hardTimer = setTimeout(finish, PUBLISH_TIMEOUT_MS);
	});
}
