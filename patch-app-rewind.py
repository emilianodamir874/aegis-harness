"""Rewind en la app web: boton por mensaje + cola oculta atenuada.

Patches con conteo exacto y deteccion de finales de linea (app.js/app.css son LF,
el server.mjs CRLF). Falla ruidosamente si un ancla no matchea.
"""

import pathlib
import sys

ROOT = pathlib.Path(r"C:\goose-web")
applied = 0

HELPERS = r"""  // ---- rebobinar a un mensaje anterior -------------------------------------
  // El modelo deja de ver desde ese mensaje en adelante (nada se borra: el
  // transcript queda entero, atenuado) y el texto vuelve al composer para
  // editarlo y reenviarlo. Mismo mecanismo que el /rewind del CLI.
  const aegisMeta = (u) => ((u && u._meta && u._meta.aegis) || {});

  // Atenua la cola que el modelo dejo de ver. Las filas marcadas por el server
  // (`agentVisible: false`) delimitan la region; lo que quedo en el medio sin
  // marca propia (tarjetas de herramientas) se atenua con ellas. Lo que llegue
  // DESPUES del ultimo mensaje marcado ya es conversacion nueva: no se toca.
  function markHiddenTail() {
    const inner = $('#msg-inner');
    if (!inner) return;
    for (const m of inner.querySelectorAll('.rw-marker')) m.remove();
    const kids = [...inner.children];
    const first = kids.findIndex((k) => k.classList.contains('hidden-from-agent'));
    if (first < 0) {
      for (const k of kids) k.classList.remove('hidden-tail', 'rw-boundary');
      return;
    }
    let last = first;
    for (let i = kids.length - 1; i >= first; i--) {
      if (kids[i].classList.contains('hidden-from-agent')) { last = i; break; }
    }
    kids.forEach((k, i) => {
      k.classList.toggle('hidden-tail', i >= first && i <= last);
      k.classList.toggle('rw-boundary', i === first);
    });
    const marker = document.createElement('div');
    marker.className = 'rw-marker';
    marker.textContent = 'El modelo no ve desde aca';
    inner.insertBefore(marker, kids[first]);
  }

  function askRewind(el) {
    if (!el || el.querySelector('.rw-confirm')) return;
    if (state.busy) { toast('Espera a que termine el turno para rebobinar.', 'err'); return; }
    const c = document.createElement('div');
    c.className = 'rw-confirm';
    c.innerHTML = '<span>Rebobinar aca?</span><button class="ym" type="button">Si</button><button class="nn" type="button">No</button>';
    el.appendChild(c);
    c.querySelector('.nn').addEventListener('click', (e) => { e.stopPropagation(); c.remove(); });
    c.querySelector('.ym').addEventListener('click', async (e) => { e.stopPropagation(); c.remove(); await rewindTo(el); });
  }

  async function rewindTo(el) {
    const mid = el && el.dataset.mid;
    const cur = state.current;
    if (!mid || !cur) return;
    try {
      const res = await rpc.request('_aegis/unstable/session/rewind', { sessionId: cur.id, messageId: mid });
      // Todo lo que esta pintado desde esta burbuja ya no lo ve el modelo; lo que
      // llegue despues si, asi que se marca solo lo que hay en pantalla ahora.
      const inner = $('#msg-inner');
      if (inner) {
        let seen = false;
        for (const k of inner.children) {
          if (k === el) seen = true;
          if (seen) k.classList.add('hidden-from-agent');
        }
      }
      markHiddenTail();
      if (res && res.text) { input.value = res.text; autosize(); refreshSlashMenu(); input.focus(); }
      systemNote('Rebobinado: el modelo ya no ve ' + ((res && res.hidden) || 0) + ' mensaje(s) desde aca. El texto quedo en el composer para editarlo.');
    } catch (err) {
      toast('No se pudo rebobinar: ' + ((err && err.message) || err), 'err');
    }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.rewind-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    askRewind(btn.closest('.msg-user'));
  });

"""


def patch(rel, before, after, count=1):
    global applied
    path = ROOT / rel
    data = path.read_text(encoding="utf-8", newline="")
    crlf = data.count("\r\n")
    lf = data.count("\n") - crlf
    nl = "\r\n" if crlf > lf else "\n"
    needle = before.replace("\n", nl)
    replacement = after.replace("\n", nl)
    found = data.count(needle)
    if found == 0 and data.count(replacement) >= 1:
        print(f"skip {rel}: already applied")
        return
    if found != count:
        print(f"FAIL {rel}: expected {count} match(es), found {found}")
        sys.exit(1)
    path.write_text(data.replace(needle, replacement), encoding="utf-8", newline="")
    applied += 1
    print(f"ok   {rel}: {found} replacement(s)")


APP = r"app\app.js"

# 1. Chunks de usuario: propagar la marca de oculto y redibujar la cola.
patch(
    APP,
    """        if (u.content && u.content.type === 'text') addUser(u.content.text, true, null, { mid });
        else if (u.content && u.content.type === 'image') addUser('', true, [u.content], { mid });
        break;
""",
    """        const oculto = aegisMeta(u).agentVisible === false;
        if (u.content && u.content.type === 'text') addUser(u.content.text, true, null, { mid, hidden: oculto });
        else if (u.content && u.content.type === 'image') addUser('', true, [u.content], { mid, hidden: oculto });
        if (oculto) markHiddenTail();
        break;
""",
)

