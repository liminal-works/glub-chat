// tiny client-side i18n engine. no deps, no build step. english is statically
// imported so the app boots synchronously in english (the fallback); other
// locales are dynamic-imported on demand to keep the initial payload small.
//
// the browser hands us the hard parts for free, the same way iOS hands them to
// native bitchat: Intl.PluralRules for plural categories, Intl.RelativeTimeFormat
// for locale-correct "x ago", navigator.languages for detection. all we add is
// key -> string resolution + {placeholder} interpolation.
import en from "./en.js";

const FALLBACK = "en";
const STORAGE_KEY = "glub_locale"; // optional manual override (no UI yet)

// registry of additional locales: code -> async loader. add a language by
// dropping a `<code>.js` dictionary next to en.js and registering it here, e.g.
//   es: () => import("./es.js").then((m) => m.default),
const LOADERS = {
	ar: () => import("./ar.js").then((m) => m.default),
	ru: () => import("./ru.js").then((m) => m.default),
	hi: () => import("./hi.js").then((m) => m.default),
	zh: () => import("./zh.js").then((m) => m.default),
};

// scripts that read right-to-left, so we can flip <html dir> for them
const RTL = new Set(["ar", "fa", "he", "ur"]);

const dicts = { en };
let locale = FALLBACK;
let dict = en;
let plural = new Intl.PluralRules(FALLBACK);
// numberingSystem is pinned so every digit on screen is latin. Some locales
// (arabic ones especially) default to their own digits, and only the numbers
// that pass through Intl would change - a "{count}" interpolated into a string
// stays latin - which would leave the two mixed in the same sentence.
const RTF_OPTS = { style: "narrow", numberingSystem: "latn" };
let rtf = new Intl.RelativeTimeFormat(FALLBACK, { ...RTF_OPTS, numeric: "always" });
// a second formatter for whole days, on "auto" so 1 comes out as the word
// ("yesterday") rather than "1d ago" - the one case where the word is shorter AND
// clearer than the number.
let rtfDay = new Intl.RelativeTimeFormat(FALLBACK, { ...RTF_OPTS, numeric: "auto" });
const changeCbs = [];

