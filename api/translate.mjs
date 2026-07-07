// optional message translation. Like avatars/media, this is an assist-only
// nicety: the translation provider's api key stays server-side and the client
// works fully without it.
//
// Ships against DeepL by default (clean REST, generous free tier), but the
// endpoint + auth are env-overridable so you can point it at DeepL Pro, a
// self-hosted LibreTranslate, or any DeepL-compatible proxy without code
// changes. When no key is set the /api/translate route reports "not configured"
// and the client quietly hides the translate action.

const API_KEY = process.env.TRANSLATE_API_KEY || process.env.DEEPL_API_KEY || "";
// free tier vs pro live on different hosts; default to free.
const API_URL = process.env.TRANSLATE_API_URL || "https://api-free.deepl.com/v2/translate";
// DeepL wants "DeepL-Auth-Key <key>"; override for other schemes (e.g. "Bearer").
const AUTH_SCHEME = process.env.TRANSLATE_AUTH_SCHEME || "DeepL-Auth-Key";

const MAX_INPUT = 2000; // matches the client-side bio/message ceilings; keeps costs bounded

export function translateConfigured() {
	return !!API_KEY;
}

// DeepL takes a 2-letter (or regional) target code, uppercased. We only ever
// pass the viewer's ui language, so a bare 2-letter code is enough.
function normalizeTarget(target) {
	const t = String(target || "en").trim().slice(0, 5).toUpperCase();
	return /^[A-Z]{2}(-[A-Z]{2})?$/.test(t) ? t : "EN";
}

// translate `text` into `target`. resolves to { text, detected } or throws.
export async function translateText(text, target) {
	if (!API_KEY) throw new Error("not configured");
	const body = new URLSearchParams();
	body.set("text", String(text).slice(0, MAX_INPUT));
	body.set("target_lang", normalizeTarget(target));

	const res = await fetch(API_URL, {
		method: "POST",
		headers: {
			Authorization: `${AUTH_SCHEME} ${API_KEY}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});
	if (!res.ok) throw new Error(`translate provider ${res.status}`);

	const data = await res.json();
	const first = data && Array.isArray(data.translations) ? data.translations[0] : null;
	return {
		text: first && typeof first.text === "string" ? first.text : "",
		// two-letter source language DeepL auto-detected (e.g. "ES"); "" if unknown
		detected: first && typeof first.detected_source_language === "string" ? first.detected_source_language : "",
	};
}
