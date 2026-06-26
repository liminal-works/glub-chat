import { subscribeFilter } from "./protocol.js";

const MAX_BACKOFF_MS = 60_000;

export class RelayPool {
	constructor({ onEvent, onStatusChange } = {}) {
		this.sockets = new Map(); // url -> WebSocket
		this.onEvent = onEvent || (() => {});
		this.onStatusChange = onStatusChange || (() => {});
		this.subId = "glub-web";
		this.sinceSec = Math.floor(Date.now() / 1000);
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

	connectAll(urls) {
		for (const url of urls) this._connect(url);
	}

	_connect(url, attempt = 0) {
		const ws = new WebSocket(url);
		this.sockets.set(url, ws);

		ws.addEventListener("open", () => {
			ws.send(JSON.stringify(["REQ", this.subId, subscribeFilter(this.sinceSec)]));
			this.onStatusChange();
		});

		ws.addEventListener("close", () => {
			this.sockets.delete(url);
			this.onStatusChange();

			const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt + 1, 6));
			setTimeout(() => this._connect(url, attempt + 1), delay);
		});

		ws.addEventListener("error", () => {});

		ws.addEventListener("message", (msg) => {
			let frame;
			try {
				frame = JSON.parse(msg.data);
			} catch {
				return;
			}
			if (!Array.isArray(frame) || frame[0] !== "EVENT") return;

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
