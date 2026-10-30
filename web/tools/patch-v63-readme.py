import io, sys
P = 'C:/goose-web/README.md'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
old = '**Bug de runtime del serve (2026-10-12, sin arreglar)**'
new = '**Bug de runtime del serve (2026-10-12, mitigado en serve v3)**'
if raw.count(old) != 1:
    print('FAIL pitfall count=%d' % raw.count(old)); sys.exit(1)
raw = raw.replace(old, new)

tail = '''

## v6.3 (backend: serve v3) - watchdog de runs + spill de imagenes

Detalle completo y procedimiento de swap: **docs/v6.3-serve-v3.md**. Resumen:

- **Watchdog de runs por fin**: cada evento del stream marca progreso; si un run pasa
  AEGIS_RUN_STALL_TIMEOUT_SECS (default 900 s, 0 desactiva) sin avanzar, el server emite un
  **error visible al cliente**, pone activeRunId=null y cancela el run. Antes ese caso dejaba la
  UI muda hasta recargar (sesion 20261012_23, 39 min muertos).
- **Cancelacion no pedida = aviso visible**: si un turno termina cancelado y no lo pidio el cliente
  (conexion caida, cancel interno), ahora se ve el motivo en vez de nada.
- **Imagenes de tools con tope**: AEGIS_MAX_TOOL_IMAGE_BASE64_SIZE (default 1.500.000 chars b64
  ~ 1,1 MB). Las imagenes grandes se escriben a archivo y queda un puntero, igual que el texto.
  Antes el cap solo miraba texto: la DB tenia 137 mensajes >60k chars / 54,6 MB de imagenes.
- **Cap de texto verificado**: AEGIS_MAX_TOOL_RESPONSE_SIZE se mide en CHARs (default 200.000;
  el usuario tiene 60.000) y si funciona (el texto de assistant topea en 78 KB).
- **Binario nuevo, no en uso**: aegis-serve-v3.exe. v2 sigue siendo el que corre hasta hacer el swap.
'''
with io.open(P, 'a', encoding='utf-8', newline='') as f:
    f.write(tail)
print('OK README')
