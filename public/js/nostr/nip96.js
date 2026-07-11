// NIP-96 media upload to nostr.build, authenticated with NIP-98 - the standard
// nostr pattern for client-side file hosting. No api key and no server help:
// each upload is authorized by a one-off kind-27235 event signed with the
// user's identity key, sent as `Authorization: Nostr <base64(event)>`. The
// response hands back a permanent hosted URL (nostr.build's free tier doesn't
// expire files), which the caller drops into the note text like any pasted
// image link.
//
// Used for location notes specifically: notes can persist forever, so their
// media needs a permanent host - unlike chat, whose uploads ride the api's
// temporary store.

import { finalizeEvent } from "https://esm.sh/nostr-tools@2";

const UPLOAD_URL = "https://nostr.build/api/v2/nip96/upload";
export const NOSTR_BUILD_MAX_BYTES = 20 * 1024 * 1024; // free-tier per-file cap
export const NOSTR_BUILD_MAX_MB = 20;

function bytesToHex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// NIP-98: a signed event naming the exact url + method (+ sha256 of the file),
// so the header can't be replayed against another endpoint or payload.
async function nip98Header(fileBuf, sk) {
	const digest = await crypto.subtle.digest("SHA-256", fileBuf);
	const auth = finalizeEvent(
		{
			kind: 27235,
			created_at: Math.floor(Date.now() / 1000),
			tags: [
				["u", UPLOAD_URL],
				["method", "POST"],
				["payload", bytesToHex(new Uint8Array(digest))],
			],
			content: "",
		},
		sk,
	);
	// the signed event is pure ASCII (hex keys/sig + these tags), so btoa is safe
	return "Nostr " + btoa(JSON.stringify(auth));
}

// upload an image File/Blob; resolves { url } (the permanent hosted url) or
// throws. size/type validation is the caller's job (it owns the error UI).
export async function uploadImageToNostrBuild(file, { sk }) {
	const buf = await file.arrayBuffer();
	const authorization = await nip98Header(buf, sk);

	const form = new FormData();
	form.append("file", file, file.name || "image");

	const res = await fetch(UPLOAD_URL, {
		method: "POST",
		headers: { Authorization: authorization },
		body: form,
	});
	if (!res.ok) throw new Error(`upload failed: http ${res.status}`);
	const data = await res.json();
	if (data?.status !== "success") throw new Error(data?.message || "upload rejected");

	// NIP-96 success responses carry a NIP-94-shaped tag list; url is the one we need
	const url = (data.nip94_event?.tags || []).find((t) => Array.isArray(t) && t[0] === "url")?.[1];
	if (!url || !/^https:\/\//.test(url)) throw new Error("no url in upload response");
	return { url };
}
