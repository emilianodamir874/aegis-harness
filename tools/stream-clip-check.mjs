// Verifica los dos arreglos del streaming en la app real (sin prompts reales, inyecta por WS):
//   1) los bloques recortados (.thought y .tool pre) cortan en LINEAS ENTERAS
//   2) el cursor de streaming queda en el ultimo renglon de texto, no en un renglon propio
//   3) la cola visible no usa content-visibility:auto (el historial si)
// Uso: node tools/stream-clip-check.mjs [url] [sufijo]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const tag = process.argv[3] || 'fix';
const LONG_OUT = Array.from({ length: 22 }, (_, i) => `linea ${i + 1} del recorte: ordenes buy NEW 3200 | canceladas 3195 | rango 1792200410551`).join('\n');
const THOUGHT = 'The script found 3,200 buy NEW, 3,195 cancelled, all with data — but /tmp/canc.tsv was not created. Why? Because the file write used "/tmp/canc.tsv" — and the script open(...) should have created it... unless the write failed silently. If the sandbox blocks writes outside the session root, every intermediate file fails the same way.';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

await p.goto(url, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 });
await p.waitForSelector('.sb-item', { timeout: 30000 });
// sesion larga: asi hay historial suficiente para comprobar que el resto sigue con content-visibility
await p.evaluate(() => {
  const s = window.__aegisWeb.state.sessions.slice().sort((a, b) => (b._meta?.messageCount || 0) - (a._meta?.messageCount || 0))[0];
  document.querySelector(`.sb-row[data-id="${s.sessionId}"] .sb-item`)?.click();
});
await p.waitForFunction(() => !document.querySelector('#status-pill'), null, { timeout: 180000 }).catch(() => {});
await p.waitForTimeout(2500);
const sid = await p.evaluate(() => window.__aegisWeb.state.current && window.__aegisWeb.state.current.id);
await p.addStyleTag({ content: '*, *::after, *::before { animation: none !important; }' });

const send = (u) => p.evaluate(([sid, u]) => {
  window.__aegisWeb.rpc.ws.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: u } }) });
}, [sid, u]);
const wait = (ms) => p.waitForTimeout(ms);

// turno: texto -> tool con salida larga -> razonamiento largo -> texto que termina en salto de linea
for (const c of ['El recorte fallo: ', '/tmp no es escribible ', 'desde el sandbox. ', 'Lo mando al home.']) { await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fx1', content: { type: 'text', text: c } }); await wait(60); }
await send({ sessionUpdate: 'tool_call', toolCallId: 'fx-tool', title: 'extracting order cancellations from ledger', kind: 'shell', status: 'in_progress', rawInput: { command: 'python recorte.py > /tmp/canc.tsv' } });
await wait(250);
await send({ sessionUpdate: 'tool_call_update', toolCallId: 'fx-tool', title: 'extracting order cancellations from ledger', kind: 'shell', status: 'completed', rawInput: { command: 'python recorte.py > /tmp/canc.tsv' }, content: [{ type: 'content', content: { type: 'text', text: LONG_OUT } }] });
await wait(400);
for (let i = 0; i < THOUGHT.length; i += 40) { await send({ sessionUpdate: 'agent_thought_chunk', messageId: 'fx-th', content: { type: 'text', text: THOUGHT.slice(i, i + 40) } }); await wait(40); }
await wait(300);
for (const c of ['Las hubiera tocado ', 'si seguian vivas? ', 'Hay que revisar ', 'el ledger. ', '\n\n']) { await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fx2', content: { type: 'text', text: c } }); await wait(60); }
await wait(600);

const med = await p.evaluate(() => {
  const inner = document.querySelector('#msg-inner');
  const kids = [...inner.children];
  const son = (el) => !!el;
  const last = kids[kids.length - 1];
  const primero = kids[0];
  const thought = [...inner.querySelectorAll('.msg-a .thought')].pop();
  const pre = [...inner.querySelectorAll('.tool pre')].pop();
  const streaming = document.querySelector('.msg-a.streaming');
  const cuerpo = streaming && streaming.querySelector('.content');
  const ultimo = cuerpo && cuerpo.lastElementChild;
  const lh = (e) => parseFloat(getComputedStyle(e).lineHeight);
  const cut = (e) => {
    if (!e) return null;
    const l = lh(e);
    const alto = e.clientHeight;
    return { alto: +alto.toFixed(2), linea: +l.toFixed(2), resto: +(alto % l).toFixed(2), lineas: +(alto / l).toFixed(2), cortaMitadDeGlifo: Math.min(alto % l, l - (alto % l)) > 1.5 };
  };
  const pseudo = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el, '::after');
    return { content: cs.content, display: cs.display, width: cs.width, background: cs.backgroundColor };
  };
  return {
    thought: cut(thought),
    thoughtLargo: thought ? { scrollH: thought.scrollHeight, clientH: thought.clientHeight } : null,
    pre: cut(pre),
    preLargo: pre ? { scrollH: pre.scrollHeight, clientH: pre.clientHeight } : null,
    cursorEnUltimoParrafo: ultimo ? pseudo(ultimo) : null,
    cursorEnContenedor: cuerpo ? pseudo(cuerpo) : null,
    ultimoParrafoTag: ultimo ? ultimo.tagName.toLowerCase() : null,
    ultimoTexto: ultimo ? String(ultimo.textContent).slice(-40) : null,
    cvUltimoHijo: last ? getComputedStyle(last).contentVisibility : null,
    cvPrimerHijo: primero ? getComputedStyle(primero).contentVisibility : null,
    cvStreaming: streaming ? getComputedStyle(streaming).contentVisibility : null,
    // el probe apaga TODAS las animaciones (!important), asi que el cascade real se lee del CSSOM
    animDeclarada: (() => {
      let ultimo = null, keyframes = false;
      for (const sh of document.styleSheets) {
        let reglas = [];
        try { reglas = [...sh.cssRules]; } catch (e) { continue; }
        for (const r of reglas) {
          if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'msgInSinBlur') keyframes = true;
          if (r.selectorText && /\.msg-a\.in(,|$)/.test(r.selectorText.replace(/\s+/g, ' ')) && r.style.animationName) ultimo = r.style.animationName;
        }
      }
      return { ultimo, keyframes };
    })(),
    nHijos: kids.length,
  };
});

