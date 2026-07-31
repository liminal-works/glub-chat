// Translation coverage report. Run: npm run i18n
//
// English is the source of truth and every other locale falls back to it PER KEY,
// so a partial translation is a supported state, not a broken one - ship an
// english string today and let the locales catch up whenever. This script exists
// so "catch up later" stays visible instead of silent: it prints what each locale
// is missing, and fails only on the things that are actually wrong.
//
// Reported but NOT failed:
//   * missing keys        - they render in english, which is the design
// Failed:
//   * placeholder drift   - "{name}" lost or invented in a translation, which
//                           renders a literal "{name}" or drops the value entirely
//   * unknown keys        - a key english doesn't have is dead weight or a typo
//   * unusable plurals    - a pluralized entry with no form this locale can select
//                           (english covers it now, but the entry is still wrong)
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "js", "i18n");
const load = async (code) => (await import(pathToFileURL(join(DIR, `${code}.js`)).href)).default;

// sections deliberately left untranslated everywhere, with why. Emotes are
// broadcast as message CONTENT in canonical bitchat wording, so they must not vary
// by the sender's ui language.
const INTENTIONAL = { emote: "broadcast as message content - stays english for every sender" };

const flat = (o, p = "") =>
	Object.entries(o).flatMap(([k, v]) =>
		v && typeof v === "object" && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [`${p}${k}`],
	);
const get = (o, k) => k.split(".").reduce((a, b) => (a == null ? a : a[b]), o);
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const isPluralEntry = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => /^(zero|one|two|few|many|other)$/.test(k));

const en = await load("en");
const codes = readdirSync(DIR)
	.filter((f) => f.endsWith(".js") && f !== "en.js" && f !== "index.js")
	.map((f) => f.replace(/\.js$/, ""))
	.sort();

// compare on the entry, not the leaf: a plural object is one translatable unit
const enKeys = flat(en).map((k) => (isPluralEntry(get(en, k.replace(/\.[^.]+$/, ""))) ? k.replace(/\.[^.]+$/, "") : k));
const enUnits = [...new Set(enKeys)];

let bad = 0;
console.log(`english: ${enUnits.length} translatable strings\n`);

for (const code of codes) {
	const dict = await load(code);
	const missing = [];
	const drift = [];
	const brokenPlural = [];
	const rules = new Intl.PluralRules(code);

	for (const key of enUnits) {
		const enVal = get(en, key);
		const val = get(dict, key);
		if (val == null) {
			missing.push(key);
			continue;
		}
		if (isPluralEntry(enVal)) {
			// every category this locale can actually select must resolve to something
			const usable = ["one", "other"].some((f) => val[f] != null) || rules.select(2) in val;
			if (!usable) brokenPlural.push(key);
			continue;
		}
		if (typeof enVal === "string" && placeholders(enVal) !== placeholders(val)) {
			drift.push(`${key}  en{${placeholders(enVal)}} -> ${code}{${placeholders(val)}}`);
		}
	}

	// a key english doesn't have. The one legitimate case is a plural FORM
	// (dm.unread.few) under an entry english does have - locales carry different
	// categories, so those are expected rather than stray.
	const unknown = flat(dict).filter((k) => {
		if (get(en, k) != null) return false;
		const parent = k.replace(/\.[^.]+$/, "");
		return !(parent !== k && isPluralEntry(get(en, parent)));
	});

	const intentional = missing.filter((k) => INTENTIONAL[k.split(".")[0]]);
	const real = missing.filter((k) => !INTENTIONAL[k.split(".")[0]]);
	const pct = Math.round(((enUnits.length - real.length) / enUnits.length) * 100);

	console.log(`${code}: ${pct}% (${enUnits.length - real.length}/${enUnits.length})`);
	if (real.length) {
		console.log(`   ${real.length} untranslated - these render in english:`);
		for (const k of real.slice(0, 40)) console.log(`      ${k}`);
		if (real.length > 40) console.log(`      ... and ${real.length - 40} more`);
	}
	for (const sect of new Set(intentional.map((k) => k.split(".")[0]))) {
		console.log(`   skipped "${sect}" on purpose - ${INTENTIONAL[sect]}`);
	}
	for (const d of drift) console.log(`   PLACEHOLDER DRIFT  ${d}`);
	for (const k of unknown) console.log(`   UNKNOWN KEY        ${k}`);
	for (const k of brokenPlural) console.log(`   UNUSABLE PLURAL    ${k} (no form this locale can select)`);
	bad += drift.length + unknown.length + brokenPlural.length;
	console.log();
}

if (bad) {
	console.log(`${bad} problem(s) that english can't paper over.`);
	process.exit(1);
}
console.log("no problems. missing keys are fine - they fall back to english.");