# 2. Chunks del agente (texto y razonamiento): misma marca.
patch(
    APP,
    """      case 'agent_message_chunk':
        if (u.content && u.content.type === 'text') streamAppend(u.messageId || 'a', u.content.text, false);
        break;
      case 'agent_thought_chunk':
        if (u.content && u.content.type === 'text') streamAppend(thoughtKeyFor(u), u.content.text, true);
        break;
""",
    """      case 'agent_message_chunk':
        if (u.content && u.content.type === 'text') streamAppend(u.messageId || 'a', u.content.text, false, aegisMeta(u).agentVisible === false);
        break;
      case 'agent_thought_chunk':
        if (u.content && u.content.type === 'text') streamAppend(thoughtKeyFor(u), u.content.text, true, aegisMeta(u).agentVisible === false);
        break;
""",
)

# 3. addUser: bufferea la marca, la pinta y agrega el boton.
patch(
    APP,
    """      SOFT.users.push({ text, atts, mid: (opts && opts.mid) || '' });
""",
    """      SOFT.users.push({ text, atts, mid: (opts && opts.mid) || '', hidden: !!(opts && opts.hidden) });
""",
)

patch(
    APP,
    """    el.className = 'msg-user' + (opts && opts.queued ? ' queued' : ''); if (!replay) el.classList.add('in');
""",
    """    el.className = 'msg-user' + (opts && opts.queued ? ' queued' : '') + (opts && opts.hidden ? ' hidden-from-agent' : '');
    if (!replay) el.classList.add('in');
""",
)

patch(
    APP,
    """    el.innerHTML = html;
    msgWrap().appendChild(el);
""",
    """    el.innerHTML = html;
    if (opts && opts.mid && !opts.queued) {
      const rw = document.createElement('button');
      rw.type = 'button';
      rw.className = 'rewind-btn';
      rw.title = 'Rebobinar a este mensaje (el modelo deja de ver de aca en adelante)';
      rw.setAttribute('aria-label', 'Rebobinar a este mensaje');
      rw.textContent = '\\u21ba';
      el.appendChild(rw);
    }
    msgWrap().appendChild(el);
""",
)

# 4. Helpers nuevos, antes de setQueuedNote.
patch(APP, """  const setQueuedNote = (el, msg) => {""", HELPERS + """  const setQueuedNote = (el, msg) => {""")

# 5. streamAppend acepta la marca.
patch(APP, """  function streamAppend(key, text, thought) {""", """  function streamAppend(key, text, thought, hidden) {""")
patch(
    APP,
    """      const el = document.createElement('div');
      el.className = 'msg-a';
""",
    """      const el = document.createElement('div');
      el.className = 'msg-a' + (hidden ? ' hidden-from-agent' : '');
""",
)

# 6. Refresco suave: pasar la marca y redibujar la cola al final.
patch(
    APP,
    """        addUser(usr.text, true, usr.atts, { mid: usr.mid });
""",
    """        addUser(usr.text, true, usr.atts, { mid: usr.mid, hidden: usr.hidden });
""",
)

patch(
    APP,
    """        res.user++;
      }
    }
    return res;
  }
""",
    """        res.user++;
      }
    }
    markHiddenTail();
    return res;
  }
""",
)

# 7. Replay en dos fases: marcar la cola al terminar (tambien si hubo excepcion).
patch(
    APP,
    """    } finally {
      state.offscreen = null;
      state.replaying = false;
      flushRender();
    }
  }
""",
    """    } finally {
      state.offscreen = null;
      state.replaying = false;
      flushRender();
      markHiddenTail();
    }
  }
""",
)

# 8. CSS.
CSS = r"""
/* ---- rebobinar a un mensaje anterior ------------------------------------- */
.msg-user { position: relative; }
.rewind-btn {
  position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: 7px; background: transparent; color: var(--text-4);
  font-size: 14px; line-height: 1; opacity: 0; cursor: pointer; transition: opacity .15s;
}
.msg-user:hover .rewind-btn, .msg-user:focus-within .rewind-btn { opacity: .85; }
@media (hover: none) { .rewind-btn { opacity: .5; } }
.rw-confirm {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 8px; font-size: 12px; color: var(--text-3);
}
.rw-confirm button {
  border: 1px solid var(--line-2); background: transparent; color: var(--text-2);
  border-radius: 7px; padding: 3px 10px; font-size: 12px; cursor: pointer;
}
.rw-confirm .ym { border-color: var(--accent); color: var(--accent); }
.hidden-tail { opacity: .45; }
.rw-marker {
  margin: 12px 0 4px; font-size: 11px; letter-spacing: .03em;
  color: var(--text-4); text-align: center; text-transform: uppercase;
}
"""
css_path = ROOT / "app" / "app.css"
css = css_path.read_text(encoding="utf-8", newline="")
if ".rw-marker" not in css:
    css_path.write_text(css.rstrip("\r\n") + "\n" + CSS, encoding="utf-8", newline="")
    applied += 1
    print("ok   app\\app.css: appended")
else:
    print("skip app\\app.css: already applied")

print(f"applied {applied} patch(es)")
