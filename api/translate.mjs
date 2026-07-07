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

// languages DeepL can translate INTO (base codes). a request for anything else
// falls back to english rather than bouncing off the provider with a 400.
// override with TRANSLATE_TARGETS (comma-separated base codes) when pointing
// at a provider with different coverage (e.g. LibreTranslate).
const DEFAULT_TARGETS =
	"ar,bg,cs,da,de,el,en,es,et,fi,fr,he,hu,id,it,ja,ko,lt,lv,nb,nl,pl,pt,ro,ru,sk,sl,sv,th,tr,uk,vi,zh";
const SUPPORTED = new Set(
	(process.env.TRANSLATE_TARGETS || DEFAULT_TARGETS).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// regional variants DeepL distinguishes; anything else collapses to the base
// code (e.g. "fr-CA" -> "FR", but "pt-BR" stays "PT-BR").
const REGIONAL = new Set(["en-gb", "en-us", "pt-br", "pt-pt", "zh-hans", "zh-hant"]);

// normalize a BCP-47-ish tag from the client ("pt-BR", "es", "fr-CA") into a
// target code the provider accepts, falling back to english when the language
// is outside the provider's coverage.
function normalizeTarget(target) {
	const tag = String(target || "en").trim().toLowerCase().slice(0, 10);
	const base = tag.split("-")[0];
	if (!/^[a-z]{2,3}$/.test(base) || !SUPPORTED.has(base)) return "EN";
	if (REGIONAL.has(tag)) return tag.toUpperCase();
	return base.toUpperCase();
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
