-- 036_municipal_risk_command_layer.sql
-- Consolidated advisory decision layer for municipal risk operations.
-- It does not create, approve, assign, resolve, or cancel operational work.
-- It never changes pole state, SLA rules, penalties, or glow-rate formulas.

CREATE OR REPLACE VIEW v_municipal_risk_command AS
WITH network AS (
  SELECT * FROM v_municipal_network_risk_clusters
), warning_asset AS (
  SELECT v.pole_id,v.zone_id,v.ward_id,v.road_name,
         MAX(v.risk_score) AS max_warning_score,
         COUNT(*) FILTER(WHERE v.severity='CRITICAL')::int AS critical_warnings,
         COUNT(*) FILTER(WHERE v.severity='HIGH')::int AS high_warnings,
         COUNT(*) FILTER(WHERE v.severity IN ('CRITICAL','HIGH'))::int AS severe_warnings
  FROM v_municipal_early_warnings v
  GROUP BY v.pole_id,v.zone_id,v.ward_id,v.road_name
), warning_cluster AS (
  SELECT 'CABINET'::varchar AS cluster_type,p.cabinet_id::varchar AS cluster_key,
         MAX(a.max_warning_score) AS max_warning_score,SUM(a.critical_warnings)::int AS critical_warnings,
         SUM(a.high_warnings)::int AS high_warnings,SUM(a.severe_warnings)::int AS severe_warnings
  FROM warning_asset a JOIN poles p ON p.pole_id=a.pole_id GROUP BY p.cabinet_id
  UNION ALL
  SELECT 'WARD',ward_id::varchar,MAX(max_warning_score),SUM(critical_warnings)::int,SUM(high_warnings)::int,SUM(severe_warnings)::int
  FROM warning_asset WHERE ward_id IS NOT NULL GROUP BY ward_id
  UNION ALL
  SELECT 'ZONE',zone_id::varchar,MAX(max_warning_score),SUM(critical_warnings)::int,SUM(high_warnings)::int,SUM(severe_warnings)::int
  FROM warning_asset WHERE zone_id IS NOT NULL GROUP BY zone_id
  UNION ALL
  SELECT 'ROAD',CONCAT(COALESCE(zone_id::varchar,'0'),'::',COALESCE(road_name,'UNNAMED')),MAX(max_warning_score),
         SUM(critical_warnings)::int,SUM(high_warnings)::int,SUM(severe_warnings)::int
  FROM warning_asset GROUP BY zone_id,road_name
  UNION ALL
  SELECT 'CONTRACTOR',c.contractor_id::varchar,MAX(a.max_warning_score),SUM(a.critical_warnings)::int,
         SUM(a.high_warnings)::int,SUM(a.severe_warnings)::int
  FROM warning_asset a JOIN work_orders wo ON wo.pole_id=a.pole_id JOIN contractors c ON c.contractor_id=wo.contractor_id
  GROUP BY c.contractor_id
), combined AS (
  SELECT n.*,COALESCE(w.max_warning_score,0)::numeric AS max_warning_score,
         COALESCE(w.critical_warnings,0)::int AS critical_warnings,
         COALESCE(w.high_warnings,0)::int AS high_warnings,
         COALESCE(w.severe_warnings,0)::int AS severe_warnings
  FROM network n LEFT JOIN warning_cluster w ON w.cluster_type=n.cluster_type AND w.cluster_key=n.cluster_key
), scored AS (
  SELECT c.*,LEAST(100,ROUND(
      60*c.network_risk_score/100.0+
      20*c.max_warning_score/100.0+
      10*LEAST(1,c.severe_warnings/3.0)+
      10*LEAST(1,c.open_interventions/5.0),2)) AS command_risk_score
  FROM combined c
)
SELECT s.*,
  CASE WHEN s.command_risk_score>=80 OR s.critical_warnings>=3 THEN 'CRITICAL'
       WHEN s.command_risk_score>=60 OR s.critical_warnings>=1 OR s.network_risk_band='CRITICAL' THEN 'HIGH'
       WHEN s.command_risk_score>=35 OR s.high_warnings>=1 THEN 'MEDIUM'
       ELSE 'LOW' END AS command_risk_band,
  CASE WHEN s.critical_warnings>=1 AND s.systemic_assets>=1 THEN 'IMMEDIATE_SYSTEMIC_REVIEW'
       WHEN s.sla_violations_365d>=3 THEN 'SLA_EXPOSURE_REVIEW'
       WHEN s.systemic_assets>=2 THEN 'FAILURE_CORRELATION_REVIEW'
       WHEN s.max_dependency_risk>=60 THEN 'SHARED_DEPENDENCY_REVIEW'
       WHEN s.critical_assets+s.high_risk_assets>=GREATEST(3,CEIL(s.assets*0.25)::int) THEN 'ASSET_CONCENTRATION_REVIEW'
       WHEN s.open_interventions>=3 THEN 'INTERVENTION_BACKLOG_REVIEW'
       ELSE 'ROUTINE_MONITORING' END AS recommended_review
FROM scored s;

CREATE OR REPLACE VIEW v_municipal_risk_command_summary AS
SELECT cluster_type,COUNT(*)::int AS clusters,SUM(assets)::int AS assets,
       COUNT(*) FILTER(WHERE command_risk_band='CRITICAL')::int AS critical_clusters,
       COUNT(*) FILTER(WHERE command_risk_band='HIGH')::int AS high_risk_clusters,
       COUNT(*) FILTER(WHERE recommended_review<>'ROUTINE_MONITORING')::int AS review_clusters,
       SUM(critical_warnings)::int AS critical_warnings,SUM(severe_warnings)::int AS severe_warnings,
       ROUND(AVG(command_risk_score),2) AS avg_command_risk_score,
       MAX(command_risk_score) AS max_command_risk_score
FROM v_municipal_risk_command
GROUP BY cluster_type;

CREATE INDEX IF NOT EXISTS idx_work_orders_contractor_pole
  ON work_orders(contractor_id,pole_id);
