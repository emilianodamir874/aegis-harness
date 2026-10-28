// Markdown del chat. Misma semántica que src/app/markdown.ts del cliente actual:
// inline, tablas con data-label para móvil, listas, citas, fences con lenguaje y botón Copiar.
// Puro: string -> HTML. Todo texto se escapa antes de insertar markup.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

const inline = (text: string): string => {
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Descargas de esta web: nunca convertir una ruta arbitraria en href.
  s = s.replace(
    /\[([^\]\n]+)\]\(\/dl\/([A-Za-z0-9._-]{1,120})\)/g,
    (_match, label: string, name: string) =>
      `<a class="dl-chip" href="/dl/${name}" download="${name}"><span class="dl-ico" aria-hidden="true">↓</span><span>${label}</span></a>`,
  );
  s = s.replace(
    /(https?:\/\/[^\s<)]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return s;
};

const isTableSep = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => cell.trim());
};

const alignsOf = (sep: string): string[] =>
  splitRow(sep).map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '',
  );

const plain = (value: unknown): string => String(value ?? '').replace(/[*`_]/g, '').trim();

const tableHtml = (head: string[], aligns: string[], rows: string[][]): string => {
  const cell = (tag: 'th' | 'td', text: string, index: number, label?: string): string => {
    const align = aligns[index];
    const style = align ? ` style="text-align:${align}"` : '';
    const labelAttr = label ? ` data-label="${esc(label)}"` : '';
    return `<${tag}${style}${labelAttr}>${inline(text)}</${tag}>`;
  };
  const headHtml = head.map((text, index) => cell('th', text, index)).join('');
  const bodyHtml = rows
    .map((row) => `<tr>${head.map((_, index) => cell('td', row[index] ?? '', index, plain(head[index]))).join('')}</tr>`)
    .join('');
  return (
    `<div class="tbl-wrap"><table${head.length === 2 ? ' data-cols="2"' : ''}>` +
    `<thead><tr>${headHtml}</tr></thead>` +
    (rows.length ? `<tbody>${bodyHtml}</tbody>` : '') +
    '</table></div>'
  );
};

const mdBlocks = (text: string): string => {
  const lines = text.split(/\r?\n/);
  let out = '';
  let paragraph: string[] = [];
  let list: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length) {
      out += `<p>${paragraph.join('<br>')}</p>`;
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listType) {
      out += `<${listType}>${list.map((item) => `<li>${item}</li>`).join('')}</${listType}>`;
      listType = null;
      list = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && isTableSep(next)) {
      flushParagraph();
      flushList();
      const head = splitRow(line);
      const aligns = alignsOf(next);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const current = lines[j] ?? '';
        if (!current.includes('|') || /^\s*$/.test(current)) break;
        rows.push(splitRow(current));
        j += 1;
      }
      out += tableHtml(head, aligns, rows);
      i = j - 1;
      continue;
    }
    const heading = /^(#{1,5})\s+(.*)$/.exec(line);
    const unordered = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    const rule = /^\s*([-*_])\1{2,}\s*$/.test(line);
    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }
    if (rule) {
      flushParagraph();
      flushList();
      out += '<hr>';
      continue;
    }
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min((heading[1] ?? '#').length + 2, 5);
      out += `<h${level}>${inline(heading[2] ?? '')}</h${level}>`;
      continue;
    }
    if (unordered) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        listType = 'ul';
      }
      list.push(inline(unordered[1] ?? ''));
      continue;
    }
    if (ordered) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        listType = 'ol';
      }
      list.push(inline(ordered[1] ?? ''));
      continue;
    }
    if (quote) {
      flushParagraph();
      flushList();
      out += `<blockquote>${inline(quote[1] ?? '')}</blockquote>`;
      continue;
    }
    flushList();
    paragraph.push(inline(line));
  }
  flushParagraph();
  flushList();
  return out;
};

/** Convierte el markdown del agente en HTML seguro para `dangerouslySetInnerHTML`. */
export const renderMarkdown = (text: string | null | undefined): string => {
  const parts = String(text ?? '').split('```');
  let html = '';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (i % 2 === 1) {
      const head = /^([a-zA-Z0-9+#_.-]*)[ \t]*\r?\n/.exec(part);
      const lang = head ? (head[1] ?? '').toLowerCase() : '';
      const body = part.replace(/^[a-zA-Z0-9+#_.-]*[ \t]*\r?\n/, '').replace(/\r?\n$/, '');
      const cls = lang ? 'code-wrap lang' : 'code-wrap';
      const attr = lang ? ` data-lang="${esc(lang)}"` : '';
      html += `<div class="${cls}"${attr}><button class="copy-code" type="button">Copiar</button><pre><code>${esc(body)}</code></pre></div>`;
    } else {
      const joinedDownloads = part.replace(
        /\[([^\]\r\n]+)\]\s*\r?\n\s*\((\/dl\/[A-Za-z0-9._-]{1,120})\)/g,
        '[$1]($2)',
      );
      html += mdBlocks(joinedDownloads);
    }
  }
  return html;
};
