#!/usr/bin/env python3
"""Auditoría read-only: costos estimados reportados por Aegis, no facturación.

Uso: python tools/audit-costs.py --days 2 [--db sessions.db]
La ventana se aplica a cada llamada (usage_ledger.created_timestamp), no a la
última modificación de la sesión. Los días se muestran en UTC.
"""
import argparse
import collections
import datetime
import json
import pathlib
import sqlite3

DEFAULT_DB = pathlib.Path('C:/Aegis-Proyects/state/data/sessions/sessions.db')
PRICES = pathlib.Path(__file__).resolve().parent.parent / 'prices.json'


def load_prices():
    """Tarifas opcionales; solo para indicar que NO sustituyen el costo registrado."""
    try:
        return json.loads(PRICES.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def columns(con, table):
    return {r[1] for r in con.execute('PRAGMA table_info(' + table + ')')}


def model_providers(con, since):
    """El ledger antiguo solo guarda modelo: atribuir proveedor si no hay ambigüedad."""
    result = collections.defaultdict(set)
    if not columns(con, 'messages'):
        return result
    for sid, raw in con.execute('SELECT session_id, metadata_json FROM messages WHERE metadata_json IS NOT NULL AND created_timestamp >= ?', (since,)):
        try:
            inf = json.loads(raw).get('inference') or {}
            provider = inf.get('provider')
            model = inf.get('requestedModel')
            if provider and model:
                result[(sid, model)].add(provider)
        except (TypeError, ValueError, AttributeError):
            continue
    return result


def report_ledger(con, since, out=print):
    cols = columns(con, 'usage_ledger')
    provider_col = 'provider' if 'provider' in cols else None
    mappings = model_providers(con, since)
    where = 'WHERE l.created_timestamp >= ?'
    # A query per call preserves nullable cost, source and session/model identity.
    sql = ('SELECT l.session_id, l.created_timestamp, l.model, l.input_tokens, l.output_tokens, '
           'l.cache_read_tokens, l.cache_write_tokens, l.cost, l.cost_source, l.is_compaction, '
           + ('l.provider' if provider_col else 'NULL') + ' FROM usage_ledger l ' + where)
    days = collections.defaultdict(lambda: [0, 0., 0, 0, 0, 0, 0, 0, set()])
    models = collections.defaultdict(lambda: [0, 0., 0, 0, 0, 0, 0, 0])
    sessions = collections.defaultdict(lambda: [0, 0., 0, 0, 0])
    sess_models = collections.defaultdict(set)
    sources = collections.defaultdict(lambda: [0, 0.])
    comp = [0, 0, 0, 0.]
    total = 0
    for sid, ts, model, inp, output, cache_r, cache_w, cost, source, is_comp, provider in con.execute(sql, (since,)):
        total += 1
        model = model or '?'
        if not provider:
            known = mappings.get((sid, model), set())
            provider = next(iter(known)) if len(known) == 1 else '?'
        key = (provider, model)
        i, o, cr, cw = inp or 0, output or 0, cache_r or 0, cache_w or 0
        d = days[datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%Y-%m-%d')]
        d[0] += 1; d[2] += i; d[3] += o; d[4] += cr; d[5] += cw; d[8].add(sid)
        m = models[key]
        m[0] += 1; m[2] += i; m[3] += o; m[4] += cr; m[5] += cw
        s = sessions[sid]
        s[0] += 1; s[2] += i; s[3] += o
        sess_models[sid].add(key)
        if cost is None:
            d[7] += 1; m[7] += 1; s[4] += 1
        else:
            d[1] += cost; d[6] += 1; m[1] += cost; m[6] += 1; s[1] += cost
        source = source or '(sin fuente)'
        sources[source][0] += 1
        sources[source][1] += cost or 0
        if is_comp:
            comp[0] += 1; comp[1] += i; comp[2] += o; comp[3] += cost or 0
    out('fuente: usage_ledger.created_timestamp (UTC); USD = estimación del ledger, NO factura; costo ausente no equivale a $0')
    if not provider_col:
        out('proveedor: inferido por metadata.inference de la misma sesión/modelo; ? = no atribuible (el ledger no guarda proveedor)')
    out('== por día (UTC, llamadas de la ventana) ==')
    for date, (n, usd, i, o, cr, cw, priced, missing, sids) in sorted(days.items()):
        out('  %s  %d sesiones  %d llam  USD estimado %.2f (%d sin costo)  entrada %.1fM  salida %.1fk  cache lectura %.1fM escritura %.1fk' %
            (date, len(sids), n, usd, missing, i/1e6, o/1000, cr/1e6, cw/1000))
    if not total:
        out('  (sin llamadas en la ventana)')
    out('== por (proveedor, modelo) ==')
    for (provider, model), (n, usd, i, o, cr, cw, priced, missing) in sorted(models.items(), key=lambda x: -x[1][2]):
        out('  %-16s %-28s %6d llam  entrada %7.1fM  salida %6.1fk  cache %.1fM  USD estimado %.2f (%d sin costo)' %
            (provider, model, n, i/1e6, o/1000, cr/1e6, usd, missing))
    out('  COMPACTACIÓN INTERNA: %d llam  entrada %.1fM  salida %.1fk  USD estimado %.2f (incluida arriba)' %
        (comp[0], comp[1]/1e6, comp[2]/1000, comp[3]))
    out('== fuente del costo ==')
    for source, (n, usd) in sorted(sources.items()):
        out('  %s: %d llam  USD %.2f' % (source, n, usd))
    out('== sesiones con más de un modelo en la ventana ==')
    for sid, mix in sorted(sess_models.items()):
        if len(mix) > 1:
            out('  %s: %s' % (sid, '; '.join('%s/%s' % x for x in sorted(mix))))
    out('== top sesiones por costo estimado en la ventana ==')
    names = {sid: name for sid, name in con.execute('SELECT id, name FROM sessions')}
    top = sorted(sessions.items(), key=lambda x: -x[1][1])[:12]
    hidden = {}
    if top and columns(con, 'messages'):
        ids = [sid for sid, _ in top]
        marks = ','.join('?' for _ in ids)
        for sid, count, invisible in con.execute(
                'SELECT session_id, COUNT(*), SUM(CASE WHEN metadata_json LIKE ? THEN 1 ELSE 0 END) '
                'FROM messages WHERE session_id IN (' + marks + ') GROUP BY session_id',
                ['%"agentVisible":false%'] + ids):
            hidden[sid] = (count, invisible or 0)
    for sid, (n, usd, i, o, missing) in top:
        msgs, invisible = hidden.get(sid, (0, 0))
        out('  %-13s %-26s USD estimado %7.2f  %5d llam (%d sin costo) entrada %.1fM  %d msj totales (%.0f%% ocultos)' %
            (sid, (names.get(sid) or '')[:26], usd, n, missing, i/1e6, msgs, 100*invisible/max(1, msgs)))


def report_legacy(con, since, out=print):
    """Stores anteriores sin ledger: metadata por mensaje, nunca acumulados de sesiones como costo diario."""
    if not columns(con, 'messages'):
        out('Sin usage_ledger ni mensajes: no hay datos para auditar.'); return
    out('LEGACY: sin usage_ledger; fechas de mensajes, cobertura parcial (incl. compactaciones sin mensaje). USD = estimación, NO factura.')
    days = collections.defaultdict(lambda: [0, 0., 0, 0, 0, set()])
    models = collections.defaultdict(lambda: [0, 0., 0, 0, 0])
    sessions = collections.defaultdict(lambda: [0, 0., 0])
    mixes = collections.defaultdict(set)
    for sid, ts, raw in con.execute('SELECT session_id, created_timestamp, metadata_json FROM messages WHERE created_timestamp >= ? AND metadata_json IS NOT NULL', (since,)):
        try:
            meta = json.loads(raw)
            usage = meta.get('usage') or {}
            inf = meta.get('inference') or {}
            if not isinstance(usage, dict) or not isinstance(inf, dict) or not usage:
                continue
            key = (inf.get('provider') or '?', inf.get('requestedModel') or '?')
            i, o = int(usage.get('inputTokens') or 0), int(usage.get('outputTokens') or 0)
            cost = usage.get('cost')
            d = days[datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%Y-%m-%d')]
            d[0] += 1; d[2] += i; d[3] += o; d[5].add(sid)
            m = models[key]
            m[0] += 1; m[2] += i; m[3] += o
            s = sessions[sid]
            s[0] += 1
            mixes[sid].add(key)
            if isinstance(cost, (float, int)):
                d[1] += cost; m[1] += cost; s[1] += cost
            else:
                d[4] += 1; m[4] += 1; s[2] += 1
        except (TypeError, ValueError, OverflowError, AttributeError):
            continue
    out('== por día (UTC; metadata de mensajes, no sesiones.updated_at) ==')
    for date, (n, usd, i, o, missing, ids) in sorted(days.items()):
        out('  %s  %d sesiones  %d llam  USD estimado %.2f (%d sin costo)  entrada %.1fM  salida %.1fk' %
            (date, len(ids), n, usd, missing, i/1e6, o/1000))
    if not days: out('  (sin uso atribuible en la ventana)')
    out('== por (proveedor, modelo) ==')
    for (p, model), (n, usd, i, o, missing) in sorted(models.items(), key=lambda x: -x[1][2]):
        out('  %-16s %-28s %6d llam  entrada %.1fM  salida %.1fk  USD estimado %.2f (%d sin costo)' %
            (p, model, n, i/1e6, o/1000, usd, missing))
    out('== sesiones con más de un modelo en la ventana ==')
    for sid, mix in sorted(mixes.items()):
        if len(mix) > 1: out('  %s: %s' % (sid, '; '.join('%s/%s' % x for x in sorted(mix))))
    out('== top sesiones por costo estimado PARCIAL en la ventana ==')
    names = {sid: name for sid, name in con.execute('SELECT id, name FROM sessions')}
    for sid, (n, usd, missing) in sorted(sessions.items(), key=lambda x: -x[1][1])[:12]:
        out('  %-13s %-26s USD estimado %7.2f  %5d mensajes (%d sin costo)' %
            (sid, (names.get(sid) or '')[:26], usd, n, missing))
    out('precios opcionales: %s (%s; nunca sustituyen un costo faltante)' % (PRICES, 'disponibles' if load_prices() else 'no disponibles'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--days', type=float, default=2)
    parser.add_argument('--db', type=pathlib.Path, default=DEFAULT_DB)
    args = parser.parse_args(argv)
    if args.days < 0: parser.error('--days debe ser >= 0')
    since = int(datetime.datetime.now(datetime.timezone.utc).timestamp() - args.days * 86400)
    print('ventana: desde', datetime.datetime.fromtimestamp(since, datetime.timezone.utc).isoformat(), '(UTC)')
    with sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True) as con:
        if columns(con, 'usage_ledger'):
            report_ledger(con, since)
        else:
            report_legacy(con, since)


if __name__ == '__main__':
    main()
