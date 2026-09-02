-- 033_failure_correlation_intelligence.sql
-- Advisory systemic failure correlation layer. Correlates existing signals across
-- assets, cabinets, space, root cause, contractors, and intervention outcomes.
-- It never changes pole state, work orders, SLA rules, penalties, or glow-rate formulas.

CREATE OR REPLACE VIEW v_failure_correlation_patterns AS
WITH asset_base AS (
  SELECT p.pole_id,p.pole_number,p.cabinet_id,p.current_status,p.road_name,p.geolocation,
         w.ward_id,w.ward_number,z.zone_id,z.zone_name
  FROM poles p
  LEFT JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id
  LEFT JOIN wards w ON w.ward_id=jb.ward_id
  LEFT JOIN zones z ON z.zone_id=w.zone_id
  WHERE p.current_status <> 'DECOMMISSIONED'
), history AS (
  SELECT p.pole_id,
    COUNT(DISTINCT fe.episode_id) FILTER(WHERE fe.first_detected_at>=NOW()-INTERVAL '365 days')::int AS failure_episodes_365d,
    COUNT(DISTINCT wo.work_order_id) FILTER(WHERE wo.reported_timestamp>=NOW()-INTERVAL '365 days')::int AS work_orders_365d,
    COUNT(DISTINCT wo.work_order_id) FILTER(WHERE wo.ticket_status='SLA_VIOLATED' AND wo.reported_timestamp>=NOW()-INTERVAL '365 days')::int AS sla_violations_365d,
    COUNT(DISTINCT wo.contractor_id) FILTER(WHERE wo.reported_timestamp>=NOW()-INTERVAL '365 days' AND wo.contractor_id IS NOT NULL)::int AS contractors_365d
  FROM poles p
  LEFT JOIN fault_episodes fe ON fe.pole_id=p.pole_id
  LEFT JOIN work_orders wo ON wo.pole_id=p.pole_id
  GROUP BY p.pole_id
), cause AS (
  SELECT DISTINCT ON(pole_id) pole_id,cause_category,cause_code,confidence
  FROM incident_root_causes
  WHERE pole_id IS NOT NULL
  ORDER BY pole_id,determined_at DESC,root_cause_id DESC
), outcome AS (
  SELECT DISTINCT ON(iom.intervention_id) iom.pole_id,
    iom.outcome AS latest_intervention_outcome,
    iom.recurrence_count AS latest_recurrence_count,
    iom.measured_at AS latest_outcome_at
  FROM intervention_outcome_measurements iom
  ORDER BY iom.intervention_id,iom.measured_at DESC,iom.measurement_id DESC
), outcome_rollup AS (
  SELECT pole_id,
    COUNT(*) FILTER(WHERE outcome='INEFFECTIVE')::int AS ineffective_interventions,
    COUNT(*) FILTER(WHERE outcome='PARTIAL')::int AS partial_interventions,
    COUNT(*) FILTER(WHERE outcome='EFFECTIVE')::int AS effective_interventions
  FROM intervention_outcome_measurements
  GROUP BY pole_id
), contractor AS (
  SELECT DISTINCT ON(wo.pole_id) wo.pole_id,wo.contractor_id,c.company_name AS contractor_name
  FROM work_orders wo
  LEFT JOIN contractors c ON c.contractor_id=wo.contractor_id
  WHERE wo.contractor_id IS NOT NULL
  ORDER BY wo.pole_id,COALESCE(wo.updated_at,wo.created_at) DESC,wo.work_order_id DESC
)
SELECT a.*,
  COALESCE(h.failure_episodes_365d,0) AS failure_episodes_365d,
  COALESCE(h.work_orders_365d,0) AS work_orders_365d,
  COALESCE(h.sla_violations_365d,0) AS sla_violations_365d,
  COALESCE(h.contractors_365d,0) AS contractors_365d,
  COALESCE(ca.cause_category,'UNCLASSIFIED') AS root_cause_category,
  COALESCE(ca.cause_code,'UNSPECIFIED') AS root_cause_code,
  ca.confidence AS root_cause_confidence,
  co.contractor_id,co.contractor_name,
  COALESCE(oroll.ineffective_interventions,0) AS ineffective_interventions,
  COALESCE(oroll.partial_interventions,0) AS partial_interventions,
  COALESCE(oroll.effective_interventions,0) AS effective_interventions,
  out.latest_intervention_outcome,out.latest_recurrence_count,out.latest_outcome_at,
  CASE
    WHEN COALESCE(h.failure_episodes_365d,0)>=6
      OR COALESCE(h.sla_violations_365d,0)>=3
      OR COALESCE(oroll.ineffective_interventions,0)>=2 THEN 'SYSTEMIC'
    WHEN COALESCE(h.failure_episodes_365d,0)>=3
      OR COALESCE(h.work_orders_365d,0)>=4
      OR COALESCE(oroll.partial_interventions,0)>=2 THEN 'RECURRING'
    WHEN COALESCE(h.failure_episodes_365d,0)>=1 OR COALESCE(h.work_orders_365d,0)>=1 THEN 'ISOLATED'
    ELSE 'NONE'
  END AS correlation_pattern,
  LEAST(100,ROUND(
    30*LEAST(1.0,COALESCE(h.failure_episodes_365d,0)/6.0)+
    20*LEAST(1.0,COALESCE(h.sla_violations_365d,0)/3.0)+
    20*LEAST(1.0,COALESCE(h.work_orders_365d,0)/8.0)+
    15*LEAST(1.0,COALESCE(oroll.ineffective_interventions,0)/2.0)+
    10*LEAST(1.0,COALESCE(oroll.partial_interventions,0)/3.0)+
    5*LEAST(1.0,COALESCE(h.contractors_365d,0)/3.0),2)) AS systemic_correlation_score
FROM asset_base a
LEFT JOIN history h ON h.pole_id=a.pole_id
LEFT JOIN cause ca ON ca.pole_id=a.pole_id
LEFT JOIN outcome_rollup oroll ON oroll.pole_id=a.pole_id
LEFT JOIN outcome out ON out.pole_id=a.pole_id
LEFT JOIN contractor co ON co.pole_id=a.pole_id;

CREATE OR REPLACE VIEW v_failure_correlation_summary AS
SELECT zone_id,zone_name,
  COUNT(*)::int AS assets,
  COUNT(*) FILTER(WHERE correlation_pattern='SYSTEMIC')::int AS systemic_assets,
  COUNT(*) FILTER(WHERE correlation_pattern='RECURRING')::int AS recurring_assets,
  COUNT(*) FILTER(WHERE systemic_correlation_score>=70)::int AS high_correlation_assets,
  SUM(failure_episodes_365d)::int AS failure_episodes_365d,
  SUM(sla_violations_365d)::int AS sla_violations_365d,
  ROUND(AVG(systemic_correlation_score),2) AS avg_correlation_score
FROM v_failure_correlation_patterns
GROUP BY zone_id,zone_name;

CREATE INDEX IF NOT EXISTS idx_work_orders_contractor_pole_history
  ON work_orders(pole_id,contractor_id,reported_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_intervention_outcome_pole_result
  ON intervention_outcome_measurements(pole_id,outcome,measured_at DESC);
