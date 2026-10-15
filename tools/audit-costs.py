#!/usr/bin/env python3
"""Auditoria de costo y tokens de Goose, read-only (A3/A6 del relevamiento).

Uso: python audit-costs.py [--days 2] [--db <ruta>]

Atribuye tokens por (proveedor, modelo) leyendo metadata.inference de cada mensaje,
porque una sesion puede cambiar de modelo a mitad de camino: el modelo de la sesion no
sirve para atribuir su costo. Muestra ademas los tokens de compactacion interna (los
que se cobran sin dejar mensaje de assistant) y el residual no atribuible.
"""
import argparse, collections, datetime, io, json, sqlite3, sys

DEFAULT_DB = r'C:/Users/Emiliano/AppData/Roaming/Block/goose/data/sessions/sessions.db'
PRICES = r'C:/goose-web/prices.json'


def load_prices():
    """USD por 1M tokens, por provider/model, desde prices.json (opcional)."""
    try:
        data = json.load(io.open(PRICES, encoding='utf-8'))
    except Exception:
        return {}
    out = {}
    for k, v in data.items():
        if k.startswith('_') or not isinstance(v, dict):
            continue
        if v.get('inputEffective') is not None or (v.get('input') is not None and v.get('output') is not None):
            out[k] = (v.get('inputEffective'), v.get('input'), float(v['output']) if v.get('output') is not None else None)
    return out


def usd_for(key, tokens_in, tokens_out, prices):
    pr = prices.get(key)
    if not pr:
        return None
    if pr[0] is not None:
        return tokens_in / 1e6 * pr[0]
    return tokens_in / 1e6 * pr[1] + tokens_out / 1e6 * pr[2]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=2)
    ap.add_argument('--db', default=DEFAULT_DB)
    a = ap.parse_args()
    since = (datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - datetime.timedelta(days=a.days)).strftime('%Y-%m-%d %H:%M:%S')
    con = sqlite3.connect('file:' + a.db + '?mode=ro', uri=True)
    cur = con.cursor()
    print('ventana: desde', since, '(UTC)')
    cur.execute('''SELECT substr(updated_at,1,10), COUNT(*), ROUND(SUM(COALESCE(accumulated_cost,0)),2),
                          SUM(COALESCE(accumulated_input_tokens,0)), SUM(COALESCE(accumulated_output_tokens,0))
                   FROM sessions WHERE updated_at >= ? GROUP BY 1 ORDER BY 1''', (since,))
    print('\n== por dia ==')
    for d, n, usd, i, o in cur.fetchall():
        print('  %s  %2d sesiones  USD %8.2f  entrada %7.1fM  salida %6.1fk' % (d, n, usd or 0, (i or 0)/1e6, (o or 0)/1000))
    cur.execute("SELECT session_id, role, metadata_json FROM messages WHERE timestamp >= ? AND metadata_json IS NOT NULL", (since,))
    per_model = collections.defaultdict(lambda: [0, 0, 0])
    comp = [0, 0, 0]
    per_sess = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0]))
    for sid, role, mj in cur.fetchall():
        try: o = json.loads(mj)
        except Exception: continue
        us = o.get('usage') or {}
        i = int(us.get('inputTokens') or 0); ou = int(us.get('outputTokens') or 0)
        if us.get('isCompaction'):
            comp[0] += 1; comp[1] += i; comp[2] += ou; continue
        inf = o.get('inference')
        if isinstance(inf, dict) and inf:
            k = (inf.get('provider','?'), inf.get('requestedModel') or '?')
            per_model[k][0] += 1; per_model[k][1] += i; per_model[k][2] += ou
            e = per_sess[sid][k[1]]; e[0] += 1; e[1] += i; e[2] += ou
    prices = load_prices()
    if not prices:
        print('\n(sin precios en ' + PRICES + ': completa input/output USD por 1M tokens para ver el costo por modelo)')
    print('\n== por (proveedor, modelo) ==')
    for (p, m), (n, i, ou) in sorted(per_model.items(), key=lambda x: -x[1][1]):
        usd = usd_for(p + '/' + m, i, ou, prices)
        col = ('  USD %8.2f' % usd) if usd is not None else ''
        print('  %-16s %-28s %6d llam  entrada %7.1fM  salida %6.1fk%s' % (p, m, n, i/1e6, ou/1000, col))
    print('  %-45s %6d llam  entrada %7.1fM  salida %6.1fk' % ('COMPACTACION INTERNA (no atribuible)', comp[0], comp[1]/1e6, comp[2]/1000))
    print('\n== sesiones con mas de un modelo ==')
    for sid, d in per_sess.items():
        if len(d) > 1:
            print('  %s: %s' % (sid, '; '.join('%s:%d' % (m, v[0]) for m, v in sorted(d.items(), key=lambda x: -x[1][0]))))
    print('\n== top sesiones por costo ==')
    cur.execute('''SELECT id, substr(name,1,26), ROUND(COALESCE(accumulated_cost,0),2), accumulated_input_tokens,
                          (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id),
                          (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND COALESCE(m.metadata_json,'') LIKE '%\"agentVisible\":false%')
                   FROM sessions s WHERE updated_at >= ? ORDER BY accumulated_cost DESC LIMIT 12''', (since,))
    for sid, nm, usd, ti, msgs, hid in cur.fetchall():
        print('  %-13s %-26s USD %7.2f  %6d msj (%4.0f%% ocultos)' % (sid, nm or '', usd or 0, msgs, 100.0*hid/max(1,msgs)))
    con.close()

if __name__ == '__main__':
    sys.exit(main())
