# Restaura newSession (se perdio en el slice de resetTransient del parche v6).
import io, sys

P = r'C:\goose-web\app\app.js'
t = io.open(P, encoding='utf-8').read()
if 'async function newSession' in t:
    sys.exit('newSession ya existe: no toco nada')

NEW = """  async function newSession() {
    if (!rpc.ready) { systemNote('Sin conexi\u00f3n con el backend - reintentando.'); return; }
    try {
      const res = await rpc.request('session/new', { cwd: CFG.cwd || undefined, mcpServers: [] });
      state.current = { id: res.sessionId, title: 'Nuevo chat', cwd: CFG.cwd, configOptions: res.configOptions || [], modes: res.modes || {} };
      resetTransient();
      clearMessages();
      showWelcome('new');
      updateTitle(); renderChips(); markActive(res.sessionId);
      localStorage.setItem('gweb.last', res.sessionId);
      closeDrawer();
      $('#input').focus();
      refreshSessions();
    } catch (e) {
      systemNote('No se pudo crear la sesi\u00f3n: ' + e.message);
    }
  }

"""
anchor = """    runBarHide();
  }

  // Carga una sesi"""
if t.count(anchor) != 1:
    sys.exit('ancla no unica: %d' % t.count(anchor))
t = t.replace(anchor, """    runBarHide();
  }

""" + NEW + "  // Carga una sesi", 1)
io.open(P, 'w', encoding='utf-8', newline='').write(t)
print('newSession restaurado; bytes:', len(t))
