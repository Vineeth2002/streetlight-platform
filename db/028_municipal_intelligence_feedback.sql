-- 028_municipal_intelligence_feedback.sql
-- Advisory learning layer. Derived from measured intervention outcomes; never changes
-- operational state, SLA rules, penalties, glow-rate calculations, or work orders.

CREATE OR REPLACE VIEW v_intervention_feedback_patterns AS
WITH latest AS (
  SELECT DISTINCT ON (iom.intervention_id)
    iom.intervention_id,iom.pole_id,iom.outcome,iom.observation_window_days,
    iom.recurrence_count,iom.measured_at,
    mi.intervention_type,mi.priority,mi.priority_score,mi.work_order_id,
    p.road_name,jb.ward_id,w.ward_number,z.zone_id,z.zone_name,
    wo.contractor_id,
    c.company_name AS contractor_name
  FROM intervention_outcome_measurements iom
  JOIN municipal_interventions mi ON mi.intervention_id=iom.intervention_id
  LEFT JOIN poles p ON p.pole_id=iom.pole_id
  LEFT JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id
  LEFT JOIN wards w ON w.ward_id=jb.ward_id
  LEFT JOIN zones z ON z.zone_id=w.zone_id
  LEFT JOIN work_orders wo ON wo.work_order_id=mi.work_order_id
  LEFT JOIN contractors c ON c.contractor_id=wo.contractor_id
  ORDER BY iom.intervention_id,iom.measured_at DESC,iom.measurement_id DESC
), cause AS (
  SELECT DISTINCT ON (pole_id) pole_id,cause_category,cause_code
  FROM incident_root_causes
  WHERE pole_id IS NOT NULL
  ORDER BY pole_id,determined_at DESC,root_cause_id DESC
)
SELECT
  l.intervention_type,l.zone_id,l.zone_name,l.contractor_id,l.contractor_name,
  COALESCE(c.cause_category,'UNCLASSIFIED') AS root_cause_category,
  COALESCE(c.cause_code,'UNSPECIFIED') AS root_cause_code,
  COUNT(*)::int AS measured_interventions,
  COUNT(*) FILTER (WHERE l.outcome='EFFECTIVE')::int AS effective_count,
  COUNT(*) FILTER (WHERE l.outcome='PARTIAL')::int AS partial_count,
  COUNT(*) FILTER (WHERE l.outcome='INEFFECTIVE')::int AS ineffective_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE l.outcome='EFFECTIVE') /
    NULLIF(COUNT(*) FILTER (WHERE l.outcome IN ('EFFECTIVE','PARTIAL','INEFFECTIVE')),0),2) AS effectiveness_rate,
  ROUND(AVG(l.recurrence_count),2) AS avg_recurrence,
  MAX(l.measured_at) AS last_measured_at
FROM latest l
LEFT JOIN cause c ON c.pole_id=l.pole_id
WHERE l.outcome IN ('EFFECTIVE','PARTIAL','INEFFECTIVE')
GROUP BY l.intervention_type,l.zone_id,l.zone_name,l.contractor_id,l.contractor_name,
         COALESCE(c.cause_category,'UNCLASSIFIED'),COALESCE(c.cause_code,'UNSPECIFIED');

CREATE INDEX IF NOT EXISTS idx_intervention_outcome_learning_measured
  ON intervention_outcome_measurements(measured_at DESC,outcome,intervention_id);
