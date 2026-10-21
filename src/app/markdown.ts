// Markdown del chat: texto -> HTML (inline, tablas con data-label, listas, citas, code fences).
// Puro: entra un string, sale un string; el unico helper externo es el escape de HTML.

import { esc } from './format';

  // ---------- markdown ----------
  const inline = (t) => {
    let s = esc(t);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  };
  // ---- tablas (pipes) ----
  // Fila de encabezado + separador (|---|---|) + filas. Sin esto el operador veía los "|"
  // crudos en el chat (reporte con foto del 2026-10-12).
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l);
  const splitRow = (l) => {
    let s = String(l).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };
  const alignsOf = (sep) => splitRow(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const tableHtml = (head, aligns, rows) => {
    // data-label = texto plano del encabezado de esa columna: en pantalla angosta la tabla se
    // rearma como tarjetas (una fila = una tarjeta con etiqueta y valor). Sin eso, el navegador
    // aplasta la columna y parte las palabras letra por letra.
    const plain = (s) => String(s == null ? '' : s).replace(/[*`_]/g, '').trim();
    const cell = (tag, txt, i, label?) => { const a = aligns[i]; return `<${tag}${a ? ` style="text-align:${a}"` : ''}${label ? ` data-label="${esc(label)}"` : ''}>${inline(txt)}</${tag}>`; };
    // Todas las tablas de dos columnas son pares etiqueta/valor en movil, incluso si una
    // celda es larga o todavia no hay filas. Las de 3+ columnas siguen como tarjetas.
    return '<div class="tbl-wrap"><table' + (head.length === 2 ? ' data-cols="2"' : '') + '><thead><tr>' + head.map((c, i) => cell('th', c, i)).join('') + '</tr></thead>'
      + (rows.length ? '<tbody>' + rows.map((r) => '<tr>' + head.map((_, i) => cell('td', r[i] == null ? '' : r[i], i, plain(head[i]))).join('') + '</tr>').join('') + '</tbody>' : '')
      + '</table></div>';
  };
  const mdBlocks = (t) => {
    const lines = t.split(/\r?\n/);
    let out = '';
    let para = [];
    let list = [];
    let listType = null;
    const flushPara = () => { if (para.length) { out += `<p>${para.join('<br>')}</p>`; para = []; } };
    const flushList = () => { if (listType) { out += `<${listType}>${list.map((x) => `<li>${x}</li>`).join('')}</${listType}>`; listType = null; list = []; } };
    for (let _i = 0; _i < lines.length; _i++) {
      const line = lines[_i];
      if (line.includes('|') && _i + 1 < lines.length && isTableSep(lines[_i + 1])) {
        flushPara(); flushList();
        const head = splitRow(line);
        const aligns = alignsOf(lines[_i + 1]);
        const rows = [];
        let j = _i + 2;
        while (j < lines.length && lines[j].includes('|') && !/^\s*$/.test(lines[j])) { rows.push(splitRow(lines[j])); j++; }
        out += tableHtml(head, aligns, rows);
        _i = j - 1;
        continue;
      }
      const mH = /^(#{1,5})\s+(.*)$/.exec(line);
      const mUl = /^\s*[-*•]\s+(.*)$/.exec(line);
      const mOl = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const mQ = /^>\s?(.*)$/.exec(line);
      const mHr = /^\s*([-*_])\1{2,}\s*$/.test(line);
      if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
      if (mHr) { flushPara(); flushList(); out += '<hr>'; continue; }
      if (mH) { flushPara(); flushList(); const lvl = Math.min(mH[1].length + 2, 5); out += `<h${lvl}>${inline(mH[2])}</h${lvl}>`; continue; }
      if (mUl) { flushPara(); if (listType !== 'ul') { flushList(); listType = 'ul'; } list.push(inline(mUl[1])); continue; }
      if (mOl) { flushPara(); if (listType !== 'ol') { flushList(); listType = 'ol'; } list.push(inline(mOl[1])); continue; }
      if (mQ) { flushPara(); flushList(); out += `<blockquote>${inline(mQ[1])}</blockquote>`; continue; }
      flushList();
      para.push(inline(line));
    }
    flushPara(); flushList();
    return out;
  };
  export const md = (text) => {
    const parts = String(text ?? '').split('```');
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const body = parts[i].replace(/^[a-zA-Z0-9+#_.-]* ?\r?\n/, '').replace(/\r?\n$/, '');
        html += `<div class="code-wrap"><button class="copy-code" type="button">Copiar</button><pre><code>${esc(body)}</code></pre></div>`;
      } else {
        html += mdBlocks(parts[i]);
      }
    }
    return html;
  };
