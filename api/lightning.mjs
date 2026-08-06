// The lightning backend, behind the narrowest interface donations actually need:
// mint an invoice, and ask whether one has been paid. Everything LNbits-specific
// lives in this file, so pointing glub at phoenixd or an LND node later is one
// module to rewrite rather than a search across the API.
//
// The key this wants is LNbits' INVOICE/read key, not the admin key. That key can
// create invoices and read their status and nothing else - it cannot spend. If it
// leaks, the worst anyone can do is mint invoices payable to you.

const DEFAULT_TIMEOUT_MS = 8000;

export function createLightning({ url, invoiceKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const base = String(url || "").replace(/\/+$/, "");
	const key = String(invoiceKey || "");
	const configured = !!(base && key);

	async function call(path, init = {}) {
		if (!configured) throw new Error("lightning not configured");
		const res = await fetch(base + path, {
			...init,
			headers: { "X-Api-Key": key, "Content-Type": "application/json", ...(init.headers || {}) },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			// a proxy error page rather than the API: fall through to the status check,
			// which reports it far more usefully than a JSON parse error would
		}
		if (!res.ok) {
			const detail = body?.detail || body?.message || text.slice(0, 200);
			throw new Error(`lnbits ${res.status}${detail ? `: ${detail}` : ""}`);
		}
		return body;
	}

	return {
		configured,

		// A bolt11 for `amountSats` that anyone can pay - which is the point, since a
		// donation invoice posted in a public channel is one another person can settle
		// on your behalf. `expirySec` is what makes the one-open-invoice-per-pubkey
		// rule safe: an unpaid invoice ages out by itself, with nothing to clean up.
		async createInvoice({ amountSats, memo, expirySec }) {
			const body = await call("/api/v1/payments", {
				method: "POST",
				body: JSON.stringify({ out: false, amount: amountSats, memo, expiry: expirySec, unit: "sat" }),
			});
			// LNbits renamed both of these across versions. Accepting either beats
			// pinning to a deployment we don't control.
			const bolt11 = body?.bolt11 || body?.payment_request || "";
			const paymentHash = body?.payment_hash || body?.checking_id || "";
			if (!bolt11 || !paymentHash) throw new Error("lnbits: response carried no invoice");
			return { bolt11, paymentHash };
		},

		// True only for a settled invoice. Every other outcome - unpaid, unknown hash,
		// a shape we don't recognise - is false, never an exception, because the only
		// thing a caller does with `true` is hand someone a paid identity. An error
		// here has to fail closed.
		async isPaid(paymentHash) {
			const body = await call(`/api/v1/payments/${encodeURIComponent(paymentHash)}`);
			return (
				body?.paid === true || // older LNbits
				body?.status === "success" || // v1
				body?.details?.status === "success"
			);
		},
	};
}
