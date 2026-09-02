-- 031_network_topology_intelligence.sql
-- Advisory topology/read-model layer. It describes existing infrastructure relationships;
-- it never changes pole state, work orders, SLA rules, penalties, or glow-rate calculations.

CREATE OR REPLACE VIEW v_municipal_network_topology AS
SELECT z.zone_id,z.zone_name,w.ward_id,w.ward_number,
       jb.cabinet_id,jb.cabinet_serial_no,jb.nominal_voltage,jb.rated_capacity_kva,jb.installation_location,
       p.pole_id,p.pole_number,p.road_name,p.current_status,p.luminaire_wattage,p.node_id,p.geolocation,
       wo.work_order_id,wo.ticket_status AS work_order_status,wo.fault_category,wo.contractor_id,c.company_name AS contractor_name
FROM zones z
JOIN wards w ON w.zone_id=z.zone_id
JOIN junction_boxes jb ON jb.ward_id=w.ward_id
JOIN poles p ON p.cabinet_id=jb.cabinet_id AND p.current_status<>'DECOMMISSIONED'
LEFT JOIN LATERAL (
 SELECT work_order_id,ticket_status,fault_category,contractor_id FROM work_orders x
 WHERE x.pole_id=p.pole_id ORDER BY COALESCE(x.updated_at,x.created_at) DESC,x.work_order_id DESC LIMIT 1
) wo ON TRUE
LEFT JOIN contractors c ON c.contractor_id=wo.contractor_id;

CREATE OR REPLACE VIEW v_network_dependency_impact AS
WITH cabinet AS (
 SELECT cabinet_id,cabinet_serial_no,zone_id,zone_name,ward_id,ward_number,
        COUNT(*)::int AS connected_assets,
        COUNT(*) FILTER(WHERE current_status IN ('FAULTY','NO_SIGNAL','UNDER_REPAIR'))::int AS affected_assets,
        COUNT(*) FILTER(WHERE current_status='OPERATIONAL')::int AS operational_assets
 FROM v_municipal_network_topology
 GROUP BY cabinet_id,cabinet_serial_no,zone_id,zone_name,ward_id,ward_number
), scored AS (
 SELECT c.*,ROUND(100.0*c.affected_assets/NULLIF(c.connected_assets,0),2) AS affected_pct
 FROM cabinet c
)
SELECT s.*,CASE WHEN s.affected_assets>=5 OR(s.affected_assets>=3 AND s.affected_pct>=30) THEN 'HIGH'
 WHEN s.affected_assets>=2 OR(s.affected_assets>=1 AND s.affected_pct>=20) THEN 'MEDIUM' ELSE 'LOW' END AS dependency_impact_band
FROM scored s;

CREATE INDEX IF NOT EXISTS idx_junction_boxes_ward ON junction_boxes(ward_id,cabinet_id);
CREATE INDEX IF NOT EXISTS idx_poles_cabinet_node ON poles(cabinet_id,node_id);
