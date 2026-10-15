// Muestra la config de dictado que reporta el serve VIVO. Uso: node tools/dictation-probe.mjs
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:3788/';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
await p.waitForTimeout(2500);
const out = await p.evaluate(async () => {
  const r = window.__aegisWeb.rpc;
  const res = {};
  try { res.config = await r.request('_aegis/unstable/dictation/config', {}); } catch (e) { res.configErr = String(e.message); }
  try { res.models = await r.request('_aegis/unstable/dictation/models/list', {}); } catch (e) { res.modelsErr = String(e.message); }
  return res;
});
const cfg = out.config || {};
console.log('defaultProvider: ' + JSON.stringify(cfg.defaultProvider ?? cfg.current ?? cfg.default ?? null));
const provs = cfg.providers || cfg.available || cfg;
for (const k of Object.keys(provs)) {
  const v = provs[k];
  if (v && typeof v === 'object') {
    console.log('  - ' + k + ' | configured=' + v.configured + ' | configKey=' + (v.configKey || '-') + ' | usesProviderConfig=' + v.usesProviderConfig);
    if (v.description) console.log('      ' + String(v.description).slice(0, 130));
  } else {
    console.log('  - ' + k + ' = ' + JSON.stringify(v));
  }
}
console.log('models: ' + JSON.stringify(out.models));
for (const k of Object.keys(out)) if (k.endsWith('Err')) console.log(k + ': ' + out[k]);
await b.close();
