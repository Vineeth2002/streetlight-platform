-- 034_municipal_asset_risk_graph.sql
-- Advisory graph-style read model over existing municipal infrastructure relationships.
-- It never changes pole state, work orders, SLA rules, penalties, or glow-rate formulas.

CREATE OR REPLACE VIEW v_municipal_asset_risk_graph AS
WITH asset AS (
  SELECT p.pole_id,p.pole_number,p.cabinet_id,p.current_status,p.road_name,p.geolocation,
         jb.cabinet_serial_no,jb.nominal_voltage,jb.rated_capacity_kva,w.ward_id,w.ward_number,z.zone_id,z.zone_name
  FROM poles p LEFT JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id LEFT JOIN wards w ON w.ward_id=jb.ward_id LEFT JOIN zones z ON z.zone_id=w.zone_id
  WHERE p.current_status<>'DECOMMISSIONED'
), corr AS (SELECT * FROM v_failure_correlation_patterns), health AS (
  SELECT DISTINCT ON(pole_id) pole_id,health_score,health_band FROM asset_health_snapshots ORDER BY pole_id,as_of DESC
), reliability AS (
  SELECT DISTINCT ON(pole_id) pole_id,risk_score,risk_band FROM asset_reliability_snapshots ORDER BY pole_id,as_of DESC
), replacement AS (
  SELECT DISTINCT ON(pole_id) pole_id,
    CASE replacement_priority WHEN 'CRITICAL' THEN 100 WHEN 'HIGH' THEN 80 WHEN 'MEDIUM' THEN 60 ELSE 25 END AS replacement_priority_score,
    replacement_priority FROM v_asset_replacement_candidates
  ORDER BY pole_id,CASE replacement_priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END DESC
), interventions AS (
  SELECT pole_id,COUNT(*) FILTER(WHERE status IN ('RECOMMENDED','ACKNOWLEDGED','ASSIGNED','IN_PROGRESS'))::int AS open_interventions,
         MAX(priority_score) AS max_intervention_priority FROM municipal_interventions GROUP BY pole_id
)
SELECT a.*,COALESCE(c.correlation_pattern,'NONE') AS correlation_pattern,COALESCE(c.systemic_correlation_score,0) AS systemic_correlation_score,
       COALESCE(c.failure_episodes_365d,0) AS failure_episodes_365d,COALESCE(c.work_orders_365d,0) AS work_orders_365d,
       COALESCE(c.sla_violations_365d,0) AS sla_violations_365d,COALESCE(c.root_cause_category,'UNCLASSIFIED') AS root_cause_category,
       COALESCE(c.root_cause_code,'UNSPECIFIED') AS root_cause_code,c.contractor_id,c.contractor_name,
       COALESCE(c.ineffective_interventions,0) AS ineffective_interventions,COALESCE(c.partial_interventions,0) AS partial_interventions,
       COALESCE(c.effective_interventions,0) AS effective_interventions,h.health_score,h.health_band,
       CASE WHEN r.risk_score IS NULL THEN NULL ELSE GREATEST(0,LEAST(100,100-r.risk_score)) END AS reliability_score,
       r.risk_band AS reliability_risk_band,rp.replacement_priority_score,rp.replacement_priority,
       COALESCE(i.open_interventions,0) AS open_interventions,COALESCE(i.max_intervention_priority,0) AS max_intervention_priority,
       LEAST(100,ROUND(25*LEAST(1.0,GREATEST(0,100-COALESCE(h.health_score,50))/100.0)+20*LEAST(1.0,COALESCE(r.risk_score,50)/100.0)+20*LEAST(1.0,COALESCE(c.systemic_correlation_score,0)/100.0)+15*LEAST(1.0,COALESCE(c.sla_violations_365d,0)/3.0)+10*LEAST(1.0,COALESCE(i.open_interventions,0)/3.0)+10*LEAST(1.0,COALESCE(rp.replacement_priority_score,0)/100.0),2)) AS asset_graph_risk_score,
       CASE WHEN COALESCE(c.correlation_pattern,'NONE')='SYSTEMIC' OR COALESCE(c.sla_violations_365d,0)>=3 THEN 'CRITICAL'
            WHEN COALESCE(c.systemic_correlation_score,0)>=70 OR COALESCE(h.health_score,100)<40 OR COALESCE(r.risk_score,0)>=60 THEN 'HIGH'
            WHEN COALESCE(c.systemic_correlation_score,0)>=40 OR COALESCE(h.health_score,100)<70 OR COALESCE(r.risk_score,0)>=30 THEN 'MEDIUM' ELSE 'LOW' END AS asset_graph_risk_band
FROM asset a LEFT JOIN corr c ON c.pole_id=a.pole_id LEFT JOIN health h ON h.pole_id=a.pole_id LEFT JOIN reliability r ON r.pole_id=a.pole_id LEFT JOIN replacement rp ON rp.pole_id=a.pole_id LEFT JOIN interventions i ON i.pole_id=a.pole_id;

CREATE OR REPLACE VIEW v_municipal_asset_risk_graph_summary AS
SELECT zone_id,zone_name,COUNT(*)::int AS assets,COUNT(*) FILTER(WHERE asset_graph_risk_band='CRITICAL')::int AS critical_assets,
       COUNT(*) FILTER(WHERE asset_graph_risk_band='HIGH')::int AS high_risk_assets,COUNT(*) FILTER(WHERE asset_graph_risk_band='MEDIUM')::int AS medium_risk_assets,
       COUNT(*) FILTER(WHERE correlation_pattern='SYSTEMIC')::int AS systemic_assets,ROUND(AVG(asset_graph_risk_score),2) AS avg_graph_risk_score
FROM v_municipal_asset_risk_graph GROUP BY zone_id,zone_name;

CREATE INDEX IF NOT EXISTS idx_asset_health_snapshots_pole_date ON asset_health_snapshots(pole_id,as_of DESC);
CREATE INDEX IF NOT EXISTS idx_asset_reliability_snapshots_pole_date ON asset_reliability_snapshots(pole_id,as_of DESC);
CREATE INDEX IF NOT EXISTS idx_municipal_interventions_pole_status ON municipal_interventions(pole_id,status,priority_score DESC);
