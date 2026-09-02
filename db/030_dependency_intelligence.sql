-- 030_dependency_intelligence.sql
-- Advisory dependency intelligence. It identifies shared infrastructure patterns;
-- it never changes operational state, work orders, SLA rules, penalties, or glow-rate calculations.

CREATE OR REPLACE VIEW v_cabinet_dependency_intelligence AS
WITH asset_counts AS (
 SELECT jb.cabinet_id,jb.cabinet_serial_no,jb.nominal_voltage,jb.rated_capacity_kva,jb.installation_location,
        w.ward_id,w.ward_number,z.zone_id,z.zone_name,COUNT(p.pole_id)::int AS connected_assets,
        COUNT(*) FILTER(WHERE p.current_status='FAULTY')::int AS faulty_assets,
        COUNT(*) FILTER(WHERE p.current_status='NO_SIGNAL')::int AS no_signal_assets,
        COUNT(*) FILTER(WHERE p.current_status='UNDER_REPAIR')::int AS under_repair_assets
 FROM junction_boxes jb JOIN poles p ON p.cabinet_id=jb.cabinet_id
 LEFT JOIN wards w ON w.ward_id=jb.ward_id LEFT JOIN zones z ON z.zone_id=w.zone_id
 WHERE p.current_status<>'DECOMMISSIONED'
 GROUP BY jb.cabinet_id,jb.cabinet_serial_no,jb.nominal_voltage,jb.rated_capacity_kva,jb.installation_location,w.ward_id,w.ward_number,z.zone_id,z.zone_name
), work AS (
 SELECT p.cabinet_id,COUNT(DISTINCT wo.work_order_id) FILTER(WHERE wo.reported_timestamp>=NOW()-INTERVAL '365 days')::int AS work_orders_365d,
        COUNT(DISTINCT wo.work_order_id) FILTER(WHERE wo.reported_timestamp>=NOW()-INTERVAL '365 days' AND wo.ticket_status='SLA_VIOLATED')::int AS sla_violations_365d,
        COUNT(DISTINCT wo.contractor_id) FILTER(WHERE wo.reported_timestamp>=NOW()-INTERVAL '365 days' AND wo.contractor_id IS NOT NULL)::int AS contractors_365d
 FROM poles p LEFT JOIN work_orders wo ON wo.pole_id=p.pole_id GROUP BY p.cabinet_id
), causes AS (
 SELECT p.cabinet_id,COUNT(DISTINCT irc.root_cause_id)::int AS root_cause_events,
        COUNT(DISTINCT irc.cause_category)::int AS root_cause_categories,
        STRING_AGG(DISTINCT irc.cause_category,', ' ORDER BY irc.cause_category) AS observed_causes
 FROM poles p JOIN incident_root_causes irc ON irc.pole_id=p.pole_id
 WHERE irc.determined_at>=NOW()-INTERVAL '365 days' GROUP BY p.cabinet_id
)
SELECT a.*,COALESCE(w.work_orders_365d,0) work_orders_365d,COALESCE(w.sla_violations_365d,0) sla_violations_365d,
       COALESCE(w.contractors_365d,0) contractors_365d,COALESCE(c.root_cause_events,0) root_cause_events,
       COALESCE(c.root_cause_categories,0) root_cause_categories,COALESCE(c.observed_causes,'UNCLASSIFIED') observed_causes,
       ROUND(LEAST(100,(CASE WHEN a.connected_assets>=20 THEN 20 WHEN a.connected_assets>=10 THEN 12 ELSE 5 END)+
         CASE WHEN a.faulty_assets>=5 THEN 30 WHEN a.faulty_assets>=3 THEN 20 WHEN a.faulty_assets>=1 THEN 10 ELSE 0 END+
         CASE WHEN a.no_signal_assets>=5 THEN 20 WHEN a.no_signal_assets>=2 THEN 12 WHEN a.no_signal_assets>=1 THEN 5 ELSE 0 END+
         CASE WHEN COALESCE(w.sla_violations_365d,0)>=5 THEN 20 WHEN COALESCE(w.sla_violations_365d,0)>=2 THEN 12 WHEN COALESCE(w.sla_violations_365d,0)>=1 THEN 6 ELSE 0 END+
         CASE WHEN COALESCE(c.root_cause_categories,0)>=3 THEN 10 WHEN COALESCE(c.root_cause_categories,0)>=2 THEN 6 ELSE 0 END),2)) AS dependency_risk_score
FROM asset_counts a LEFT JOIN work w ON w.cabinet_id=a.cabinet_id LEFT JOIN causes c ON c.cabinet_id=a.cabinet_id;

CREATE INDEX IF NOT EXISTS idx_poles_cabinet_status ON poles(cabinet_id,current_status);
CREATE INDEX IF NOT EXISTS idx_wo_pole_reported_status ON work_orders(pole_id,reported_timestamp DESC,ticket_status);
