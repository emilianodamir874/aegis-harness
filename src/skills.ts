interface SkillSource {
  name: string;
  description: string;
  content?: string;
  path: string;
  writable: boolean;
  global: boolean;
}

interface Window {
  __aegisWeb?: {
    rpc?: {
      request<T = void>(method: string, params: Record<string, unknown>): Promise<T>;
    };
  };
  __aegisSkills?: { open: () => void; close: () => void; load: () => void };
}

/* Panel de Skills de aegis-web.
   Por que existe: la web no tenia ninguna forma de ver o editar skills; solo el app de
   escritorio podia. Usa la API de sources del serve (misma que usa esa UI) a traves del
   rpc que app.js ya expone en window.__aegisWeb.

   v4 (2026-10-22): el panel era una lista de una linea con descripciones cortadas, sin
   buscador, sin boton de cerrar y sin semantica de dialogo, con un look propio que no
   compartia tokens con la app. Ahora usa el chrome compartido (.xpanel*) definido en
   app.css, tiene buscador, estado vacio/error, foco atrapado y un editor en dos pasos.
   Las filas se arman con DOM (no innerHTML) porque el contenido viene del disco. */
(function () {
  'use strict';
  var W = window.__aegisWeb;
  if (!W || !W.rpc) { console.warn('skills: falta window.__aegisWeb.rpc'); return; }
  var rpc = W.rpc;
  var M_LIST = '_aegis/unstable/sources/list';
  var M_CREATE = '_aegis/unstable/sources/create';
  var M_UPDATE = '_aegis/unstable/sources/update';
  var M_DELETE = '_aegis/unstable/sources/delete';
  var TYPE = 'skill';

  var all: SkillSource[] = [];
  var filtro = '';
  var el: HTMLDivElement | null = null;
  var lastFocus: HTMLElement | null = null;
  var editando: SkillSource | null = null;
  var guardando = false;

  function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    var d = h('div', 'xpanel-overlay');
    d.id = 'sk-overlay';
    d.dataset.open = '0';
    d.innerHTML = [
      '<div id="sk-box" class="xpanel sk-box" role="dialog" aria-modal="true" aria-labelledby="sk-title">',
      '  <header class="xpanel-head">',
      '    <h2 id="sk-title">Skills</h2>',
      '    <span id="sk-count" class="xpanel-count" hidden></span>',
      '    <input id="sk-q" class="xpanel-search" type="search" placeholder="Buscar skill…" aria-label="Buscar skill" autocomplete="off" spellcheck="false">',
      '    <button id="sk-new" class="xbtn" type="button">Nueva</button>',
      '    <button id="sk-close" class="xpanel-close" type="button" aria-label="Cerrar panel de skills" title="Cerrar (Esc)">✕</button>',
      '  </header>',
      '  <div id="sk-status" class="xpanel-status" role="status" aria-live="polite"></div>',
      '  <div id="sk-main" class="sk-main">',
      '    <div id="sk-list" class="sk-list" role="list"></div>',
      '  </div>',
      '  <form id="sk-editor" class="sk-editor" hidden novalidate>',
      '    <div class="sk-ed-head">',
      '      <button id="sk-back" class="xbtn" type="button">← Volver</button>',
      '      <span id="sk-ed-title" class="sk-ed-title">Editar skill</span>',
      '    </div>',
      '    <label class="xfield"><span class="xlabel">Nombre</span>',
      '      <input id="sk-name" class="xinput" autocomplete="off" spellcheck="false" placeholder="kebab-case, hasta 64 caracteres">',
      '      <span class="xhint">Solo [a-z0-9-]. Es el identificador que usa el modelo.</span></label>',
      '    <label class="xfield"><span class="xlabel">Descripción</span>',
      '      <input id="sk-desc" class="xinput" autocomplete="off" placeholder="Cuándo tiene que cargarse esta skill">',
      '      <span class="xhint">Es lo único que el modelo lee para decidir si la carga.</span></label>',
      '    <label class="xfield"><span class="xlabel">Contenido</span>',
      '      <textarea id="sk-body" class="xinput sk-body" spellcheck="false"></textarea>',
      '      <span class="xhint" id="sk-body-hint">Cuerpo markdown, sin frontmatter.</span></label>',
      '    <div id="sk-path" class="sk-path"></div>',
      '    <div class="sk-actions">',
      '      <button id="sk-save" class="xbtn xbtn-primary" type="submit">Guardar</button>',
      '      <button id="sk-cancel" class="xbtn" type="button">Cancelar</button>',
      '      <button id="sk-del" class="xbtn xbtn-danger" type="button" hidden>Borrar skill</button>',
      '    </div>',
      '  </form>',
      '</div>',
    ].join('');
    document.body.appendChild(d);

    d.addEventListener('mousedown', function (e) { if (e.target === d) close(); });
    q('#sk-close', d).addEventListener('click', close);
    q('#sk-new', d).addEventListener('click', function () { editor(null); });
    q('#sk-back', d).addEventListener('click', backToList);
    q('#sk-cancel', d).addEventListener('click', backToList);
    q('#sk-del', d).addEventListener('click', borrar);
    q('#sk-editor', d).addEventListener('submit', function (e) { e.preventDefault(); guardar(); });
    var search = q('#sk-q', d) as HTMLInputElement;
    search.addEventListener('input', function () { filtro = search.value; render(); });

    // Foco atrapado dentro del dialogo + Esc (primero cierra el editor, despues el panel).
    d.addEventListener('keydown', function (e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!(q('#sk-editor', d) as HTMLElement).hidden) backToList();
        else close();
        return;
      }
      if (e.key !== 'Tab') return;
      var focusables = [...d.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(function (n) { return !n.hidden && n.offsetParent !== null && !(n as HTMLButtonElement).disabled; });
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    });

    el = d;
    return d;
  }

  function q(sel: string, root?: HTMLElement): HTMLElement {
    return (root || node()).querySelector(sel) as HTMLElement;
  }
  function node(): HTMLDivElement { return el || build(); }
  // El server devuelve rutas con el prefijo extendido de Windows (\\?\C:\...):
  // se muestra la ruta real, sin ese prefijo.
  function rutaVisible(p: string): string {
    return String(p == null ? '' : p).replace(/^\\\\\?\\/, '');
  }

  function open() {
    var d = node();
    if (d.dataset.open === '1') return;
    lastFocus = document.activeElement as HTMLElement;
    d.dataset.open = '1';
    backToList();
    status('');
    var b = document.getElementById('btn-skills');
    if (b) b.setAttribute('aria-expanded', 'true');
    load();
    setTimeout(function () { (q('#sk-q') as HTMLInputElement).focus(); }, 30);
  }
  function close() {
    if (!el) return;
    el.dataset.open = '0';
    var b = document.getElementById('btn-skills');
    if (b) b.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
    lastFocus = null;
  }

  function status(msg: string, bad?: boolean) {
    var s = q('#sk-status');
    s.textContent = msg || '';
    s.className = 'xpanel-status' + (bad ? ' bad' : '');
    s.hidden = !msg;
  }

  function contarTag(s: SkillSource): string {
    return s.writable ? (s.global ? 'global' : 'proyecto') : 'solo lectura';
  }

  function load() {
    status('Cargando skills…');
    rpc.request<{ sources: SkillSource[] }>(M_LIST, { type: TYPE, includeProjectSources: true }).then(function (res) {
      all = ((res && res.sources) || []).slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      render();
      status(all.length ? all.length + ' skills · global, proyecto y plugins' : '');
      var badge = document.getElementById('skills-count');
      if (badge) { badge.textContent = String(all.length); badge.hidden = !all.length; }
      var btn = document.getElementById('btn-skills');
      if (btn && all.length) btn.title = all.length + ' skills instaladas';
    }).catch(function (e) {
      all = [];
      render();
      status('No se pudieron listar las skills: ' + ((e && e.message) || e), true);
    });
  }

  function coincide(s: SkillSource): boolean {
    if (!filtro.trim()) return true;
    var q2 = filtro.trim().toLowerCase();
    return (s.name + ' ' + (s.description || '')).toLowerCase().indexOf(q2) !== -1;
  }

  function render() {
    var list = q('#sk-list');
    var count = q('#sk-count');
    var visibles = all.filter(coincide);
    if (count) {
      count.hidden = !all.length;
      count.textContent = filtro.trim() ? visibles.length + ' de ' + all.length : String(all.length);
    }
    list.textContent = '';
    if (!all.length) {
      var vacio = h('div', 'sk-empty');
      vacio.append(h('div', 'sk-empty-t', filtro.trim() ? 'Sin coincidencias' : 'Todavía no hay skills'));
      vacio.append(h('div', 'sk-empty-s', filtro.trim()
        ? 'Probá con otro término o creá una skill nueva.'
        : 'Las skills son archivos en la carpeta de configuración. Creá la primera con «Nueva».'));
      list.append(vacio);
      return;
    }
    if (!visibles.length) {
      list.append(h('div', 'sk-empty', 'Ninguna skill coincide con «' + filtro.trim() + '».'));
      return;
    }
    for (var i = 0; i < visibles.length; i++) list.append(fila(visibles[i]));
  }

  function fila(s: SkillSource): HTMLElement {
    var row = h('div', 'sk-row');
    row.setAttribute('role', 'listitem');
    var btn = h('button', 'sk-open');
    btn.type = 'button';
    btn.title = s.path;
    var head = h('span', 'sk-head');
    head.append(h('span', 'sk-name', s.name));
    head.append(h('span', 'sk-tag' + (s.writable ? '' : ' ro'), contarTag(s)));
    btn.append(head);
    if (s.description) btn.append(h('span', 'sk-desc', s.description));
    btn.addEventListener('click', function () { editor(s); });
    row.append(btn);
    return row;
  }

  function backToList() {
    editando = null;
    var d = node();
    d.classList.remove('sk-editing');
    (q('#sk-editor') as HTMLElement).hidden = true;
    (q('#sk-main') as HTMLElement).hidden = false;
    status('');
    (q('#sk-q') as HTMLInputElement).focus();
  }

  function editor(s: SkillSource | null) {
    var d = node();
    var isNew = !s;
    editando = s;
    d.classList.add('sk-editing');
    (q('#sk-main') as HTMLElement).hidden = true;
    (q('#sk-editor') as HTMLElement).hidden = false;
    (q('#sk-name') as HTMLInputElement).value = isNew ? '' : s!.name;
    (q('#sk-desc') as HTMLInputElement).value = isNew ? '' : s!.description;
    (q('#sk-body') as HTMLTextAreaElement).value = isNew ? '' : (s!.content || '');
    (q('#sk-ed-title') as HTMLElement).textContent = isNew ? 'Nueva skill' : 'Editar ' + s!.name;
    (q('#sk-path') as HTMLElement).textContent = isNew ? 'Se guarda en la carpeta global de skills.' : rutaVisible(s!.path);
    (q('#sk-body-hint') as HTMLElement).textContent = isNew
      ? 'Cuerpo markdown, sin frontmatter: lo arma el servidor.'
      : 'Cuerpo markdown, sin frontmatter.';
    var del = q('#sk-del') as HTMLButtonElement;
    del.hidden = isNew || !s!.writable;
    (q('#sk-save') as HTMLButtonElement).disabled = false;
    status('');
    (q('#sk-name') as HTMLInputElement).focus();
  }

  function guardar() {
    if (guardando) return;
    var name = (q('#sk-name') as HTMLInputElement).value.trim();
    var desc = (q('#sk-desc') as HTMLInputElement).value.trim();
    var body = (q('#sk-body') as HTMLTextAreaElement).value;
    if (!name || !desc) {
      status('El nombre y la descripción son obligatorios.', true);
      (!name ? q('#sk-name') : q('#sk-desc')).focus();
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      status('Nombre inválido: kebab-case, minúsculas, hasta 64 caracteres ([a-z0-9-]).', true);
      (q('#sk-name') as HTMLInputElement).focus();
      return;
    }
    var isNew = !editando;
    var p = isNew
      ? rpc.request(M_CREATE, { type: TYPE, name: name, description: desc, content: body, target: { scope: 'global' } })
      : rpc.request(M_UPDATE, { type: TYPE, path: editando!.path, name: name, description: desc, content: body });
    guardando = true;
    var save = q('#sk-save') as HTMLButtonElement;
    save.disabled = true;
    save.textContent = 'Guardando…';
    status('Guardando…');
    p.then(function () {
      guardando = false;
      save.disabled = false;
      save.textContent = 'Guardar';
      backToList();
      load();
      status('Guardado: ' + name);
    }).catch(function (e) {
      guardando = false;
      save.disabled = false;
      save.textContent = 'Guardar';
      status('No se pudo guardar: ' + ((e && e.message) || e), true);
    });
  }

  function borrar() {
    if (!editando || !editando.writable) return;
    var s = editando;
    if (!window.confirm('¿Borrar la skill «' + s.name + '»? Se borra el directorio en disco.')) return;
    status('Borrando…');
    rpc.request(M_DELETE, { type: TYPE, path: s.path }).then(function () {
      backToList();
      load();
      status('Borrada: ' + s.name);
    }).catch(function (e) {
      status('No se pudo borrar: ' + ((e && e.message) || e), true);
    });
  }

  function button() {
    // El boton vive en el HTML (barra lateral, seccion de herramientas). Si por
    // alguna razon no esta, se crea igual para no perder la unica entrada al panel.
    var b = document.getElementById('btn-skills') as HTMLButtonElement | null;
    if (!b) {
      var foot = document.querySelector('.sb-tools');
      if (!foot) return;
      b = document.createElement('button');
      b.id = 'btn-skills';
      b.className = 'sb-tool';
      b.type = 'button';
      b.textContent = 'Skills';
      foot.appendChild(b);
    }
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    b.onclick = open;
  }

  button();
  // El contador de la barra lateral se llena al arrancar (una sola llamada de
  // listado, barata) para que la entrada a Skills diga cuantas hay.
  window.addEventListener('load', function () { setTimeout(function () { if (!all.length) load(); }, 1200); });
  window.__aegisSkills = { open: open, close: close, load: load };
})();
