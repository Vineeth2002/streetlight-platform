-- 038_municipal_risk_forecasting.sql
-- Advisory future-risk projection. This is deterministic trajectory projection,
-- not an autonomous operational decision engine. It never changes pole state,
-- SLA rules, penalties, glow-rate formulas, work orders, or payments.

CREATE OR REPLACE VIEW v_municipal_asset_risk_forecast AS
WITH history AS (
  SELECT t.*,GREATEST(EXTRACT(EPOCH FROM (t.latest_health_at-t.previous_health_at))/86400.0,1.0) AS health_interval_days,
         GREATEST(EXTRACT(EPOCH FROM (t.latest_reliability_at-t.previous_reliability_at))/86400.0,1.0) AS reliability_interval_days
  FROM v_municipal_asset_risk_trends t
), forecast AS (
  SELECT h.*,
    ROUND(GREATEST(0,LEAST(100,COALESCE(h.latest_health_score,50)+COALESCE(h.health_delta,0)/NULLIF(h.health_interval_days,0)*7)),2) AS health_score_7d,
    ROUND(GREATEST(0,LEAST(100,COALESCE(h.latest_health_score,50)+COALESCE(h.health_delta,0)/NULLIF(h.health_interval_days,0)*30)),2) AS health_score_30d,
    ROUND(GREATEST(0,LEAST(100,COALESCE(h.latest_reliability_score,50)+COALESCE(h.reliability_delta,0)/NULLIF(h.reliability_interval_days,0)*7)),2) AS reliability_score_7d,
    ROUND(GREATEST(0,LEAST(100,COALESCE(h.latest_reliability_score,50)+COALESCE(h.reliability_delta,0)/NULLIF(h.reliability_interval_days,0)*30)),2) AS reliability_score_30d
  FROM history h
)
SELECT f.*,
  ROUND((f.health_score_7d*0.60+f.reliability_score_7d*0.40),2) AS composite_score_7d,
  ROUND((f.health_score_30d*0.60+f.reliability_score_30d*0.40),2) AS composite_score_30d,
  CASE WHEN f.latest_health_at IS NULL AND f.latest_reliability_at IS NULL THEN 'INSUFFICIENT_HISTORY'
       WHEN f.health_interval_days > 45 OR f.reliability_interval_days > 45 THEN 'STALE_HISTORY'
       ELSE 'TRAJECTORY_BASED' END AS forecast_basis,
  CASE WHEN f.health_interval_days <= 7 AND f.reliability_interval_days <= 7 THEN 'MEDIUM'
       WHEN f.health_interval_days <= 30 OR f.reliability_interval_days <= 30 THEN 'LOW'
       ELSE 'VERY_LOW' END AS forecast_confidence,
  CASE WHEN f.health_score_30d <= 25 OR f.reliability_score_30d <= 25 THEN 'CRITICAL_EXPOSURE'
       WHEN f.health_score_30d <= 45 OR f.reliability_score_30d <= 45 THEN 'HIGH_EXPOSURE'
       WHEN f.health_score_30d <= 65 OR f.reliability_score_30d <= 65 THEN 'MEDIUM_EXPOSURE'
       ELSE 'LOW_EXPOSURE' END AS forecast_30d_exposure
FROM forecast f;

