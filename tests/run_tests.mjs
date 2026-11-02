/**
 * InboxAI classification test runner.
 *
 * Usage:
 *   node tests/run_tests.mjs                          # test extension/scorer.js (current)
 *   node tests/run_tests.mjs --scorer tests/baseline/scorer_v2_original.mjs
 *   node tests/run_tests.mjs --verbose                # print every case
 *   node tests/run_tests.mjs --set dev|holdout|stress|all|everything
 *   node tests/run_tests.mjs --json out.json          # machine-readable results
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DEV, HOLDOUT, ALL } from "./cases.mjs";
import { STRESS } from "./stress.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt  = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = name => args.includes(name);

const scorerPath = path.resolve(opt("--scorer", path.join(here, "..", "extension", "scorer.js")));
const setName    = opt("--set", "all");
const verbose    = flag("--verbose");
const jsonOut    = opt("--json", null);

// extension/scorer.js is an ES module with a .js extension and no package.json,
// so copy to a temp .mjs to import it without touching the extension folder.
async function loadScorer(p) {
    let target = p;
    if (p.endsWith(".js")) {
        target = path.join(os.tmpdir(), `scorer_${process.pid}_${Date.now()}.mjs`);
        fs.copyFileSync(p, target);
    }
    return import(pathToFileURL(target).href);
}

const { scoreEmail } = await loadScorer(scorerPath);
const cases = { dev: DEV, holdout: HOLDOUT, stress: STRESS, all: ALL, everything: [...ALL, ...STRESS] }[setName];

const ARCHIVABLE = new Set(["Newsletter", "Promotion", "Social Update", "Phishing Risk"]);

function evaluate(list) {
    return list.map(tc => {
        const r = scoreEmail(tc.subject, tc.from, tc.snippet, tc.headers);
        const exact      = r.category === tc.expected;
        const acceptable = exact || tc.accept.includes(r.category);
        const shouldStay = !ARCHIVABLE.has(tc.expected);
        return {
            ...tc, got: r.category, conf: r.confidence, archive: !!r.archive,
            reasons: r.reasons, exact, acceptable,
            harmfulArchive: shouldStay && !!r.archive,
            // user-visible severity of being wrong
            phishFP: r.category === "Phishing Risk" && tc.expected !== "Phishing Risk",
            phishFN: tc.expected === "Phishing Risk" && r.category !== "Phishing Risk",
            confidentWrong: !acceptable && r.confidence >= 80,
        };
    });
}

const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : "n/a";
const res = evaluate(cases);

if (verbose) {
    for (const x of res) {
        const mark = x.exact ? "✓" : x.acceptable ? "~" : "✗";
        console.log(
            `${mark} ${x.id.padEnd(12)} exp=${x.expected.padEnd(15)} got=${x.got.padEnd(15)} ` +
            `conf=${String(x.conf).padStart(2)} arch=${x.archive ? "Y" : "n"}  ${x.subject.slice(0, 50)}`
        );
        if (!x.acceptable) console.log(`      why: ${x.reasons.join("; ")}`);
    }
    console.log();
}

// ── Summary ─────────────────────────────────────────────────────────────────
const n = res.length;
const exactN = res.filter(x => x.exact).length;
const accN   = res.filter(x => x.acceptable).length;
console.log(`Scorer: ${path.relative(process.cwd(), scorerPath)}   Set: ${setName} (${n} cases)`);
console.log(`  Exact-match accuracy     : ${exactN}/${n}  ${pct(exactN, n)}`);
console.log(`  Acceptable-match accuracy: ${accN}/${n}  ${pct(accN, n)}   (exact OR listed as defensible)`);

const stay = res.filter(x => !ARCHIVABLE.has(x.expected));
const harm = res.filter(x => x.harmfulArchive);
console.log(`  Harmful archives         : ${harm.length}/${stay.length}  ${pct(harm.length, stay.length)}   (should stay in inbox, got auto-archived)`);

const phish = res.filter(x => x.expected === "Phishing Risk");
const phishCaught = phish.filter(x => !x.phishFN).length;
const notPhish = res.filter(x => x.expected !== "Phishing Risk");
const fp = res.filter(x => x.phishFP);
console.log(`  Phishing recall          : ${phishCaught}/${phish.length}  ${pct(phishCaught, phish.length)}`);
console.log(`  Phishing false positives : ${fp.length}/${notPhish.length}  ${pct(fp.length, notPhish.length)}`);
const unc = res.filter(x => x.got === "Uncategorized").length;
console.log(`  Predicted Uncategorized  : ${unc}/${n}`);
const cw = res.filter(x => x.confidentWrong).length;
console.log(`  Confident errors (>=80%) : ${cw}`);

// ── Per-group ───────────────────────────────────────────────────────────────
console.log("\n  By group (acceptable / exact):");
const groups = [...new Set(res.map(x => x.group))];
for (const g of groups) {
    const gs = res.filter(x => x.group === g);
    const a = gs.filter(x => x.acceptable).length, e = gs.filter(x => x.exact).length;
    console.log(`    ${g.padEnd(16)} ${String(a).padStart(2)}/${String(gs.length).padEnd(2)} acceptable   ${String(e).padStart(2)}/${String(gs.length).padEnd(2)} exact`);
}

// ── Per-expected-category recall + precision (predicted) ────────────────────
console.log("\n  Per category (recall = of those expected, how many got it; precision = of those predicted, how many were right):");
const cats = [...new Set([...res.map(x => x.expected), ...res.map(x => x.got)])].sort();
for (const c of cats) {
    const exp = res.filter(x => x.expected === c), pred = res.filter(x => x.got === c);
    const tp = res.filter(x => x.expected === c && x.got === c).length;
    console.log(`    ${c.padEnd(16)} recall ${String(tp).padStart(2)}/${String(exp.length).padEnd(2)} ${pct(tp, exp.length).padStart(6)}   precision ${String(tp).padStart(2)}/${String(pred.length).padEnd(2)} ${pct(tp, pred.length).padStart(6)}`);
}

// ── Failures ────────────────────────────────────────────────────────────────
const fails = res.filter(x => !x.acceptable);
console.log(`\n  Failures (${fails.length}):`);
for (const x of fails) {
    console.log(`    ✗ ${x.id.padEnd(12)} exp=${x.expected.padEnd(14)} got=${x.got.padEnd(14)} conf=${x.conf} ${x.archive ? "ARCHIVED" : ""}  | ${x.subject.slice(0, 48)}`);
}
if (harm.length) {
    console.log(`\n  Harmful archives (${harm.length}):`);
    for (const x of harm) console.log(`    ! ${x.id.padEnd(12)} exp=${x.expected.padEnd(14)} got=${x.got.padEnd(14)} | ${x.subject.slice(0, 48)}`);
}

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(res, null, 2));
