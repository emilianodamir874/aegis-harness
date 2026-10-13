import io
P='C:/goose-web/app/app.js'
with io.open(P,'r',encoding='utf-8',newline='') as f: raw=f.read()
pairs = [
  ('<h4>Ultimo paso</h4>', '<h4>Último paso</h4>'),
  ('<h4>Acumulado en la sesion</h4>', '<h4>Acumulado en la sesión</h4>'),
  ("'Todavia no hay un request medido en esta sesion.'", "'Todavía no hay un request medido en esta sesión.'"),
  ("'En la zona de compactacion: el proximo request puede resumir el historial.'", "'En la zona de compactación: el próximo request puede resumir el historial.'"),
  ("'Mas de medio contexto usado; queda aire pero conviene mirarlo.'", "'Más de medio contexto usado; queda aire pero conviene mirarlo.'"),
  ("'toda la sesion'", "'toda la sesión'"),
  ('por eso la salida pesa mas de lo que se ve en el chat.', 'por eso la salida pesa más de lo que se ve en el chat.'),
  ('Al ritmo del ultimo paso quedan', 'Al ritmo del último paso quedan'),
]
n = 0
for a,b in pairs:
    c = raw.count(a)
    if c == 0:
        print('AVISO: no encontrado -> %r' % a[:50]); continue
    raw = raw.replace(a,b); n += c
with io.open(P,'w',encoding='utf-8',newline='') as f: f.write(raw)
print('OK %d reemplazos' % n)
