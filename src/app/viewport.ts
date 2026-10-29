// Geometría del área útil del teléfono.
//
// Por qué existe este módulo: en Android hay TRES comportamientos distintos para el teclado
// en pantalla y el navegador elige uno solo, sin decirlo:
//
//   1. resize-visual-only (el default histórico de Chrome): el teclado se dibuja ENCIMA del
//      layout viewport. `visualViewport.height` baja, `documentElement.clientHeight` NO cambia.
//   2. resizes-content (`interactive-widget=resizes-content` en el meta viewport): el layout se
//      achica de verdad. Las dos medidas bajan juntas.
//   3. ninguna de las dos: el navegador no reporta nada (pasa en algunos builds de Brave y en
//      WebView viejos con edge-to-edge). Ahí solo queda el fallback de re-anclaje por foco.
//
// Un fix que use una sola fuente se rompe en los otros dos modos: por eso la versión anterior
// (solo `visualViewport.height`) no arreglaba nada en el teléfono real aunque el test de
// Playwright diera verde — Playwright achica el viewport de layout, o sea simula el modo 2,
// que no es el modo en el que falla.
//
// La regla que cubre los modos 1, 2 y 3-por-la-negativa: el alto útil es el MENOR de todas las
// medidas que el navegador expone. Si cualquiera de ellas ve el teclado, la UI se acomoda.
// El mínimo nunca agranda la pantalla: en el peor caso deja el layout como estaba.

/** Un alto menor a esto no es una pantalla: es una medición rota (0, NaN, dvh sin resolver). */
export const ALTO_MINIMO_PLAUSIBLE = 200;

export type AreaUtil = {
  /** Alto visible real, en px CSS. */
  alto: number;
  /** Desplazamiento del viewport visual respecto del layout (el navegador panea al enfocar). */
  top: number;
  /** Alto del teclado en pantalla, 0 si no se puede medir. Solo diagnóstico. */
  teclado: number;
  /** Qué fuente decidió el alto: sirve para saber en el teléfono cuál modo está activo. */
  fuente: 'visual' | 'layout' | 'virtualKeyboard' | 'previo' | 'fallback';
};

type VirtualKeyboardLike = { boundingRect?: { height?: number } };

export function medirAreaUtil(previo = 0): AreaUtil {
  const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
  const raiz = typeof document !== 'undefined' ? document.documentElement : null;
  const layout = Math.max(0, raiz?.clientHeight || window.innerHeight || 0);

  // Altura del teclado: `navigator.virtualKeyboard` la informa aunque el layout no se achique
  // (modo 3 con Chrome nuevo). Es opcional y puede no existir; no se usa como única fuente.
  const vk = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
  const tecladoBruto = Number(vk?.boundingRect?.height || 0);
  const teclado = tecladoBruto > 120 ? tecladoBruto : 0; // < 120 px = barra de sugerencias

  const candidatos: Array<{ alto: number; fuente: AreaUtil['fuente'] }> = [];
  if (vv && Number.isFinite(vv.height) && vv.height > 0) candidatos.push({ alto: vv.height, fuente: 'visual' });
  if (layout > 0) candidatos.push({ alto: layout, fuente: 'layout' });
  if (teclado > 0 && layout - teclado > ALTO_MINIMO_PLAUSIBLE) {
    candidatos.push({ alto: layout - teclado, fuente: 'virtualKeyboard' });
  }

  candidatos.sort((a, b) => a.alto - b.alto);
  const elegido = candidatos.find((c) => c.alto >= ALTO_MINIMO_PLAUSIBLE);
  if (!elegido) {
    if (previo >= ALTO_MINIMO_PLAUSIBLE) return { alto: previo, top: 0, teclado, fuente: 'previo' };
    const caido = Math.max(ALTO_MINIMO_PLAUSIBLE, layout || vv?.height || 320);
    return { alto: caido, top: 0, teclado, fuente: 'fallback' };
  }

  // El paneo del viewport visual solo tiene sentido si NO se achicó el layout: cuando el
  // layout se achica, Chrome deja offsetTop en 0 y la UI ya está en el lugar.
  const crudo = Number(vv?.offsetTop || 0);
  const top = Math.max(0, Math.min(crudo, Math.max(0, layout - elegido.alto)));
  return { alto: elegido.alto, top, teclado, fuente: elegido.fuente };
}
