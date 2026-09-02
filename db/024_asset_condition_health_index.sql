-- 024_asset_condition_health_index.sql
-- Advisory health intelligence only. It never changes operational pole state,
-- SLA rules, penalty formulas, or glow-rate calculations.

CREATE TABLE IF NOT EXISTS asset_health_snapshots (
    snapshot_id BIGSERIAL PRIMARY KEY,
    pole_id INT NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
    as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operational_score NUMERIC(5,2) NOT NULL CHECK (operational_score BETWEEN 0 AND 100),
    reliability_score NUMERIC(5,2) NOT NULL CHECK (reliability_score BETWEEN 0 AND 100),
    maintenance_score NUMERIC(5,2) NOT NULL CHECK (maintenance_score BETWEEN 0 AND 100),
    telemetry_score NUMERIC(5,2) NOT NULL CHECK (telemetry_score BETWEEN 0 AND 100),
    warranty_score NUMERIC(5,2) NOT NULL CHECK (warranty_score BETWEEN 0 AND 100),
    health_score NUMERIC(5,2) NOT NULL CHECK (health_score BETWEEN 0 AND 100),
    health_band VARCHAR(12) NOT NULL CHECK (health_band IN ('EXCELLENT','GOOD','FAIR','POOR','CRITICAL')),
    factors JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_health_snapshot_day ON asset_health_snapshots(pole_id,(as_of::date));
CREATE INDEX IF NOT EXISTS idx_asset_health_band ON asset_health_snapshots(health_band,as_of DESC);
CREATE INDEX IF NOT EXISTS idx_asset_health_pole ON asset_health_snapshots(pole_id,as_of DESC);

CREATE OR REPLACE VIEW v_asset_health_index AS
WITH latest_rel AS (
 SELECT DISTINCT ON (pole_id) * FROM asset_reliability_snapshots ORDER BY pole_id,as_of DESC
), latest_tel AS (
 SELECT DISTINCT ON (nt.pole_number) nt.pole_number,nt.timestamp,nt.voltage_rms,nt.current_rms,nt.active_power,nt.power_factor,nt.temperature,nt.rssi
 FROM node_telemetry nt ORDER BY nt.pole_number,nt.timestamp DESC
), maintenance AS (
 SELECT p.pole_id,CASE WHEN p.last_maintenance IS NULL THEN 45 WHEN p.last_maintenance >= CURRENT_DATE-INTERVAL '180 days' THEN 100 WHEN p.last_maintenance >= CURRENT_DATE-INTERVAL '365 days' THEN 80 WHEN p.last_maintenance >= CURRENT_DATE-INTERVAL '730 days' THEN 60 ELSE 30 END AS maintenance_score FROM poles p
), warranty AS (
 SELECT p.pole_id,CASE WHEN ca.warranty_end IS NULL THEN 50 WHEN ca.warranty_end >= NOW() THEN 100 WHEN ca.warranty_end >= NOW()-INTERVAL '180 days' THEN 70 ELSE 40 END AS warranty_score FROM poles p LEFT JOIN LATERAL (SELECT warranty_end FROM contract_asset_assignments ca WHERE ca.pole_id=p.pole_id AND ca.assignment_status='ACTIVE' ORDER BY ca.warranty_end DESC NULLS LAST LIMIT 1) ca ON TRUE
), scored AS (
 SELECT p.pole_id,p.pole_number,p.current_status,p.road_name,z.zone_id,z.zone_name,
 CASE WHEN p.current_status='OPERATIONAL' THEN 100 WHEN p.current_status='UNDER_REPAIR' THEN 35 WHEN p.current_status='NO_SIGNAL' THEN 25 WHEN p.current_status='DAY_BURN' THEN 30 WHEN p.current_status='FAULTY' THEN 20 ELSE 0 END::numeric AS operational_score,
 COALESCE(100-COALESCE(r.risk_score,50),50)::numeric AS reliability_score,
 m.maintenance_score::numeric AS maintenance_score,
 CASE WHEN t.timestamp IS NULL THEN 50 WHEN t.timestamp < NOW()-INTERVAL '24 hours' THEN 25 WHEN t.power_factor IS NOT NULL AND t.power_factor >= 0.85 THEN 100 ELSE 65 END::numeric AS telemetry_score,
 w.warranty_score::numeric AS warranty_score,
 GREATEST(0,LEAST(100,ROUND((
 (CASE WHEN p.current_status='OPERATIONAL' THEN 100 WHEN p.current_status='UNDER_REPAIR' THEN 35 WHEN p.current_status='NO_SIGNAL' THEN 25 WHEN p.current_status='DAY_BURN' THEN 30 WHEN p.current_status='FAULTY' THEN 20 ELSE 0 END)*0.30+
 COALESCE((100-COALESCE(r.risk_score,50)),50)*0.30+m.maintenance_score*0.15+
 (CASE WHEN t.timestamp IS NULL THEN 50 WHEN t.timestamp < NOW()-INTERVAL '24 hours' THEN 25 WHEN t.power_factor IS NOT NULL AND t.power_factor >= 0.85 THEN 100 ELSE 65 END)*0.15+w.warranty_score*0.10-
 CASE WHEN EXISTS(SELECT 1 FROM work_orders wo WHERE wo.pole_id=p.pole_id AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')) THEN 10 ELSE 0 END
),2)))::numeric AS health_score,
 r.risk_score,r.risk_band,t.timestamp AS telemetry_at,
 (SELECT COUNT(*)::int FROM work_orders wo WHERE wo.pole_id=p.pole_id AND wo.reported_timestamp>=NOW()-INTERVAL '90 days') AS repair_count_90d,
 (SELECT COUNT(*)::int FROM work_orders wo WHERE wo.pole_id=p.pole_id AND wo.reported_timestamp>=NOW()-INTERVAL '365 days') AS repair_count_365d,
 (SELECT COUNT(*)::int FROM fault_episodes fe WHERE fe.pole_id=p.pole_id AND fe.first_detected_at>=NOW()-INTERVAL '90 days') AS recurrence_count_90d,
 (SELECT COUNT(*)::int FROM work_orders wo WHERE wo.pole_id=p.pole_id AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')) AS open_work_orders,
 (SELECT MAX(fe.last_observed_at) FROM fault_episodes fe WHERE fe.pole_id=p.pole_id) AS last_failure_at,
 (SELECT wo.fault_category FROM work_orders wo WHERE wo.pole_id=p.pole_id ORDER BY wo.reported_timestamp DESC LIMIT 1) AS dominant_fault_category,
 CASE WHEN EXISTS(SELECT 1 FROM work_orders wo WHERE wo.pole_id=p.pole_id AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')) THEN 10 ELSE 0 END AS open_work_order_penalty,
 m.maintenance_score AS _maintenance_score,w.warranty_score AS _warranty_score
 FROM poles p JOIN junction_boxes j ON j.cabinet_id=p.cabinet_id JOIN wards wd ON wd.ward_id=j.ward_id JOIN zones z ON z.zone_id=wd.zone_id
 LEFT JOIN latest_rel r ON r.pole_id=p.pole_id LEFT JOIN latest_tel t ON t.pole_number=p.pole_number LEFT JOIN maintenance m ON m.pole_id=p.pole_id LEFT JOIN warranty w ON w.pole_id=p.pole_id
 WHERE p.current_status <> 'DECOMMISSIONED'
)
SELECT pole_id,pole_number,current_status,road_name,zone_id,zone_name,operational_score,reliability_score,maintenance_score,telemetry_score,warranty_score,health_score,
 CASE WHEN health_score>=85 THEN 'EXCELLENT' WHEN health_score>=70 THEN 'GOOD' WHEN health_score>=50 THEN 'FAIR' WHEN health_score>=30 THEN 'POOR' ELSE 'CRITICAL' END AS health_band,
 risk_score,risk_band,telemetry_at,repair_count_90d,repair_count_365d,recurrence_count_90d,open_work_orders,last_failure_at,dominant_fault_category,open_work_order_penalty
FROM scored;
