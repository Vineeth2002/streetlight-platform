-- 035_municipal_network_risk_intelligence.sql
-- Advisory municipal dependency/risk network layer.
-- This is NOT electrical circuit simulation: current topology guarantees cabinet -> pole
-- relationships and municipal hierarchy, not feeder/circuit connectivity.
-- It never changes pole state, work orders, SLA rules, penalties, or glow-rate formulas.

CREATE OR REPLACE VIEW v_municipal_network_risk_clusters AS
WITH asset AS (
  SELECT g.pole_id,g.pole_number,g.cabinet_id,g.zone_id,g.zone_name,g.ward_id,g.ward_number,
         g.road_name,g.contractor_id,g.contractor_name,g.current_status,
         g.asset_graph_risk_score,g.asset_graph_risk_band,g.correlation_pattern,
         g.systemic_correlation_score,g.failure_episodes_365d,g.sla_violations_365d,
         g.open_interventions
  FROM v_municipal_asset_risk_graph g
), dependency AS (
  SELECT cabinet_id,dependency_risk_score,
    CASE WHEN dependency_risk_score>=70 THEN 'CRITICAL'
         WHEN dependency_risk_score>=50 THEN 'HIGH'
         WHEN dependency_risk_score>=25 THEN 'MEDIUM' ELSE 'LOW' END AS dependency_risk_band
  FROM v_cabinet_dependency_intelligence
), enriched AS (
  SELECT a.*,COALESCE(d.dependency_risk_score,0) AS dependency_risk_score,
         COALESCE(d.dependency_risk_band,'LOW') AS dependency_risk_band
  FROM asset a LEFT JOIN dependency d ON d.cabinet_id=a.cabinet_id
), groups AS (
  SELECT 'CABINET'::varchar AS cluster_type,cabinet_id::varchar AS cluster_key,
         MAX(cabinet_id)::int AS cabinet_id,MAX(zone_id)::int AS zone_id,MAX(zone_name)::varchar AS zone_name,
         MAX(ward_id)::int AS ward_id,MAX(ward_number)::varchar AS ward_number,
         NULL::varchar AS road_name,NULL::int AS contractor_id,NULL::varchar AS contractor_name
  FROM enriched GROUP BY cabinet_id
  UNION ALL
  SELECT 'WARD',ward_id::varchar,NULL,MAX(zone_id),MAX(zone_name),ward_id,MAX(ward_number),NULL,NULL,NULL
  FROM enriched WHERE ward_id IS NOT NULL GROUP BY ward_id
  UNION ALL
  SELECT 'ZONE',zone_id::varchar,NULL,zone_id,MAX(zone_name),NULL,NULL,NULL,NULL,NULL
  FROM enriched WHERE zone_id IS NOT NULL GROUP BY zone_id
  UNION ALL
  SELECT 'ROAD',CONCAT(COALESCE(zone_id::varchar,'0'),'::',COALESCE(road_name,'UNNAMED')),
         NULL,MAX(zone_id),MAX(zone_name),NULL,NULL,road_name,NULL,NULL
  FROM enriched GROUP BY zone_id,road_name
  UNION ALL
  SELECT 'CONTRACTOR',contractor_id::varchar,NULL,MAX(zone_id),MAX(zone_name),NULL,NULL,NULL,contractor_id,MAX(contractor_name)
  FROM enriched WHERE contractor_id IS NOT NULL GROUP BY contractor_id
), metrics AS (
  SELECT g.*,COUNT(e.pole_id)::int AS assets,
         COUNT(*) FILTER(WHERE e.asset_graph_risk_band='CRITICAL')::int AS critical_assets,
         COUNT(*) FILTER(WHERE e.asset_graph_risk_band='HIGH')::int AS high_risk_assets,
         COUNT(*) FILTER(WHERE e.correlation_pattern='SYSTEMIC')::int AS systemic_assets,
         COUNT(*) FILTER(WHERE e.current_status IN ('FAULTY','NO_SIGNAL','UNDER_REPAIR'))::int AS affected_assets,
         SUM(e.sla_violations_365d)::int AS sla_violations_365d,
         SUM(e.failure_episodes_365d)::int AS failure_episodes_365d,
         ROUND(AVG(e.asset_graph_risk_score),2) AS avg_asset_risk,
         MAX(e.asset_graph_risk_score) AS max_asset_risk,
         ROUND(AVG(e.systemic_correlation_score),2) AS avg_correlation_score,
         ROUND(AVG(e.dependency_risk_score),2) AS avg_dependency_risk,
         MAX(e.dependency_risk_score) AS max_dependency_risk,
         SUM(e.open_interventions)::int AS open_interventions
  FROM groups g JOIN enriched e
    ON (g.cluster_type='CABINET' AND e.cabinet_id=g.cabinet_id)
    OR (g.cluster_type='WARD' AND e.ward_id=g.ward_id)
    OR (g.cluster_type='ZONE' AND e.zone_id=g.zone_id)
    OR (g.cluster_type='ROAD' AND CONCAT(COALESCE(e.zone_id::varchar,'0'),'::',COALESCE(e.road_name,'UNNAMED'))=g.cluster_key)
    OR (g.cluster_type='CONTRACTOR' AND e.contractor_id=g.contractor_id)
  GROUP BY g.cluster_type,g.cluster_key,g.cabinet_id,g.zone_id,g.zone_name,g.ward_id,g.ward_number,g.road_name,g.contractor_id,g.contractor_name
), scored AS (
  SELECT m.*,
    LEAST(100,ROUND(
      30*LEAST(1,m.avg_asset_risk/100.0)+
      20*LEAST(1,m.max_asset_risk/100.0)+
      15*LEAST(1,m.avg_correlation_score/100.0)+
      15*LEAST(1,m.max_dependency_risk/100.0)+
      10*LEAST(1,m.sla_violations_365d/5.0)+
      10*LEAST(1,(m.critical_assets+m.high_risk_assets)::numeric/NULLIF(m.assets,0)),2)) AS network_risk_score
  FROM metrics m
)
SELECT s.*,
  CASE WHEN s.network_risk_score>=80 OR s.systemic_assets>=3 OR s.sla_violations_365d>=5 THEN 'CRITICAL'
       WHEN s.network_risk_score>=60 OR s.systemic_assets>=2 OR s.sla_violations_365d>=3 THEN 'HIGH'
       WHEN s.network_risk_score>=35 OR s.systemic_assets>=1 OR s.sla_violations_365d>=1 THEN 'MEDIUM'
       ELSE 'LOW' END AS network_risk_band,
  CASE WHEN s.systemic_assets>=3 THEN 'SYSTEMIC_FAILURE_CONCENTRATION'
       WHEN s.sla_violations_365d>=5 THEN 'SLA_EXPOSURE_CONCENTRATION'
       WHEN s.critical_assets+s.high_risk_assets>=GREATEST(3,CEIL(s.assets*0.25)::int) THEN 'HIGH_RISK_ASSET_CONCENTRATION'
       WHEN s.affected_assets>=GREATEST(3,CEIL(s.assets*0.30)::int) THEN 'SHARED_DEPENDENCY_IMPACT'
       ELSE 'MULTI_SIGNAL_RISK' END AS dominant_network_signal
FROM scored s;

CREATE OR REPLACE VIEW v_municipal_network_risk_summary AS
SELECT cluster_type,COUNT(*)::int AS clusters,SUM(assets)::int AS assets,
       COUNT(*) FILTER(WHERE network_risk_band='CRITICAL')::int AS critical_clusters,
       COUNT(*) FILTER(WHERE network_risk_band='HIGH')::int AS high_risk_clusters,
       COUNT(*) FILTER(WHERE dominant_network_signal='SYSTEMIC_FAILURE_CONCENTRATION')::int AS systemic_clusters,
       ROUND(AVG(network_risk_score),2) AS avg_network_risk_score,
       MAX(network_risk_score) AS max_network_risk_score
FROM v_municipal_network_risk_clusters
GROUP BY cluster_type;

CREATE INDEX IF NOT EXISTS idx_wo_pole_contractor_reported
  ON work_orders(pole_id,contractor_id,reported_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_poles_road_status
  ON poles(road_name,current_status,pole_id);