// los botones de expandir siguen funcionando con los nuevos topes
const expandir = await p.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const th = [...document.querySelectorAll('#msg-inner .msg-a .thought')].pop();
  th?.click();
  await wait(150);
  const thAbierto = th ? getComputedStyle(th).maxHeight : null;
  const btn = [...document.querySelectorAll('#msg-inner .tool-more')].pop();
  btn?.click();
  await wait(150);
  const tool = btn ? btn.closest('.tool') : null;
  const pre = tool ? tool.querySelector('pre') : null;
  return { thAbierto, toolAbierto: tool ? getComputedStyle(pre).maxHeight : null, claseTool: tool ? tool.className : null };
});

await p.evaluate(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; });
await wait(300);
const r = await p.evaluate(() => { const x = document.querySelector('#messages').getBoundingClientRect(); return { x: Math.round(x.x), y: Math.round(x.y), width: Math.round(x.width), height: Math.round(x.height) }; });
await p.screenshot({ path: `C:/Aegis-Proyects/web/tools/shots/clip-${tag}.png`, clip: r });

const ok1 = med.thought && !med.thought.cortaMitadDeGlifo;
const ok2 = med.pre && !med.pre.cortaMitadDeGlifo;
const ok3 = med.cursorEnUltimoParrafo && med.cursorEnUltimoParrafo.content !== 'none' && med.cursorEnContenedor && med.cursorEnContenedor.content === 'none';
const ok4 = med.cvUltimoHijo === 'visible' && med.cvPrimerHijo === 'auto';
const ok5 = med.animDeclarada.ultimo === 'msgInSinBlur' && med.animDeclarada.keyframes === true;
const ok6 = expandir.thAbierto === 'none';
const ok7 = expandir.toolAbierto === 'none';
console.log(JSON.stringify({ med, expandir, erroresPagina: errs }, null, 1));
console.log('1) .thought corta en linea entera      : ' + (ok1 ? 'OK' : 'FALLA'));
console.log('2) .tool pre corta en linea entera     : ' + (ok2 ? 'OK' : 'FALLA'));
console.log('3) cursor en el ultimo parrafo         : ' + (ok3 ? 'OK' : 'FALLA'));
console.log('4) cola sin content-visibility, historial con auto: ' + (ok4 ? 'OK' : 'FALLA'));
console.log('5) mensaje en streaming sin blur de entrada   : ' + (ok5 ? 'OK' : 'FALLA'));
console.log('6) razonamiento se expande al tocarlo         : ' + (ok6 ? 'OK' : 'FALLA'));
console.log('7) "Ver todo" del tool sigue expandiendo       : ' + (ok7 ? 'OK' : 'FALLA'));
await b.close();
process.exit(0);
