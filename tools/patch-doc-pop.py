import io, sys
P='C:/goose-web/docs/v6.3-serve-v3.md'
with io.open(P,'r',encoding='utf-8',newline='') as f: raw=f.read()
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
lines = raw.split(SEP)
i = [k for k,l in enumerate(lines) if l.startswith('- **Panel** (click o')]
if len(i) != 1:
    print('AVISO: no encontre el bullet del panel'); sys.exit(1)
i = i[0]
j = i
while j+1 < len(lines) and lines[j+1].startswith('  '):
    j += 1
new = [
"- **Popover** (click en el readout, '#usage-pop'): **306x225**, anclado **arriba** del readout y",
"  alineado a la derecha; si no entra arriba cae abajo; se reacomoda en resize/scroll; cierra con",
"  Esc, click afuera o volviendo a tocar. Contenido compacto: % + veredicto (holgado / mas de la",
"  mitad / va a compactar), barra de contexto con **marca del 80%** (se anima al abrir),",
"  'usado de limite' + 'compacta a X (80%)', ultimo paso (entrada/salida/tiempo), cache + 1er",
"  token, acumulado de la sesion, margen antes de compactar, y pie con 'modelo - esfuerzo - costo'.",
"  (Antes esto abria un modal centrado a pantalla completa: se cambio a popover anclado.)",
]
lines[i:j+1] = new
with io.open(P,'w',encoding='utf-8',newline='') as f: f.write(SEP.join(lines))
print('OK doc popover')
