#!/usr/bin/env python3
"""Regresiones para audit-costs.py (fixtures SQLite independientes del store real)."""
import datetime
import importlib.util
import pathlib
import sqlite3
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('audit_costs', pathlib.Path(__file__).with_name('audit-costs.py'))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class AuditCostsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = pathlib.Path(self.temp.name) / 'usage.db'
        self.con = sqlite3.connect(self.db)
        self.addCleanup(self.con.close)
        self.con.execute('CREATE TABLE sessions (id TEXT, name TEXT, updated_at TEXT, accumulated_cost REAL)')
        self.con.execute('CREATE TABLE messages (session_id TEXT, created_timestamp INTEGER, metadata_json TEXT)')
        self.now = int(datetime.datetime(2026, 10, 20, 12, tzinfo=datetime.timezone.utc).timestamp())
        self.since = self.now - 86400
        self.con.execute("INSERT INTO sessions VALUES ('old','Viejita','2026-10-20',999)")
        self.con.execute("INSERT INTO sessions VALUES ('active','Activa','2026-10-20',999)")

    def report(self):
        lines = []
        if audit.columns(self.con, 'usage_ledger'):
            audit.report_ledger(self.con, self.since, lines.append)
        else:
            audit.report_legacy(self.con, self.since, lines.append)
        return '\n'.join(lines)

    def test_ledger_timestamp_cost_and_compaction(self):
        self.con.execute('''CREATE TABLE usage_ledger (session_id TEXT, created_timestamp INTEGER, model TEXT,
            input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
            cost REAL, cost_source TEXT, is_compaction INTEGER)''')
        rows = [
            ('old', self.since - 10, 'old', 2000000, 4000, 0, 0, 999, 'estimated', 0),
            ('active', self.now - 20, 'm1', 1000000, 2000, 300000, 500, .2, 'estimated', 0),
            ('active', self.now - 10, 'm2', 200000, 3000, 50000, 0, .3, 'estimated', 1),
            ('active', self.now, 'm1', 120000, 40, 0, 0, None, None, 0),
        ]
        self.con.executemany('INSERT INTO usage_ledger VALUES (?,?,?,?,?,?,?,?,?,?)', rows)
        self.con.executemany('INSERT INTO messages VALUES (?,?,?)', [
            ('active', self.now, '{"inference":{"provider":"a","requestedModel":"m1"}}'),
            ('active', self.now, '{"inference":{"provider":"b","requestedModel":"m2"}}'),
        ])
        text = self.report()
        date = datetime.datetime.fromtimestamp(self.now, datetime.timezone.utc).strftime('%Y-%m-%d')
        self.assertIn(date + '  1 sesiones  3 llam  USD estimado 0.50 (1 sin costo)', text)
        self.assertIn('a                m1', text)
        self.assertIn('b                m2', text)
        self.assertIn('COMPACTACIÓN INTERNA: 1 llam', text)
        self.assertIn('estimated: 2 llam  USD 0.50', text)
        self.assertIn('USD estimado    0.50', text)
        self.assertNotIn('999.00', text)
        self.assertNotIn('old', text)
        self.assertIn('más de un modelo', text)

    def test_ledger_has_provider_column_and_ambiguous_mapping(self):
        self.con.execute('''CREATE TABLE usage_ledger (session_id TEXT, created_timestamp INTEGER, model TEXT,
            provider TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
            cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER)''')
        self.con.execute("INSERT INTO usage_ledger VALUES ('active', ?, 'model','direct',1,2,0,0,0.0,'provider',0)", (self.now,))
        text = self.report()
        self.assertIn('direct           model', text)
        self.assertIn('USD estimado 0.00 (0 sin costo)', text)
        self.assertNotIn('inferido', text)

    def test_legacy_does_not_count_updated_sessions_as_daily_spend(self):
        self.con.execute('INSERT INTO messages VALUES (?,?,?)',
                         ('active', self.now, '{"inference":{"provider":"p","requestedModel":"m"},"usage":{"inputTokens":100,"outputTokens":10,"cost":0.25}}'))
        self.con.execute('INSERT INTO messages VALUES (?,?,?)',
                         ('old', self.since - 2, '{"inference":{"provider":"p","requestedModel":"m"},"usage":{"cost":100}}'))
        text = self.report()
        self.assertIn('LEGACY', text)
        self.assertIn('USD estimado 0.25', text)
        self.assertNotIn('USD estimado 999', text)
        self.assertNotIn('USD estimado 100', text)

    def test_legacy_missing_cost_not_zero(self):
        self.con.execute('INSERT INTO messages VALUES (?,?,?)',
                         ('active', self.now, '{"inference":{"provider":"p","requestedModel":"m"},"usage":{"inputTokens":3}}'))
        self.assertIn('(1 sin costo)', self.report())


if __name__ == '__main__':
    unittest.main()
