-- Health band hardening: derive band from the exact health_score thresholds.
CREATE OR REPLACE VIEW v_asset_health_index AS
WITH base AS (
 SELECT p.pole_id,p.pole_number,p.current_status,p.road_name,z.zone_id,z.zone_name,
 CASE WHEN p.current_status='OPERATIONAL' THEN 100 WHEN p.current_status='UNDER_REPAIR' THEN 35 WHEN p.current_status='NO_SIGNAL' THEN 25 WHEN p.current_status='DAY_BURN' THEN 30 WHEN p.current_status='FAULTY' THEN 20 ELSE 0 END::numeric AS operational_score,
 COALESCE(100-COALESCE(r.risk_score,50),50)::numeric AS reliability_score,
 m.maintenance_score::numeric AS maintenance_score,
 CASE WHEN t.timestamp IS NULL THEN 50 WHEN t.timestamp < NOW()-INTERVAL '24 hours' THEN 25 WHEN t.power_factor IS NOT NULL AND t.power_factor >= 0.85 THEN 100 ELSE 65 END::numeric AS telemetry_score,
 w.warranty_score::numeric AS warranty_score,
 r.risk_score,r.risk_band,t.timestamp AS telemetry_at
 FROM poles p JOIN junction_boxes j ON j.cabinet_id=p.cabinet_id JOIN wards wd ON wd.ward_id=j.ward_id JOIN zones z ON z.zone_id=wd.zone_id
 LEFT JOIN (SELECT DISTINCT ON (pole_id) * FROM asset_reliability_snapshots ORDER BY pole_id,as_of DESC) r ON r.pole_id=p.pole_id
 LEFT JOIN (SELECT DISTINCT ON (pole_number) pole_number,timestamp,power_factor FROM node_telemetry ORDER BY pole_number,timestamp DESC) t ON t.pole_number=p.pole_number
 LEFT JOIN (SELECT p2.pole_id,CASE WHEN p2.last_maintenance IS NULL THEN 45 WHEN p2.last_maintenance >= CURRENT_DATE-INTERVAL '180 days' THEN 100 WHEN p2.last_maintenance >= CURRENT_DATE-INTERVAL '365 days' THEN 80 WHEN p2.last_maintenance >= CURRENT_DATE-INTERVAL '730 days' THEN 60 ELSE 30 END AS maintenance_score FROM poles p2) m ON m.pole_id=p.pole_id
 LEFT JOIN (SELECT p3.pole_id,CASE WHEN ca.warranty_end IS NULL THEN 50 WHEN ca.warranty_end >= NOW() THEN 100 WHEN ca.warranty_end >= NOW()-INTERVAL '180 days' THEN 70 ELSE 40 END AS warranty_score FROM poles p3 LEFT JOIN LATERAL (SELECT warranty_end FROM contract_asset_assignments ca WHERE ca.pole_id=p3.pole_id AND ca.assignment_status='ACTIVE' ORDER BY ca.warranty_end DESC NULLS LAST LIMIT 1) ca ON TRUE) w ON w.pole_id=p.pole_id
 WHERE p.current_status <> 'DECOMMISSIONED'
), scored AS (
 SELECT base.*,
 GREATEST(0,LEAST(100,ROUND((operational_score*0.30+reliability_score*0.30+maintenance_score*0.15+telemetry_score*0.15+warranty_score*0.10-CASE WHEN EXISTS(SELECT 1 FROM work_orders wo WHERE wo.pole_id=base.pole_id AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')) THEN 10 ELSE 0 END),2)))::numeric AS health_score,
 (SELECT COUNT(*)::int FROM work_orders wo WHERE wo.pole_id=base.pole_id AND wo.reported_timestamp>=NOW()-INTERVAL '90 days') AS repair_count_90d,
 (SELECT COUNT(*)::int FROM work_orders wo WHERE wo.pole_id=base.pole_id AND wo.reported_timestamp>=NOW()-INTERVAL '365 days') AS repair_count_365d,
 (SELECT COUNT(*)::int FROM fault_episodes fe WHERE fe.pole_id=base.pole_id AND fe.first_detected_at>=NOW()-INTERVAL '90 days') AS recurrence_count_90d,
 (SELECT COUNT(*)::int FROM work_orders wo WHERE wo.pole_id=base.pole_id AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')) AS open_work_orders,
 (SELECT MAX(fe.last_observed_at) FROM fault_episodes fe WHERE fe.pole_id=base.pole_id) AS last_failure_at,
 (SELECT wo.fault_category FROM work_orders wo WHERE wo.pole_id=base.pole_id ORDER BY wo.reported_timestamp DESC LIMIT 1) AS dominant_fault_category,
 CASE WHEN EXISTS(SELECT 1 FROM work_orders wo WHERE wo.pole_id=base.pole_id AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')) THEN 10 ELSE 0 END AS open_work_order_penalty
 FROM base
)
SELECT scored.*,
 CASE WHEN health_score>=85 THEN 'EXCELLENT' WHEN health_score>=70 THEN 'GOOD' WHEN health_score>=50 THEN 'FAIR' WHEN health_score>=30 THEN 'POOR' ELSE 'CRITICAL' END AS health_band
FROM scored;