CREATE OR REPLACE VIEW v_municipal_risk_forecast_clusters AS
WITH assets AS (
  SELECT * FROM v_municipal_asset_risk_forecast
), cluster_assets AS (
  SELECT 'ZONE'::varchar AS cluster_type,zone_id::varchar AS cluster_key,zone_id,ward_id,road_name,pole_id,health_score_7d,health_score_30d,reliability_score_7d,reliability_score_30d,composite_score_7d,composite_score_30d,forecast_confidence,forecast_30d_exposure FROM assets
  UNION ALL
  SELECT 'WARD',ward_id::varchar,zone_id,ward_id,road_name,pole_id,health_score_7d,health_score_30d,reliability_score_7d,reliability_score_30d,composite_score_7d,composite_score_30d,forecast_confidence,forecast_30d_exposure FROM assets
  UNION ALL
  SELECT 'ROAD',CONCAT(COALESCE(zone_id::varchar,'0'),'::',COALESCE(road_name,'UNNAMED')),zone_id,NULL,road_name,pole_id,health_score_7d,health_score_30d,reliability_score_7d,reliability_score_30d,composite_score_7d,composite_score_30d,forecast_confidence,forecast_30d_exposure FROM assets
), grouped AS (
  SELECT cluster_type,cluster_key,zone_id,ward_id,road_name,COUNT(*)::int AS assets,
         ROUND(AVG(health_score_7d),2) AS avg_health_score_7d,ROUND(AVG(health_score_30d),2) AS avg_health_score_30d,
         ROUND(AVG(reliability_score_7d),2) AS avg_reliability_score_7d,ROUND(AVG(reliability_score_30d),2) AS avg_reliability_score_30d,
         ROUND(AVG(composite_score_7d),2) AS avg_composite_score_7d,ROUND(AVG(composite_score_30d),2) AS avg_composite_score_30d,
         COUNT(*) FILTER(WHERE forecast_30d_exposure='CRITICAL_EXPOSURE')::int AS critical_exposure_30d,
         COUNT(*) FILTER(WHERE forecast_30d_exposure='HIGH_EXPOSURE')::int AS high_exposure_30d,
         COUNT(*) FILTER(WHERE forecast_confidence='MEDIUM')::int AS medium_confidence_assets,
         COUNT(*) FILTER(WHERE forecast_confidence='LOW')::int AS low_confidence_assets
  FROM cluster_assets GROUP BY cluster_type,cluster_key,zone_id,ward_id,road_name
)
SELECT g.*,ROUND(g.avg_composite_score_30d-(g.avg_composite_score_7d),2) AS projected_7d_to_30d_delta,
  CASE WHEN g.critical_exposure_30d >= GREATEST(3,CEIL(g.assets*0.20)::int) THEN 'CRITICAL_EXPOSURE'
       WHEN g.high_exposure_30d >= GREATEST(3,CEIL(g.assets*0.25)::int) THEN 'HIGH_EXPOSURE'
       WHEN g.avg_composite_score_30d < 65 THEN 'MEDIUM_EXPOSURE'
       ELSE 'LOW_EXPOSURE' END AS forecast_30d_band,
  CASE WHEN g.avg_composite_score_30d < g.avg_composite_score_7d-8 THEN 'DETERIORATING'
       WHEN g.avg_composite_score_30d > g.avg_composite_score_7d+8 THEN 'IMPROVING'
       ELSE 'STABLE' END AS forecast_direction
FROM grouped g;

CREATE OR REPLACE VIEW v_municipal_risk_forecast_command AS
SELECT c.*,n.command_risk_score AS current_command_risk_score,n.command_risk_band AS current_command_risk_band,
       n.recommended_review,n.dominant_network_signal,
       ROUND(LEAST(100,GREATEST(0,n.command_risk_score + GREATEST(-20,LEAST(20,(65-c.avg_composite_score_30d)*0.60)))),2) AS forecast_command_risk_30d,
       CASE WHEN c.forecast_30d_band='CRITICAL_EXPOSURE' OR n.command_risk_band='CRITICAL' THEN 'CRITICAL'
            WHEN c.forecast_30d_band='HIGH_EXPOSURE' OR n.command_risk_band='HIGH' THEN 'HIGH'
            WHEN c.forecast_30d_band='MEDIUM_EXPOSURE' OR n.command_risk_band='MEDIUM' THEN 'MEDIUM'
            ELSE 'LOW' END AS forecast_command_band,
       CASE WHEN c.forecast_direction='DETERIORATING' AND n.command_risk_band IN ('HIGH','CRITICAL') THEN 'PREEMPTIVE_REVIEW'
            WHEN c.forecast_30d_band IN ('CRITICAL_EXPOSURE','HIGH_EXPOSURE') THEN 'FUTURE_RISK_REVIEW'
            WHEN c.forecast_direction='IMPROVING' THEN 'RECOVERY_TRAJECTORY'
            ELSE 'ROUTINE_FORECAST_MONITORING' END AS forecast_review_state
FROM v_municipal_risk_forecast_clusters c
JOIN v_municipal_risk_command n ON n.cluster_type=c.cluster_type AND n.cluster_key=c.cluster_key;

CREATE INDEX IF NOT EXISTS idx_asset_health_forecast_history ON asset_health_snapshots(pole_id,as_of DESC);
CREATE INDEX IF NOT EXISTS idx_asset_reliability_forecast_history ON asset_reliability_snapshots(pole_id,as_of DESC);
