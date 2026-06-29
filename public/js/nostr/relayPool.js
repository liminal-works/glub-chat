import { subscribeFilter } from "./protocol.js";

const MAX_BACKOFF_MS = 60_000;

export class RelayPool {
	constructor({
		onEvent,
		onStatusChange,
		targetCount = 12,
		maxCandidates = 40,
		expandAfterMs = 3000,
		globalMaxCount = 200,
		broadcastCount = 5,
	} = {}) {
		this.sockets = new Map(); // url -> WebSocket
		this.onEvent = onEvent || (() => {});
		this.onStatusChange = onStatusChange || (() => {});
		this.subId = "glub-web";

		this.targetCount = targetCount;
		this.maxCandidates = maxCandidates;
		this.expandAfterMs = expandAfterMs;
		this.globalMaxCount = globalMaxCount;
		this.broadcastCount = broadcastCount;

		// when false (broadcast-only mode), connections stay open for sending but
		// never REQ-subscribe - used when the history api supplies the live feed,
		// so the client isn't pulling the firehose from hundreds of relays.
		this.readMode = true;

		this.candidates = []; // urls for the current channel, nearest first
		this.cursor = 0; // candidates already attempted
		this.activeTarget = targetCount; // how many open connections we aim to hold
		this.gen = 0; // bumped on every channel switch; stale sockets/timers no-op
		this.expandTimer = null;
	}

	get total() {
		return this.sockets.size;
	}

	get connectedCount() {
		let n = 0;
		for (const ws of this.sockets.values()) {
			if (ws.readyState === WebSocket.OPEN) n++;
		}
		return n;
	}

	// sortedUrls: relay urls ordered nearest-first to the active channel's geohash center
	connectNearest(sortedUrls) {
		this.gen++;
		this._closeAll();
		this.readMode = true;

		this.candidates = sortedUrls.slice(0, this.maxCandidates);
		this.cursor = 0;
		this.activeTarget = this.targetCount;

		this._expand(this.targetCount);
		this._scheduleExpandCheck();
	}

	// urls: relay list for global (unfocused) view - connect to as many as
	// possible, capped at globalMaxCount so we don't open thousands of sockets.
	connectAll(urls) {
		this.gen++;
		this._closeAll();
		this.readMode = true;

		this.candidates = urls.slice(0, this.globalMaxCount);
		this.cursor = 0;
		this.activeTarget = this.candidates.length;

		this._expand(this.candidates.length);
	}

	// broadcast-only: hold ~broadcastCount relays open purely for sending. No REQ
	// subscription, so no inbound firehose (the api's stream supplies reads). We
	// keep a wider candidate pool than the target so the set self-heals - if some
	// relays refuse or drop, _maybeExpand pulls in the next ones to stay covered.
	connectBroadcast(sortedUrls) {
		this.gen++;
		this._closeAll();
		this.readMode = false;

		this.candidates = sortedUrls.slice(0, this.maxCandidates);
		this.cursor = 0;
		this.activeTarget = this.broadcastCount;

		this._expand(this.broadcastCount);
		this._scheduleExpandCheck();
	}

	_closeAll() {
		clearTimeout(this.expandTimer);
		for (const ws of this.sockets.values()) ws.close();
		this.sockets.clear();
	}

	_expand(count) {
		const batch = this.candidates.slice(this.cursor, this.cursor + count);
		this.cursor += batch.length;
		for (const url of batch) this._connect(url);
	}

	_maybeExpand() {
		if (this.connectedCount >= this.activeTarget) return;
		if (this.cursor >= this.candidates.length) return;
		this._expand(this.activeTarget - this.connectedCount);
	}

	_scheduleExpandCheck() {
		clearTimeout(this.expandTimer);
		const gen = this.gen;

		this.expandTimer = setTimeout(() => {
			if (gen !== this.gen) return;
			this._maybeExpand();
			if (this.connectedCount < this.activeTarget && this.cursor < this.candidates.length) {
				this._scheduleExpandCheck();
			}
		}, this.expandAfterMs);
	}

	_connect(url, attempt = 0) {
		const gen = this.gen;
		const ws = new WebSocket(url);
		this.sockets.set(url, ws);

		ws.addEventListener("open", () => {
			// broadcast-only sockets stay open for sending but never subscribe
			if (this.readMode) ws.send(JSON.stringify(["REQ", this.subId, subscribeFilter()]));
			this.onStatusChange();
		});

		ws.addEventListener("close", () => {
			// only forget this url if a newer socket hasn't already claimed it -
			// after a gen switch the same url is reconnected immediately, and an
			// old socket's late close event must not delete the fresh one.
			if (this.sockets.get(url) === ws) this.sockets.delete(url);
			this.onStatusChange();
			if (gen !== this.gen) return; // superseded by a channel switch

			const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt + 1, 6));
			setTimeout(() => {
				if (gen !== this.gen) return;
				this._connect(url, attempt + 1);
			}, delay);

			this._maybeExpand();
		});

		ws.addEventListener("error", () => {});

		ws.addEventListener("message", (msg) => {
			let frame;
			try {
				frame = JSON.parse(msg.data);
			} catch {
				return;
			}
			if (!Array.isArray(frame)) return;

			// relay rejected/ended our subscription - drop it, backoff/reconnect logic
			// in the close handler takes it from here.
			if (frame[0] === "CLOSED" && frame[1] === this.subId) {
				ws.close();
				return;
			}

			if (frame[0] !== "EVENT") return;

			const ev = frame[2];
			if (!ev?.id || !ev?.pubkey) return;

			this.onEvent(ev, url);
		});

		this.onStatusChange();
	}

	broadcast(event) {
		const payload = JSON.stringify(["EVENT", event]);
		for (const ws of this.sockets.values()) {
			if (ws.readyState === WebSocket.OPEN) ws.send(payload);
		}
	}
}
