// Turn a lightning address ("you@wallet.com") into a bolt11 for a given amount.
// This is LNURL-pay (LUD-16 + LUD-06): resolve the address to a pay endpoint, then
// ask that endpoint's callback for an invoice.
//
// It exists so the auto-sweep has somewhere to send money without an operator being
// awake. That makes it the one place in the donation path that names a destination,
// so it validates hard: an address that resolves to something unexpected must fail
// loudly rather than produce an invoice payable to a stranger.

const TIMEOUT_MS = 8000;

// LUD-16 addresses look like an email and are resolved over https. The local part is
// restricted here to the characters LUD-16 allows, which also keeps it from smuggling
// a path segment into the url below.
const ADDRESS_RE = /^([a-z0-9-_.]+)@([a-z0-9-.]+\.[a-z]{2,})$/i;

export function parseLightningAddress(address) {
	const m = ADDRESS_RE.exec(String(address || "").trim());
	if (!m) return null;
	const [, name, domain] = m;
	return { name: name.toLowerCase(), domain: domain.toLowerCase() };
}

async function getJson(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = await res.json();
	// LNURL signals failure in the BODY with a 200 status, so a bare res.ok check
	// would happily treat "wallet not found" as success and return undefined later.
	if (body?.status === "ERROR") throw new Error(body.reason || "lnurl error");
	return body;
}

// amountSats -> bolt11 payable to `address`. Throws rather than returning null: every
// caller is about to move money and none of them should proceed on a falsy value.
export async function invoiceForAddress(address, amountSats) {
	const parsed = parseLightningAddress(address);
	if (!parsed) throw new Error(`not a lightning address: ${address}`);

	const sats = Math.floor(Number(amountSats) || 0);
	if (sats <= 0) throw new Error("amount must be positive");
	const msats = sats * 1000;

	const meta = await getJson(`https://${parsed.domain}/.well-known/lnurlp/${parsed.name}`);
	if (meta?.tag !== "payRequest" || !meta?.callback) throw new Error("address is not an lnurl-pay endpoint");

	// The endpoint declares the range it will invoice for. Checking it here turns a
	// confusing downstream failure into a clear one, and stops the sweep from
	// hammering a callback that was never going to answer.
	const min = Number(meta.minSendable ?? 0);
	const max = Number(meta.maxSendable ?? Infinity);
	if (msats < min || msats > max) {
		throw new Error(`${sats} sats is outside the payable range (${Math.ceil(min / 1000)}-${Math.floor(max / 1000)} sats)`);
	}

	const callback = new URL(meta.callback);
	if (callback.protocol !== "https:") throw new Error("lnurl callback is not https");
	callback.searchParams.set("amount", String(msats));

	const res = await getJson(callback.toString());
	const bolt11 = String(res?.pr || "");
	if (!/^ln[a-z0-9]+$/i.test(bolt11)) throw new Error("lnurl callback returned no invoice");
	return bolt11;
}
