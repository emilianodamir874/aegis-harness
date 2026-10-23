import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const DB = process.env.AEGIS_SESSIONS_DB || "C:/Aegis-Proyects/state/data/sessions/sessions.db";
const CONFIG = process.env.AEGIS_WEB_CONFIG || fileURLToPath(new URL("../config.json", import.meta.url));
const argv = process.argv.slice(2);
const argNum = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : null;
};
const days = argNum("--days");
const out = { generatedAt: (/* @__PURE__ */ new Date()).toISOString(), days: days && days > 0 ? days : 0 };
try {
  if (!existsSync(DB)) throw new Error("no existe la base: " + DB);
  const db = new DatabaseSync("file:" + DB + "?mode=ro", { readOnly: true });
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const since = out.days ? Math.floor(Date.now() / 1e3) - out.days * 86400 : 0;
  const W = since ? "where created_timestamp >= ?" : "";
  const wp = since ? [since] : [];
  out.db = DB;
  out.window = { since: since || null, until: Math.floor(Date.now() / 1e3) };
  const t = one(
    `select count(*) calls,
            coalesce(sum(cost),0) cost,
            coalesce(sum(input_tokens),0) input,
            coalesce(sum(output_tokens),0) output,
            coalesce(sum(cache_read_tokens),0) cache_read,
            coalesce(sum(cache_write_tokens),0) cache_write,
            sum(case when cost is null then 1 else 0 end) no_cost,
            sum(case when cost is not null then 1 else 0 end) with_cost,
            sum(case when is_compaction = 1 then 1 else 0 end) compaction_calls,
            coalesce(sum(case when is_compaction = 1 then cost else 0 end),0) compaction_cost,
            count(distinct session_id) sessions,
            min(created_timestamp) first_ts,
            max(created_timestamp) last_ts
       from usage_ledger ${W}`,
    ...wp
  );
  out.totals = {
    calls: t.calls,
    cost: t.cost,
    input: t.input,
    output: t.output,
    cacheRead: t.cache_read,
    cacheWrite: t.cache_write,
    noCostCalls: t.no_cost || 0,
    withCostCalls: t.with_cost || 0,
    sessions: t.sessions,
    compactionCalls: t.compaction_calls || 0,
    compactionCost: t.compaction_cost || 0,
    cacheHitPct: t.input ? t.cache_read / t.input * 100 : null,
    avgCostPerCall: t.with_cost ? t.cost / t.with_cost : null,
    avgTokensPerCall: t.calls ? (t.input + t.output) / t.calls : null,
    firstTs: t.first_ts || null,
    lastTs: t.last_ts || null
  };
  const costs = all(`select cost from usage_ledger ${since ? "where created_timestamp >= ? and" : "where"} cost is not null order by cost`, ...wp).map((r) => r.cost);
  const pct = (p) => costs.length ? costs[Math.min(costs.length - 1, Math.floor(p / 100 * costs.length))] : null;
  out.percentiles = { p50: pct(50), p95: pct(95), p99: pct(99), max: costs.length ? costs[costs.length - 1] : null };
  out.daily = all(
    `select date(created_timestamp,'unixepoch','localtime') d,
            count(*) calls,
            coalesce(sum(cost),0) cost,
            coalesce(sum(input_tokens),0) input,
            coalesce(sum(output_tokens),0) output,
            coalesce(sum(cache_read_tokens),0) cache_read
       from usage_ledger ${W}
      group by 1 order by 1`,
    ...wp
  ).map((r) => ({ d: r.d, calls: r.calls, cost: r.cost, input: r.input, output: r.output, cache: r.cache_read }));
  out.models = all(
    `select model,
            count(*) calls,
            coalesce(sum(cost),0) cost,
            sum(case when cost is null then 1 else 0 end) no_cost,
            coalesce(sum(input_tokens),0) input,
            coalesce(sum(output_tokens),0) output,
            coalesce(sum(cache_read_tokens),0) cache_read,
            max(created_timestamp) last_ts
       from usage_ledger ${W}
      group by 1 order by cost desc, calls desc`,
    ...wp
  ).map((r) => ({
    model: r.model || "(sin modelo)",
    calls: r.calls,
    cost: r.cost,
    noCostCalls: r.no_cost || 0,
    input: r.input,
    output: r.output,
    cacheRead: r.cache_read,
    cacheHitPct: r.input ? r.cache_read / r.input * 100 : null,
    costPerCall: r.calls ? r.cost / r.calls : null,
    share: t.cost ? r.cost / t.cost * 100 : null,
    lastTs: r.last_ts
  }));
  const hours = new Array(24).fill(0).map((_, h) => ({ h, calls: 0, cost: 0 }));
  for (const r of all(
    `select cast(strftime('%H', created_timestamp,'unixepoch','localtime') as integer) h,
            count(*) calls, coalesce(sum(cost),0) cost
       from usage_ledger ${W} group by 1`,
    ...wp
  )) if (r.h >= 0 && r.h < 24) hours[r.h] = { h: r.h, calls: r.calls, cost: r.cost };
  out.hours = hours;
  out.costSources = all(
    `select coalesce(cost_source,'(sin dato)') source, count(*) calls, coalesce(sum(cost),0) cost
       from usage_ledger ${W} group by 1 order by cost desc`,
    ...wp
  ).map((r) => ({ source: r.source, calls: r.calls, cost: r.cost }));
  out.sessions = all(
    `select l.session_id sid, coalesce(nullif(s.name,''),'') name,
            count(*) calls, coalesce(sum(l.cost),0) cost,
            coalesce(sum(l.input_tokens),0) input, coalesce(sum(l.output_tokens),0) output,
            max(l.created_timestamp) last_ts
       from usage_ledger l left join sessions s on s.id = l.session_id
       ${since ? "where l.created_timestamp >= ?" : ""}
      group by 1 order by cost desc limit 15`,
    ...wp
  ).map((r) => ({ sid: r.sid, name: r.name, calls: r.calls, cost: r.cost, input: r.input, output: r.output, lastTs: r.last_ts }));
  out.topCalls = all(
    `select l.session_id sid, l.model, l.cost, l.input_tokens, l.output_tokens, l.created_timestamp ts
       from usage_ledger l ${since ? "where l.created_timestamp >= ? and" : "where"} l.cost is not null
      order by l.cost desc limit 8`,
    ...wp
  ).map((r) => ({ sid: r.sid, model: r.model, cost: r.cost, input: r.input_tokens, output: r.output_tokens, ts: r.ts }));
  out.modelMix = one(
    `select count(*) sessions, sum(case when n > 1 then 1 else 0 end) multi
       from (select session_id, count(distinct model) n from usage_ledger ${W} group by 1)`,
    ...wp
  );
  const planes = (() => {
    try {
      if (!existsSync(CONFIG)) return {};
      const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
      const raw = cfg && typeof cfg.plans === "object" && cfg.plans ? cfg.plans : {};
      const limpio = {};
      for (const k of Object.keys(raw)) {
        const v = raw[k] || {};
        limpio[k] = {
          monthly_usd: Number(v.monthly_usd) || 0,
          label: String(v.label || k),
          note: String(v.note || "")
        };
      }
      return limpio;
    } catch {
      return {};
    }
  })();
  const hasta = Math.floor(Date.now() / 1e3);
  const desde = since || (t.first_ts ? Number(t.first_ts) : hasta);
  const diasRango = Math.max(1, (hasta - desde) / 86400);
  const ahora = /* @__PURE__ */ new Date();
  const diasDelMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).getDate();
  const factor = diasRango / diasDelMes;
  out.planWindow = { periodDays: diasRango, daysInMonth: diasDelMes, factor, prorated: Math.abs(diasRango - diasDelMes) > 0.5 };
  const porProv = all(
    `select coalesce(nullif(trim(provider),''),'') p,
            count(*) calls,
            coalesce(sum(input_tokens),0) + coalesce(sum(output_tokens),0) tokens,
            coalesce(sum(cost),0) est,
            sum(case when cost is not null then 1 else 0 end) cost_known
       from usage_ledger ${W}
      group by 1 order by est desc`,
    ...wp
  );
  const filas = [];
  let desconocido = null;
  for (const r of porProv) {
    if (!r.p) {
      desconocido = { calls: r.calls, estimatedUsd: r.est, tokens: r.tokens, costKnownCalls: r.cost_known || 0 };
      continue;
    }
    const plan = planes[r.p];
    const planUsd = plan && plan.monthly_usd > 0 ? plan.monthly_usd * factor : null;
    filas.push({
      provider: r.p,
      label: plan ? plan.label : r.p,
      calls: r.calls,
      tokens: r.tokens,
      estimatedUsd: r.est,
      costKnownCalls: r.cost_known || 0,
      planUsd,
      deltaUsd: planUsd == null ? null : r.est - planUsd,
      note: plan ? plan.note : ""
    });
  }
  for (const p of Object.keys(planes)) {
    if (filas.some((f) => f.provider === p)) continue;
    const planUsd = planes[p].monthly_usd > 0 ? planes[p].monthly_usd * factor : null;
    filas.push({
      provider: p,
      label: planes[p].label,
      calls: 0,
      tokens: 0,
      estimatedUsd: 0,
      costKnownCalls: 0,
      planUsd,
      deltaUsd: planUsd == null ? null : -planUsd,
      note: planes[p].note
    });
  }
  out.byProvider = filas;
  out.unknownProvider = desconocido;
  const conPlan = filas.filter((f) => f.planUsd != null);
  out.vsPlan = {
    providers: conPlan.length,
    declared: Object.keys(planes).filter((p) => planes[p].monthly_usd > 0).length,
    estimatedUsd: conPlan.reduce((a, f) => a + f.estimatedUsd, 0),
    planUsd: conPlan.reduce((a, f) => a + f.planUsd, 0),
    deltaUsd: conPlan.reduce((a, f) => a + f.deltaUsd, 0)
  };
  db.close();
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stdout.write(JSON.stringify({ _error: String(e && e.message || e), db: DB }));
}
