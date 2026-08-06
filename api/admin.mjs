// Admin authorisation, ported from the standalone bitbot.
//
// The shape is: a short code rotates on a timer and is printed on EVERY console
// line, so an operator with terminal access can always read it off the last line
// rather than hunting back through scrollback for the one message that carried it.
// Redeeming it in chat adds your pubkey to a persisted allow-list, and redemption
// immediately rotates the code - so a code that ends up in a public channel, a
// screenshot, or a log someone pasted is already dead by the time anyone reads it.
//
// Terminal access is the root credential, which is the point: it needs no shared
// secret in .env, nothing to keep in sync, and nothing that survives being seen.
// GLUB_ADMIN_PUBKEYS still works for permanent admins who never redeem anything.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// No I, O, 0 or 1: the code gets read off a terminal and typed into a phone, and
// those four are exactly where that goes wrong.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 5;
const HEX64 = /^[0-9a-f]{64}$/;

// A failed redemption never rotates the code - otherwise anyone could force
// rotation on demand and keep the operator's copy permanently stale. Instead
// failures are counted globally and throttled, which also stops the log filling
// with guesses. 32^5 is 33.5M codes against a 7 minute window, so this is
// belt-and-braces rather than the actual defence.
const FAIL_WINDOW_MS = 60_000;
const FAIL_MAX = 10;

const nowSec = () => Math.floor(Date.now() / 1000);

function genCode() {
	let out = "";
	for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
	return out;
}

export function createAdmin({ statePath, envPubkeys = [], codeTtlSec = 420, botName = "glub.bot" } = {}) {
	const file = statePath ? path.resolve(statePath) : "";
	// permanent admins from the environment; these never expire and never need a code
	const permanent = new Set(
		[...envPubkeys].map((s) => String(s).trim().toLowerCase()).filter((s) => HEX64.test(s)),
	);
	const authorized = new Set(); // redeemed at runtime, persisted
	let code = genCode();
	let expiresAt = nowSec() + codeTtlSec;
	let fails = [];
	let rotateTimer = null;

	function load() {
		if (!file) return;
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			for (const pk of raw.authorized || []) {
				const s = String(pk).trim().toLowerCase();
				if (HEX64.test(s)) authorized.add(s);
			}
		} catch {
			// first run, or a file we can't read. Either way an empty allow-list is the
			// safe default: the code is still on every log line, so an operator can
			// always let themselves back in.
		}
	}

	function save() {
		if (!file) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ authorized: [...authorized] }, null, 2));
			fs.renameSync(tmp, file); // atomic: never a half-written allow-list
		} catch (e) {
			console.error(`[admin] could not persist authorized pubkeys: ${e.message}`);
		}
	}

	function setTerminalTitle() {
		if (!process.stdout.isTTY) return;
		process.stdout.write(`\x1b]0;${botName}  admin ${code}\x07`);
	}

	function rotate(reason = "timer") {
		code = genCode();
		expiresAt = nowSec() + codeTtlSec;
		setTerminalTitle();
		// the code itself is in the line prefix, so it is deliberately NOT repeated here
		console.log(`[admin] code rotated (${reason})`);
		return code;
	}

	// Lazily rotates when read past its expiry, so a bot that sat idle overnight
	// never serves a stale code that an old screenshot would still satisfy.
	function current() {
		if (!code || nowSec() >= expiresAt) rotate("expired");
		return code;
	}

	function isAdmin(pubkey) {
		const pk = String(pubkey || "").toLowerCase();
		if (!pk) return false;
		return permanent.has(pk) || authorized.has(pk);
	}

	function throttled() {
		const cutoff = Date.now() - FAIL_WINDOW_MS;
		fails = fails.filter((t) => t > cutoff);
		return fails.length >= FAIL_MAX;
	}

	// Single use: a correct code authorises the pubkey and immediately rotates, so
	// the code that just travelled through a public channel is spent.
	function redeem(attempt, pubkey) {
		const pk = String(pubkey || "").toLowerCase();
		if (!HEX64.test(pk)) return { status: "invalid" };
		if (isAdmin(pk)) return { status: "already" };
		if (throttled()) return { status: "throttled" };

		const given = String(attempt || "").trim().toUpperCase();
		if (!given || given !== current()) {
			fails.push(Date.now());
			console.log(`[admin] failed code from ${pk.slice(0, 12)}...`);
			return { status: "denied" };
		}

		authorized.add(pk);
		save();
		console.log(`[admin] authorized ${pk.slice(0, 12)}...`);
		rotate("used");
		return { status: "ok" };
	}

	function revoke(pubkey) {
		const pk = String(pubkey || "").toLowerCase();
		// permanent admins come from the environment, so revoking one here would be a
		// lie that reverts on the next restart
		if (permanent.has(pk)) return { status: "permanent" };
		if (!authorized.delete(pk)) return { status: "none" };
		save();
		return { status: "ok" };
	}

	function clear() {
		const n = authorized.size;
		authorized.clear();
		save();
		return n;
	}

	load();
	setTerminalTitle();
	if (authorized.size) console.log(`[admin] restored ${authorized.size} authorized pubkey(s)`);
	if (permanent.size) console.log(`[admin] ${permanent.size} permanent admin(s) from the environment`);
	rotateTimer = setInterval(() => rotate("timer"), codeTtlSec * 1000);
	rotateTimer.unref?.();

	return {
		get code() {
			return current();
		},
		// The raw string, with no lazy rotation. attachConsole reads THIS: the getter
		// above can rotate, and rotating logs, and logging reads the code - a loop that
		// currently terminates only because rotate() assigns before it logs. Depending
		// on that ordering forever is how a future edit deadlocks the process.
		peek: () => code,
		isAdmin,
		redeem,
		revoke,
		clear,
		rotate,
		authorized: () => [...authorized],
		permanent: () => [...permanent],
		stats: () => ({ authorized: authorized.size, permanent: permanent.size, codeTtlSec }),
		stop: () => clearInterval(rotateTimer),
	};
}

// Prefix every console line with the live admin code. This is a deliberate global
// patch rather than a log() helper each module imports: the point is that the code
// is on the LAST line of output whatever produced it - the aggregator, the mint,
// express - so an operator glancing at the terminal never has to search for it.
export function attachConsole(admin) {
	const wrap = (fn) =>
		(...args) =>
			fn(admin.peek(), ...args);
	console.log = wrap(console.log.bind(console));
	console.warn = wrap(console.warn.bind(console));
	console.error = wrap(console.error.bind(console));
}
