/**
 * Explain how the scorer classifies ONE email — use this on your real misclassified mail.
 *
 *   node tests/explain.mjs --from 'Facebook <friendsuggestion@facebookmail.com>' \
 *        --subject '👤 Manvi Mnu is a new friend suggestion for you' \
 *        --snippet 'Add friend to connect with people you may know.' --list-unsub
 *
 *   flags: --list-unsub  (List-Unsubscribe header present)   --bulk  (Precedence: bulk)
 *          --scorer <path>  compare against another scorer (e.g. tests/baseline/scorer_v2_original.mjs)
 *
 * Tip: in the extension popup, double-click a card to see the same `reasons`.
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const get = (n, d = "") => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
let p = path.resolve(get("--scorer", path.join(here, "..", "extension", "scorer.js")));
if (p.endsWith(".js")) { const t = path.join(os.tmpdir(), `explain_${process.pid}.mjs`); fs.copyFileSync(p, t); p = t; }
const { scoreEmail } = await import(pathToFileURL(p).href);

const headers = { "List-Unsubscribe": a.includes("--list-unsub") ? "<mailto:u@x.com>" : "", "Precedence": a.includes("--bulk") ? "bulk" : "" };
const r = scoreEmail(get("--subject"), get("--from"), get("--snippet"), headers);
console.log(`Category   : ${r.category}   (label ${r.label})`);
console.log(`Confidence : ${r.confidence}%   Auto-archive: ${r.archive ? "YES" : "no"}`);
if (r.scores) console.log(`Scores     : ${Object.entries(r.scores).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
if (r.phishing) console.log(`Phishing   : score ${r.phishing.score}, deception=${r.phishing.deception}, flagged=${r.phishing.flagged}`);
console.log(`Reasons    :\n  - ${r.reasons.join("\n  - ")}`);
const fired = Object.entries(r.signals || {}).filter(([, v]) => v).map(([k]) => k);
console.log(`Signals    : ${fired.join(", ") || "(none)"}`);
