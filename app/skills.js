/* Panel de Skills de goose-web (2026-10-14).
   Por que existe: la web no tenia ninguna forma de ver o editar skills; solo el app de
   escritorio podia. Usa la API de sources del serve (misma que usa esa UI) a traves del
   rpc que app.js ya expone en window.__gooseWeb. No toca app.js ni app.css. */
(function () {
  'use strict';
  var W = window.__gooseWeb;
  if (!W || !W.rpc) { console.warn('skills: falta window.__gooseWeb.rpc'); return; }
  var rpc = W.rpc;
  var M_LIST = '_goose/unstable/sources/list';
  var M_CREATE = '_goose/unstable/sources/create';
  var M_UPDATE = '_goose/unstable/sources/update';
  var M_DELETE = '_goose/unstable/sources/delete';
  var TYPE = 'skill';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  var CSS = [
    '#sk-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:none;align-items:center;justify-content:center}',
    '#sk-overlay[data-open="1"]{display:flex}',
    '#sk-box{width:min(920px,92vw);max-height:86vh;overflow:auto;background:var(--bg-2,#1b1b1b);color:var(--text-1,#eee);border:1px solid var(--line,#3a3a3a);border-radius:12px;padding:16px;font:14px/1.45 system-ui,sans-serif}',
    '#sk-box h3{margin:0 0 10px;font-size:16px}',
    '#sk-status{min-height:18px;font-size:12px;opacity:.85;margin:6px 0;white-space:pre-wrap}',
    '#sk-list{display:grid;gap:6px;margin:8px 0 14px}',
    '.sk-item{border:1px solid var(--line,#3a3a3a);border-radius:8px;padding:8px 10px;display:flex;gap:10px;align-items:center}',
    '.sk-item .n{font-weight:600}',
    '.sk-item .d{opacity:.7;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sk-tag{font-size:10px;opacity:.7;border:1px solid var(--line,#3a3a3a);border-radius:6px;padding:1px 5px}',
    '.sk-btn{background:transparent;color:inherit;border:1px solid var(--line,#3a3a3a);border-radius:8px;padding:5px 9px;cursor:pointer;font-size:12px}',
    '.sk-btn:hover{border-color:var(--text-3,#888)}',
    '.sk-btn[disabled]{opacity:.4;cursor:not-allowed}',
    '#sk-editor{display:grid;gap:8px;border-top:1px solid var(--line,#3a3a3a);padding-top:12px}',
    '#sk-editor input,#sk-editor textarea{width:100%;background:var(--bg-1,#111);color:inherit;border:1px solid var(--line,#3a3a3a);border-radius:8px;padding:7px 9px;font:inherit}',
    '#sk-editor textarea{min-height:240px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}',
    '#sk-editor label{font-size:11px;opacity:.75}',
    '#sk-actions{display:flex;gap:8px;flex-wrap:wrap}',
    '#sk-new{background:transparent;color:inherit;border:1px solid var(--line,#3a3a3a);border-radius:8px;padding:5px 9px;cursor:pointer;font-size:12px;margin-left:auto}',
    '.sk-head{display:flex;align-items:center;gap:8px}',
    '.sk-path{font-size:11px;opacity:.55;font-family:ui-monospace,Consolas,monospace}',
  ].join('');

  var el = null;
  function build() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    var d = document.createElement('div');
    d.id = 'sk-overlay';
    d.innerHTML = [
      '<div id="sk-box">',
      '  <div class="sk-head"><h3>Skills</h3><button id="sk-new" class="sk-btn">Nuevo</button></div>',
      '  <div id="sk-status"></div>',
      '  <div id="sk-list"></div>',
      '  <div id="sk-editor"></div>',
      '</div>',
    ].join('');
    document.body.appendChild(d);
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    d.querySelector('#sk-new').onclick = function () { editor(null); };
    el = d;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && d.dataset.open === '1') close(); });
    return d;
  }
  function node() { return el || build(); }
  function open() { var d = node(); d.dataset.open = '1'; load(); }
  function close() { if (el) el.dataset.open = '0'; }
  function status(msg, bad) {
    var s = node().querySelector('#sk-status');
    s.textContent = msg || '';
    s.style.color = bad ? 'var(--danger,#e5484d)' : '';
  }

  function load() {
    status('cargando...');
    rpc.request(M_LIST, { type: TYPE, includeProjectSources: true }).then(function (res) {
      var list = (res && res.sources) || [];
      list.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      var html = list.map(function (s, i) {
        return '<div class="sk-item">' +
          '<span class="n">' + esc(s.name) + '</span>' +
          '<span class="sk-tag">' + (s.writable ? (s.global ? 'global' : 'proyecto') : 'solo lectura') + '</span>' +
          '<span class="d">' + esc(s.description) + '</span>' +
          '<button class="sk-btn" data-edit="' + i + '">Editar</button>' +
          '</div>';
      }).join('');
      var box = node().querySelector('#sk-list');
      box.innerHTML = html;
      box.querySelectorAll('[data-edit]').forEach(function (b) {
        b.onclick = function () { editor(list[Number(b.dataset.edit)]); };
      });
      status(list.length + ' skills (global + proyecto + plugins).');
    }).catch(function (e) { status('no se pudo listar: ' + ((e && e.message) || e), true); });
  }

  function editor(s) {
    var isNew = !s;
    var w = node();
    w.querySelector('#sk-editor').innerHTML = [
      '<label>nombre (kebab-case, <=64, [a-z0-9-])</label>',
      '<input id="sk-name" value="' + esc(isNew ? '' : s.name) + '">',
      '<label>description (es lo unico que el modelo lee para decidir si carga la skill)</label>',
      '<input id="sk-desc" value="' + esc(isNew ? '' : s.description) + '">',
      '<label>contenido (cuerpo markdown, sin frontmatter' + (isNew ? '; el frontmatter lo arma el server' : '') + ')</label>',
      '<textarea id="sk-body">' + esc(isNew ? '' : (s.content || '')) + '</textarea>',
      (isNew ? '' : '<div class="sk-path">' + esc(s.path) + '</div>'),
      '<div id="sk-actions">',
      '  <button id="sk-save" class="sk-btn">Guardar</button>',
      '  <button id="sk-cancel" class="sk-btn">Cerrar editor</button>',
      (isNew || !s.writable ? '' : '<button id="sk-del" class="sk-btn">Borrar</button>'),
      '</div>',
    ].join('');
    w.querySelector('#sk-cancel').onclick = function () { w.querySelector('#sk-editor').innerHTML = ''; status(''); };
    w.querySelector('#sk-save').onclick = function () {
      var name = w.querySelector('#sk-name').value.trim();
      var desc = w.querySelector('#sk-desc').value.trim();
      var body = w.querySelector('#sk-body').value;
      if (!name || !desc) { status('nombre y description son obligatorios', true); return; }
      var p;
      if (isNew) p = rpc.request(M_CREATE, { type: TYPE, name: name, description: desc, content: body, target: { scope: 'global' } });
      else p = rpc.request(M_UPDATE, { type: TYPE, path: s.path, name: name, description: desc, content: body });
      status('guardando...');
      p.then(function () { status('guardado: ' + name); w.querySelector('#sk-editor').innerHTML = ''; load(); })
       .catch(function (e) { status('error al guardar: ' + ((e && e.message) || e), true); });
    };
    var del = w.querySelector('#sk-del');
    if (del) del.onclick = function () {
      if (!window.confirm('Borrar la skill ' + s.name + '? Se borra el directorio en disco.')) return;
      status('borrando...');
      rpc.request(M_DELETE, { type: TYPE, path: s.path }).then(function () {
        status('borrada: ' + s.name); w.querySelector('#sk-editor').innerHTML = ''; load();
      }).catch(function (e) { status('error al borrar: ' + ((e && e.message) || e), true); });
    };
  }

  function button() {
    var ref = document.getElementById('btn-new');
    if (!ref || document.getElementById('btn-skills')) return;
    var b = document.createElement('button');
    b.id = 'btn-skills';
    b.className = ref.className;
    b.textContent = 'Skills';
    b.style.marginLeft = '8px';
    b.onclick = open;
    ref.insertAdjacentElement('afterend', b);
  }
  button();
  window.__gooseSkills = { open: open, close: close, load: load };
})();
