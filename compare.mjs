/** Before/after comparison table. Usage: node tests/compare.mjs */
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DEV, HOLDOUT } from "./cases.mjs"; import { STRESS } from "./stress.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
async function load(p){ if(p.endsWith(".js")){const t=path.join(os.tmpdir(),`cmp_${process.pid}_${Math.random()}.mjs`);fs.copyFileSync(p,t);p=t;} return import(pathToFileURL(p).href); }
const OLD = await load(path.join(here,"baseline","scorer_v2_original.mjs"));
const NEW = await load(path.join(here,"..","extension","scorer.js"));
const ARCH = new Set(["Newsletter","Promotion","Social Update","Phishing Risk"]);
function m(scorer, cases){
  const r = cases.map(t=>({t, r:scorer.scoreEmail(t.subject,t.from,t.snippet,t.headers)}));
  const exact = r.filter(x=>x.r.category===x.t.expected).length;
  const acc   = r.filter(x=>x.r.category===x.t.expected||x.t.accept.includes(x.r.category)).length;
  const stay  = r.filter(x=>!ARCH.has(x.t.expected));
  const harm  = stay.filter(x=>x.r.archive).length;
  const ph    = r.filter(x=>x.t.expected==="Phishing Risk"), phOk=ph.filter(x=>x.r.category==="Phishing Risk").length;
  const non   = r.filter(x=>x.t.expected!=="Phishing Risk"), fp=non.filter(x=>x.r.category==="Phishing Risk").length;
  const cw    = r.filter(x=>!(x.r.category===x.t.expected||x.t.accept.includes(x.r.category)) && x.r.confidence>=80).length;
  return {n:cases.length,exact,acc,harm,stay:stay.length,phOk,ph:ph.length,fp,non:non.length,cw};
}
const pct=(a,b)=>b?`${(100*a/b).toFixed(1)}%`:"n/a";
const sets=[["DEV (reported + real-inbox patterns)",DEV],["HOLDOUT (see contamination note)",HOLDOUT],["STRESS (adversarial)",STRESS],["ALL COMBINED",[...DEV,...HOLDOUT,...STRESS]]];
let out="| Set | n | Exact (old→new) | Acceptable (old→new) | Harmful archives (old→new) | Phishing recall (old→new) | Phishing FP (old→new) | Confident errors ≥80% (old→new) |\n|---|---|---|---|---|---|---|---|\n";
for (const [name,cs] of sets){ const a=m(OLD,cs), b=m(NEW,cs);
  out+=`| ${name} | ${a.n} | ${pct(a.exact,a.n)} → **${pct(b.exact,b.n)}** | ${pct(a.acc,a.n)} → **${pct(b.acc,b.n)}** | ${a.harm}/${a.stay} → **${b.harm}/${b.stay}** | ${a.phOk}/${a.ph} → **${b.phOk}/${b.ph}** | ${a.fp}/${a.non} → **${b.fp}/${b.non}** | ${a.cw} → **${b.cw}** |\n`; }
console.log(out);
