// E2E v3 (verificacion corregida): las aserciones miran SOLO burbujas del asistente.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const out = {};

let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || m.params.options[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'swallow3', version: '1' } });

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
try {
  await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(2000);

  await p.click('#btn-new');
  await p.waitForTimeout(1500);
  await p.fill('#input', 'Ejecutá shell: powershell -NoProfile -Command "Start-Sleep -Seconds 25". Después respondé LISTO77.');
  await p.press('#input', 'Enter');
  await p.waitForTimeout(5000);
  out.sid = await p.evaluate(() => localStorage.getItem('gweb.last'));
  out.busy1 = await p.evaluate(() => !!(window.__aegisWeb?.state?.busy));

  await p.fill('#input', 'MARCA-SWALLOW-77: cuando lo veas respondé ZZFIN77.');
  await p.press('#input', 'Enter');
  await p.waitForTimeout(2500);
  out.busy2 = await p.evaluate(() => !!(window.__aegisWeb?.state?.busy));
  out.steerEnCola = await p.evaluate(() => !!document.querySelector('.msg-user.queued'));

  const btn = p.locator('#runbar-stop');
  if ((await btn.count()) && (await btn.isVisible())) { await btn.click(); out.stop = 'runbar-stop'; }
  else { await p.evaluate(() => { const s = document.querySelector('#btn-stop'); if (s) s.click(); }); out.stop = 'btn-stop'; }

  out.serie = [];
  for (let i = 0; i < 45; i++) {
    await p.waitForTimeout(2000);
    const st = await p.evaluate(() => {
      const asist = [...document.querySelectorAll('.msg-a')];
      const user = [...document.querySelectorAll('.msg-user')];
      return {
        notas: [...document.querySelectorAll('.sysnote')].map((e) => e.innerText).filter((x) => /sin respuesta|se reenv/i.test(x)),
        respZZ: asist.some((e) => e.innerText.includes('ZZFIN77')),
        respListo: asist.some((e) => e.innerText.includes('LISTO77')),
        marcasUser: user.filter((e) => e.innerText.includes('MARCA-SWALLOW-77')).length,
        busy: !!(window.__aegisWeb?.state?.busy),
      };
    });
    out.serie.push(`t=${(i + 1) * 2}s busy=${st.busy ? 1 : 0} notas=${st.notas.length} marc=${st.marcasUser} resZZ=${st.respZZ ? 1 : 0} resListo=${st.respListo ? 1 : 0}`);
    out.final = st;
    if (st.respZZ) break;
    if (i > 10 && !st.busy && !st.notas.length && st.marcasUser === 0) break;
  }
  out.veredicto = out.final?.respZZ
    ? (out.final.notas.length ? 'OK - reenvio + respuesta ZZFIN77 del asistente' : 'OK-raro - ZZFIN77 sin nota de reenvio')
    : (out.final?.notas.length ? 'PARCIAL - reenvio visto, sin respuesta del asistente' : 'FALLO - no se reenvio');
  out.sidFinal = out.sid;
} catch (e) {
  out.crash = String(e).slice(0, 220);
} finally {
  await b.close().catch(() => {});
  ws.close();
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