function get(obj, key) {
	return key.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

// resolve a key against the active dict, then english, then the key itself.
function lookup(key) {
	const v = get(dict, key);
	return v != null ? v : get(en, key) != null ? get(en, key) : key;
}

function interpolate(str, vars) {
	if (!vars || typeof str !== "string") return str;
	return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

// pick a form out of a pluralized entry ({ one, other, ... }) for this count,
// degrading within the entry to "other" then "one". null if it offers neither.
function selectPlural(entry, vars) {
	const n = vars && typeof vars.count === "number" ? vars.count : 0;
	const form = plural.select(n);
	if (entry[form] != null) return entry[form];
	if (entry.other != null) return entry.other;
	return entry.one != null ? entry.one : null;
}

// translate a key. pluralized entries (objects of { one, other, ... }) are
// selected via Intl.PluralRules using vars.count; everything supports {placeholder}
// interpolation from vars.
export function t(key, vars) {
	let val = lookup(key);
	if (val && typeof val === "object") {
		// a pluralized entry is taken from ONE dictionary whole - the per-key english
		// fallback in lookup() can't reach inside it. So a locale that ships an
		// incomplete set (no form for this count and no "other") would land on the raw
		// key path while every other kind of gap degrades gracefully. Retry against
		// english, which is complete by definition, so partial plural entries behave
		// like every other partial translation: english for that one string, the
		// locale for everything else.
		const picked = selectPlural(val, vars);
		if (picked != null) return interpolate(picked, vars);
		const fallback = get(en, key);
		val = fallback && typeof fallback === "object" ? selectPlural(fallback, vars) : fallback;
		if (val == null) return key;
	}
	return interpolate(val, vars);
}

// locale-correct compact relative time ("now", "5s ago", "3m ago", "2h ago",
// "4d ago") from an epoch-seconds timestamp.
export function formatAgo(tsSeconds) {
	const s = Math.max(0, Math.floor(Date.now() / 1000) - tsSeconds);
	if (s < 5) return t("time.now");
	let value, unit;
	if (s < 60) [value, unit] = [s, "second"];
	else if (s < 3600) [value, unit] = [Math.floor(s / 60), "minute"];
	else if (s < 86400) [value, unit] = [Math.floor(s / 3600), "hour"];
	else [value, unit] = [Math.floor(s / 86400), "day"];
	return rtf.format(-value, unit);
}

// How many whole LOCAL calendar days back a timestamp falls. Deliberately not the
// same question formatAgo answers: 23:50 yesterday is only "8h ago" by elapsed time,
// but it's still a different day, and "which day was this" is exactly what a wall of
// [hh:mm:ss] stamps leaves you guessing. Compared as UTC midnights of the local
// dates so DST shifts can't turn a day boundary into 23 or 25 hours.
export function daysAgo(tsSeconds) {
	const then = new Date(tsSeconds * 1000);
	const now = new Date();
	const a = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
	const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((b - a) / 86400000);
}

// "yesterday" / "3d ago" for a timestamp on an earlier local day, "" for today (and
// for anything dated in the future, which is a badly-stamped event, not a preview).
export function formatDayAgo(tsSeconds) {
	const d = daysAgo(tsSeconds);
	return d > 0 ? rtfDay.format(-d, "day") : "";
}

export function getLocale() {
	return locale;
}

// the language the user actually wants to READ, independent of ui coverage.
// getLocale() can only ever be a language we've shipped a dictionary for, but
// content translation (the tap-menu "translate" action) supports far more
// targets than the ui does - so it asks for this instead: the manual override
// if set, else the browser's top preference, as a full tag ("pt-BR", not "pt";
// providers like DeepL want the region for pt/en/zh).
export function preferredContentLanguage() {
	const stored = (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "";
	if (stored) return stored;
	if (typeof navigator !== "undefined") {
		if (navigator.languages && navigator.languages.length) return navigator.languages[0];
		if (navigator.language) return navigator.language;
	}
	return FALLBACK;
}

export function onLocaleChange(cb) {
	changeCbs.push(cb);
}

// pick the best supported locale: a stored override, else the browser's ordered
// language preferences, else english.
export function detectLocale() {
	const stored = (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "";
	const prefs = stored
		? [stored]
		: typeof navigator !== "undefined" && navigator.languages && navigator.languages.length
		? navigator.languages
		: [(typeof navigator !== "undefined" && navigator.language) || FALLBACK];
	for (const l of prefs) {
		const base = String(l).toLowerCase().split("-")[0];
		if (base === FALLBACK || LOADERS[base]) return base;
	}
	return FALLBACK;
}

async function ensureDict(code) {
	if (dicts[code]) return dicts[code];
	const loader = LOADERS[code];
	if (!loader) return null;
	try {
		dicts[code] = await loader();
		return dicts[code];
	} catch {
		return null; // load failed - caller falls back to english
	}
}

// fill static markup: [data-i18n] -> textContent, [data-i18n-placeholder] ->
// placeholder, and the few css-generated labels exposed as custom properties
// (css content: var(--label-*)).
export function applyStaticDom() {
	if (typeof document === "undefined") return;
	for (const el of document.querySelectorAll("[data-i18n]")) {
		el.textContent = t(el.getAttribute("data-i18n"));
	}
	for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
		el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
	}
	const root = document.documentElement.style;
	root.setProperty("--label-toggle-on", JSON.stringify(t("settings.toggle_on")));
	root.setProperty("--label-toggle-off", JSON.stringify(t("settings.toggle_off")));
	root.setProperty("--label-no-users", JSON.stringify(t("users.empty")));
	root.setProperty("--label-dm-empty", JSON.stringify(t("dm.empty")));
	root.setProperty("--label-no-convos", JSON.stringify(t("dm.no_conversations")));
}

// switch the active locale (loading its dictionary if needed), update the Intl
// formatters + <html lang/dir>, refill static markup, and notify listeners so
// dynamic views re-render in the new language.
export async function setLocale(code) {
	const base = String(code || "").toLowerCase().split("-")[0];
	const target = base === FALLBACK || LOADERS[base] ? base : FALLBACK;
	const d = target === FALLBACK ? en : await ensureDict(target);

	locale = d ? target : FALLBACK;
	dict = d || en;
	plural = new Intl.PluralRules(locale);
	rtf = new Intl.RelativeTimeFormat(locale, { ...RTF_OPTS, numeric: "always" });
	rtfDay = new Intl.RelativeTimeFormat(locale, { ...RTF_OPTS, numeric: "auto" });

	if (typeof document !== "undefined") {
		document.documentElement.lang = locale;
		document.documentElement.dir = RTL.has(locale) ? "rtl" : "ltr";
	}
	applyStaticDom();
	for (const cb of changeCbs) cb();
}
