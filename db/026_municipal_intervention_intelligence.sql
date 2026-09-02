-- 026_municipal_intervention_intelligence.sql
-- Decision-support only. Recommendations never create work orders, alter pole state,
-- recalculate SLA, penalties, or glow-rate metrics.

CREATE TABLE IF NOT EXISTS municipal_interventions (
    intervention_id BIGSERIAL PRIMARY KEY,
    pole_id INT REFERENCES poles(pole_id) ON DELETE SET NULL,
    zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    ward_id INT REFERENCES wards(ward_id) ON DELETE SET NULL,
    intervention_type VARCHAR(40) NOT NULL CHECK (intervention_type IN
      ('IMMEDIATE_REPAIR','AREA_INSPECTION','ROOT_CAUSE_REVIEW','REPLACEMENT_REVIEW','CONTRACTOR_REVIEW','SLA_ESCALATION','BUDGET_REVIEW','MONITOR')),
    priority VARCHAR(12) NOT NULL CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    priority_score NUMERIC(6,2) NOT NULL CHECK (priority_score BETWEEN 0 AND 100),
    recommendation TEXT NOT NULL,
    rationale JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(15) NOT NULL DEFAULT 'RECOMMENDED' CHECK (status IN ('RECOMMENDED','ACKNOWLEDGED','ASSIGNED','IN_PROGRESS','COMPLETED','DEFERRED','DISMISSED')),
    assigned_to INT REFERENCES users(user_id) ON DELETE SET NULL,
    work_order_id INT REFERENCES work_orders(work_order_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    decided_at TIMESTAMPTZ,
    decided_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_intervention_priority_status ON municipal_interventions(priority,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intervention_pole ON municipal_interventions(pole_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intervention_zone ON municipal_interventions(zone_id,status,priority);
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_intervention_pole_type
  ON municipal_interventions(pole_id,intervention_type)
  WHERE pole_id IS NOT NULL AND status IN ('RECOMMENDED','ACKNOWLEDGED','ASSIGNED','IN_PROGRESS');

CREATE OR REPLACE VIEW v_municipal_intervention_candidates AS
WITH rel AS (
  SELECT DISTINCT ON (pole_id) pole_id,risk_score,risk_band,repair_count_90d,repair_count_365d,recurrence_count_90d,last_failure_at,dominant_fault_category
  FROM asset_reliability_snapshots ORDER BY pole_id,as_of DESC
), open_wo AS (
  SELECT pole_id,COUNT(*)::int open_work_orders,COUNT(*) FILTER (WHERE ticket_status='SLA_VIOLATED')::int sla_violations
  FROM work_orders WHERE ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED') GROUP BY pole_id
), roots AS (
  SELECT pole_id,COUNT(*)::int root_cause_determinations,MAX(determined_at) last_root_cause_at
  FROM incident_root_causes GROUP BY pole_id
), replacement AS (
  SELECT DISTINCT ON (pole_id) pole_id,replacement_priority,replacement_reason
  FROM v_asset_replacement_candidates ORDER BY pole_id,CASE replacement_priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
), health AS (
  SELECT DISTINCT ON (pole_id) pole_id,health_score,health_band
  FROM v_asset_health_index ORDER BY pole_id,health_score ASC
), spatial AS (
  SELECT h.grid_cell,h.hotspot_band,h.failures_90d,h.open_work_orders AS hotspot_open_work_orders,h.sla_violations_90d
  FROM v_spatial_failure_hotspots h
), base AS (
 SELECT p.pole_id,p.pole_number,p.current_status,p.road_name,z.zone_id,z.zone_name,w.ward_id,w.ward_number,
        COALESCE(h.health_score,50)::numeric health_score,COALESCE(h.health_band,'FAIR') health_band,
        COALESCE(r.risk_score,50)::numeric risk_score,COALESCE(r.risk_band,'MEDIUM') risk_band,
        COALESCE(r.repair_count_90d,0) repair_count_90d,COALESCE(r.repair_count_365d,0) repair_count_365d,COALESCE(r.recurrence_count_90d,0) recurrence_count_90d,
        r.last_failure_at,r.dominant_fault_category,COALESCE(o.open_work_orders,0) open_work_orders,COALESCE(o.sla_violations,0) sla_violations,
        COALESCE(rt.root_cause_determinations,0) root_cause_determinations,
        COALESCE(rep.replacement_priority,'LOW') replacement_priority,rep.replacement_reason,
        COALESCE(s.hotspot_band,'LOW') hotspot_band,COALESCE(s.failures_90d,0) hotspot_failures_90d,COALESCE(s.sla_violations_90d,0) hotspot_sla_violations_90d
 FROM poles p JOIN junction_boxes j ON j.cabinet_id=p.cabinet_id JOIN wards w ON w.ward_id=j.ward_id JOIN zones z ON z.zone_id=w.zone_id
 LEFT JOIN health h ON h.pole_id=p.pole_id LEFT JOIN rel r ON r.pole_id=p.pole_id LEFT JOIN open_wo o ON o.pole_id=p.pole_id
 LEFT JOIN roots rt ON rt.pole_id=p.pole_id LEFT JOIN replacement rep ON rep.pole_id=p.pole_id
 LEFT JOIN LATERAL (SELECT s.hotspot_band,s.failures_90d,s.sla_violations_90d FROM spatial s WHERE p.geolocation IS NOT NULL AND ST_Intersects(p.geolocation::geometry,s.grid_cell) ORDER BY CASE s.hotspot_band WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END LIMIT 1) s ON TRUE
 WHERE p.current_status <> 'DECOMMISSIONED'
)
SELECT b.*,
 LEAST(100,ROUND((GREATEST(0,100-health_score)*0.30 + risk_score*0.25 + LEAST(sla_violations,5)*15 + LEAST(recurrence_count_90d,3)*5 + CASE hotspot_band WHEN 'CRITICAL' THEN 10 WHEN 'HIGH' THEN 7 WHEN 'MEDIUM' THEN 4 ELSE 0 END + CASE replacement_priority WHEN 'CRITICAL' THEN 10 WHEN 'HIGH' THEN 7 WHEN 'MEDIUM' THEN 4 ELSE 0 END),2)) AS priority_score,
 CASE
   WHEN sla_violations > 0 OR current_status IN ('FAULTY','DAY_BURN') THEN 'IMMEDIATE_REPAIR'
   WHEN replacement_priority IN ('CRITICAL','HIGH') AND open_work_orders=0 THEN 'REPLACEMENT_REVIEW'
   WHEN recurrence_count_90d >= 3 OR risk_score >= 70 THEN 'ROOT_CAUSE_REVIEW'
   WHEN hotspot_band IN ('CRITICAL','HIGH') THEN 'AREA_INSPECTION'
   WHEN sla_violations > 0 THEN 'SLA_ESCALATION'
   WHEN risk_score >= 50 OR health_score < 70 THEN 'MONITOR'
   ELSE 'MONITOR'
 END AS recommended_intervention_type,
 CASE
   WHEN sla_violations > 0 OR current_status IN ('FAULTY','DAY_BURN') THEN 'Immediate operational attention is recommended based on current fault/SLA signals.'
   WHEN replacement_priority IN ('CRITICAL','HIGH') AND open_work_orders=0 THEN 'Repeated failure or aging signals justify human review for capital replacement.'
   WHEN recurrence_count_90d >= 3 OR risk_score >= 70 THEN 'Recurring failures or elevated reliability risk justify root-cause review.'
   WHEN hotspot_band IN ('CRITICAL','HIGH') THEN 'Spatial concentration of failures warrants an area-level field inspection.'
   WHEN risk_score >= 50 OR health_score < 70 THEN 'Asset condition signals justify continued monitoring and planned inspection.'
   ELSE 'No immediate intervention signal; continue monitoring.'
 END AS recommendation
FROM base b;
