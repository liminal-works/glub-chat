// A cashu mint as the donation backend, exposing the same shape as lightning.mjs so
// patrons.mjs never learns which one it is talking to.
//
// The difference that matters: LNbits credits a balance the moment an invoice is
// paid, and there is nothing left to do. A mint requires you to come BACK and issue
// the ecash - a quote goes UNPAID -> PAID -> ISSUED, and the proofs only exist once
// you ask for them. That third step is `collect()`, and it is why this file has a
// proof store, a mutex, and a sweep.
//
// Everything about the shape of the flow, and most of the sharp edges guarded here,
// come from the older standalone glub bot that ran this in production. The api calls
// are translated to cashu-ts v4 (createMintQuote -> createMintQuoteBolt11, and so on)
// and amounts are now Amount objects rather than numbers.

import { openProofStore } from "./proofstore.mjs";
import { invoiceForAddress } from "./lnurl.mjs";

// Amounts come back from cashu-ts as Amount value objects; sat quantities here are
// small enough that a number is always safe.
const num = (v) => {
	if (v == null) return 0;
	if (typeof v === "number") return v;
	if (typeof v?.toNumber === "function") return v.toNumber();
	return Number(v) || 0;
};

export function createCashu({ mintUrl, proofsPath, wallet = null, payout = "", sweepThresholdSats = 0 } = {}) {
	const configured = !!(mintUrl || wallet);
	const store = configured && proofsPath ? openProofStore(proofsPath) : null;

	// One at a time for anything that touches the proof set. Two concurrent melts
	// would each select proofs from the same snapshot and the second would spend
	// coins the first already destroyed - which is how a wallet loses money without
	// anyone doing anything wrong.
	let chain = Promise.resolve();
	const exclusive = (fn) => {
		const run = chain.then(fn, fn);
		chain = run.then(
			() => {},
			() => {},
		);
		return run;
	};

	let walletPromise = null;
	async function ready() {
		if (!configured) throw new Error("cashu not configured");
		if (wallet) return wallet;
		if (!walletPromise) {
			walletPromise = (async () => {
				const { Wallet } = await import("@cashu/cashu-ts");
				const w = new Wallet(mintUrl);
				await w.loadMint();
				console.log(`[cashu] mint ready: ${mintUrl}`);
				return w;
			})().catch((e) => {
				walletPromise = null; // a failed load must not poison every later call
				throw e;
			});
		}
		return walletPromise;
	}

	// --- the lightning.mjs interface -------------------------------------------
	async function createInvoice({ amountSats, memo }) {
		const w = await ready();
		const quote = await w.createMintQuoteBolt11(amountSats, memo);
		const bolt11 = String(quote?.request || "");
		const id = String(quote?.quote || "");
		if (!bolt11 || !id) throw new Error("mint quote carried no invoice");
		// Unlike LNbits, WE don't choose the expiry - the mint does. Handing it back
		// lets patrons.mjs expire its row exactly when the invoice stops being
		// payable instead of guessing, which is the difference between dropping a
		// dead row and dropping one someone is about to pay.
		return { bolt11, paymentHash: id, expiresAt: quote?.expiry ?? null };
	}

	// PAID means the money arrived and the ecash is waiting to be issued. ISSUED
	// means it arrived and has already been issued - still a real donation, so still
	// paid, and collect() below is what knows the difference.
	async function isPaid(quoteId) {
		const w = await ready();
		const status = await w.checkMintQuoteBolt11(quoteId);
		const state = String(status?.state || "").toUpperCase();
		return state === "PAID" || state === "ISSUED";
	}

	// --- the step LNbits doesn't have ------------------------------------------
	// Issue the ecash for a paid quote and get it on disk. Returns a status rather
	// than throwing for the expected cases, because the caller's job is to decide
	// whether to retry, and "not paid yet" and "the mint is down" are different
	// answers to that.
	async function collect(quoteId, amountSats) {
		if (!store) return { status: "unconfigured" };
		return exclusive(async () => {
			const w = await ready();
			const status = await w.checkMintQuoteBolt11(quoteId);
			const state = String(status?.state || "").toUpperCase();

			if (state === "UNPAID") return { status: "unpaid" };

			if (state === "ISSUED") {
				// The proofs for this quote were minted and are not in our file. Either a
				// previous run wrote them and we are looking at a restored backup, or the
				// process died in the gap between mintProofsBolt11 returning and the write
				// landing. Nothing can be re-minted from an ISSUED quote, so say so
				// loudly and stop retrying it forever.
				console.error(
					`[cashu] quote ${quoteId} is ISSUED but we hold no proofs for it. ` +
						`${amountSats} sats were minted and are not in ${store.path}.`,
				);
				return { status: "lost" };
			}

			const proofs = await w.mintProofsBolt11(amountSats, quoteId);
			if (!proofs?.length) return { status: "pending" }; // paid, mint not ready to issue - retry later
			// persisted BEFORE anything else observes success: the proofs are the money,
			// and the smallest possible window between holding them and durably having
			// them is the whole point of this ordering
			const total = store.add(proofs);
			console.log(`[cashu] collected ${amountSats} sats (${proofs.length} proofs), vault now ${total} sats`);
			return { status: "collected", proofs: proofs.length, total };
		});
	}

	// --- getting money out -------------------------------------------------------
	async function meltTo(bolt11) {
		if (!store) return { status: "unconfigured" };
		return exclusive(async () => {
			const w = await ready();
			const held = store.all();
			if (!held.length) return { status: "empty" };

			const quote = await w.createMeltQuoteBolt11(bolt11);
			const amount = num(quote?.amount);
			const reserve = num(quote?.fee_reserve);
			const need = amount + reserve;
			if (!amount) return { status: "invalid" };
			if (need > store.total()) return { status: "insufficient", need, have: store.total() };

			// The wallet picks which proofs to spend - never hand-roll this. `keep` is
			// what wasn't spent and `change` is what came back from the fee reserve;
			// losing either is losing money, which is why they are recombined below
			// rather than the sent set merely being subtracted.
			const { keep, send } = await w.send(need, held, { includeFees: true });
			let res;
			try {
				res = await w.meltProofsBolt11(quote, send);
			} catch (e) {
				// The melt may have half-happened. Put everything back rather than
				// deleting proofs we cannot prove are spent - an overstated balance is
				// recoverable by reconcile(), a deleted proof is not.
				store.replace(held);
				throw e;
			}
			const change = Array.isArray(res?.change) ? res.change : [];
			const remaining = store.replace([...keep, ...change]);
			console.log(`[cashu] swept ${amount} sats (fee<=${reserve}), vault now ${remaining} sats`);
			return { status: "sent", amount, feeReserve: reserve, remaining };
		});
	}

	// Ask for a touch less than we hold, so the melt's fee reserve has somewhere to
	// come from. Requesting an invoice for the FULL balance can never settle - the
	// melt needs amount + fee_reserve and we only have amount - so it fails every
	// time and looks like a broken vault rather than arithmetic. Whatever headroom
	// goes unused comes back as change and rolls into the next sweep.
	const payoutTarget = (balance) => Math.max(1, balance - Math.max(2, Math.ceil(balance * 0.01)));

	async function sweepToAddress(address, amountSats = null) {
		if (!store) return { status: "unconfigured" };
		const balance = store.total();
		if (!balance) return { status: "empty" };
		const bolt11 = await invoiceForAddress(address, amountSats ?? payoutTarget(balance));
		return meltTo(bolt11);
	}

	async function sweepToPayout() {
		if (!payout || !store) return { status: "no-payout" };
		const balance = store.total();
		if (!balance || balance < sweepThresholdSats) return { status: "below-threshold", balance };
		return sweepToAddress(payout);
	}

	// Ask the mint which of our proofs are actually still spendable and drop the
	// rest. Only needed after a melt failed halfway, which is why nothing calls it
	// on a schedule.
	async function reconcile() {
		if (!store) return { status: "unconfigured" };
		return exclusive(async () => {
			const w = await ready();
			const held = store.all();
			if (!held.length) return { status: "empty", dropped: 0 };
			const states = await w.checkProofsStates(held);
			const alive = held.filter((_, i) => String(states?.[i]?.state || "UNSPENT").toUpperCase() !== "SPENT");
			const dropped = held.length - alive.length;
			if (dropped) store.replace(alive);
			return { status: "ok", dropped, total: store.total() };
		});
	}

	return {
		kind: "cashu",
		configured,
		createInvoice,
		isPaid,
		collect,
		meltTo,
		sweepToAddress,
		sweepToPayout,
		reconcile,
		ready,
		balanceSats: () => (store ? store.total() : 0),
		proofCount: () => (store ? store.count() : 0),
		stats: () => ({
			kind: "cashu",
			configured,
			mint: mintUrl || null,
			vaultSats: store ? store.total() : 0,
			proofs: store ? store.count() : 0,
			payout: payout ? "set" : "none",
			sweepThresholdSats,
		}),
	};
}
