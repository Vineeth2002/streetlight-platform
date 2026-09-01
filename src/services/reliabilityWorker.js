'use strict';

const db = require('../../config/database');
const logger = require('../utils/logger');

let timer = null;

const RELIABILITY_SQL = `
WITH failures AS (
  SELECT wo.pole_id, wo.work_order_id, wo.reported_timestamp, wo.resolved_timestamp, wo.fault_category,
         LAG(wo.reported_timestamp) OVER (PARTITION BY wo.pole_id ORDER BY wo.reported_timestamp) AS prev_failure
  FROM work_orders wo
  WHERE wo.ticket_status <> 'CANCELLED'
), agg AS (
  SELECT p.pole_id,
         COUNT(f.work_order_id) FILTER (WHERE f.reported_timestamp >= NOW()-INTERVAL '90 days')::int repair_count_90d,
         COUNT(f.work_order_id) FILTER (WHERE f.reported_timestamp >= NOW()-INTERVAL '365 days')::int repair_count_365d,
         COUNT(f.work_order_id) FILTER (WHERE f.reported_timestamp >= NOW()-INTERVAL '90 days' AND f.prev_failure IS NOT NULL)::int recurrence_count_90d,
         ROUND(AVG(EXTRACT(EPOCH FROM (f.resolved_timestamp-f.reported_timestamp))/3600.0) FILTER (WHERE f.resolved_timestamp IS NOT NULL AND f.reported_timestamp >= NOW()-INTERVAL '365 days'),2) mttr_hours_365d,
         ROUND(AVG(EXTRACT(EPOCH FROM (f.reported_timestamp-f.prev_failure))/3600.0) FILTER (WHERE f.prev_failure IS NOT NULL AND f.reported_timestamp >= NOW()-INTERVAL '365 days'),2) mtbf_hours_365d,
         MAX(f.reported_timestamp) last_failure_at,
         (ARRAY_AGG(f.fault_category ORDER BY f.reported_timestamp DESC))[1] dominant_fault_category
  FROM poles p LEFT JOIN failures f ON f.pole_id=p.pole_id GROUP BY p.pole_id
)
SELECT a.*,
 ROUND(GREATEST(0,LEAST(100,(a.repair_count_90d*15)+(a.recurrence_count_90d*10)+
   CASE WHEN a.mttr_hours_365d>72 THEN 20 WHEN a.mttr_hours_365d>48 THEN 12 WHEN a.mttr_hours_365d>24 THEN 6 ELSE 0 END+
   CASE WHEN a.repair_count_365d>=8 THEN 20 WHEN a.repair_count_365d>=5 THEN 12 WHEN a.repair_count_365d>=3 THEN 6 ELSE 0 END)),2) risk_score,
 CASE WHEN a.repair_count_90d>=4 OR a.repair_count_365d>=8 THEN 'CRITICAL'
      WHEN a.repair_count_90d>=2 OR a.repair_count_365d>=5 THEN 'HIGH'
      WHEN a.repair_count_90d>=1 OR a.repair_count_365d>=3 THEN 'MEDIUM'
      ELSE 'LOW' END risk_band,
 CASE WHEN a.last_failure_at IS NULL THEN NULL ELSE ROUND(EXTRACT(EPOCH FROM (NOW()-a.last_failure_at))/86400.0,2) END days_since_last_repair
FROM agg a`;

async function refreshReliability() {
  const rows = await db.manyOrNone(RELIABILITY_SQL);
  await db.tx(async t => {
    for (const r of rows) {
      const factors = {
        repair_count_90d: Number(r.repair_count_90d),
        repair_count_365d: Number(r.repair_count_365d),
        recurrence_count_90d: Number(r.recurrence_count_90d),
        mttr_hours_365d: r.mttr_hours_365d == null ? null : Number(r.mttr_hours_365d),
        mtbf_hours_365d: r.mtbf_hours_365d == null ? null : Number(r.mtbf_hours_365d),
        dominant_fault_category: r.dominant_fault_category || null,
        methodology: 'deterministic-v1'
      };
      await t.none(`INSERT INTO asset_reliability_snapshots(pole_id,as_of,repair_count_90d,repair_count_365d,recurrence_count_90d,mttr_hours_365d,mtbf_hours_365d,days_since_last_repair,last_failure_at,dominant_fault_category,risk_score,risk_band,factors) VALUES($1,NOW(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [r.pole_id,r.repair_count_90d,r.repair_count_365d,r.recurrence_count_90d,r.mttr_hours_365d,r.mtbf_hours_365d,r.days_since_last_repair,r.last_failure_at,r.dominant_fault_category,r.risk_score,r.risk_band,factors]);
      if (r.risk_band === 'HIGH' || r.risk_band === 'CRITICAL') {
        await t.none(`INSERT INTO predictive_alerts(pole_id,alert_type,severity,status,score,reason,evidence) SELECT $1,'ASSET_RELIABILITY', $2,'OPEN',$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM predictive_alerts WHERE pole_id=$1 AND alert_type='ASSET_RELIABILITY' AND status IN ('OPEN','ACKNOWLEDGED'))`, [r.pole_id,r.risk_band,r.risk_score,`Asset reliability risk is ${r.risk_band.toLowerCase()} based on repair recurrence and historical resolution behavior.`,factors]);
      }
    }
  });
  return rows.length;
}

function startReliabilityWorker({ intervalMs = Number(process.env.RELIABILITY_REFRESH_INTERVAL_MS || 3600000) } = {}) {
  if (timer) return timer;
  const run = async () => {
    try { const count = await refreshReliability(); logger.info('Asset reliability intelligence refreshed', { count }); }
    catch (err) { logger.error('Asset reliability refresh failed', { error: err.message }); }
  };
  run();
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}
function stopReliabilityWorker() { if (timer) clearInterval(timer); timer = null; }

module.exports = { RELIABILITY_SQL, refreshReliability, startReliabilityWorker, stopReliabilityWorker };
