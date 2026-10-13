import io, sys
CRLF = chr(13) + chr(10)
P = 'C:/goose/crates/goose/src/acp/server.rs'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    src = f.read()
old = '''            let minutes = (stall.as_secs() / 60).max(1);
            let text = format!(
                "El turno se cerro automaticamente: {} minuto(s) sin ningun avance del proveedor. Se cancelo el run; las herramientas en curso quedaron sin resultado.",
                minutes
            );'''.replace(chr(10), CRLF)
new = '''            let seconds = stall.as_secs();
            let window = if seconds < 60 {
                format!("{} segundos", seconds)
            } else {
                format!("{} minuto(s)", seconds / 60)
            };
            let text = format!(
                "El turno se cerro automaticamente: {} sin ningun avance del proveedor. Se cancelo el run; las herramientas en curso quedaron sin resultado.",
                window
            );'''.replace(chr(10), CRLF)
if src.count(old) != 1:
    print('FAIL count=%d' % src.count(old)); sys.exit(1)
src = src.replace(old, new)
with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(src)
print('OK server.rs wording')
