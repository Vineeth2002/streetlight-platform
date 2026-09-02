-- 037_municipal_risk_temporal_intelligence.sql
-- Advisory temporal intelligence. It measures movement in existing health/reliability
-- signals; it never changes operational state, SLA rules, penalties, or glow-rate formulas.

CREATE OR REPLACE VIEW v_municipal_asset_risk_trends AS
WITH health_ranked AS (
  SELECT h.*,ROW_NUMBER() OVER (PARTITION BY h.pole_id ORDER BY h.as_of DESC) AS rn
  FROM asset_health_snapshots h
), rel_ranked AS (
  SELECT r.*,ROW_NUMBER() OVER (PARTITION BY r.pole_id ORDER BY r.as_of DESC) AS rn
  FROM asset_reliability_snapshots r
), paired AS (
  SELECT p.pole_id,p.pole_number,p.road_name,z.zone_id,z.zone_name,wd.ward_id,wd.ward_number,
         h1.as_of AS latest_health_at,h1.health_score AS latest_health_score,h1.health_band AS latest_health_band,
         h2.as_of AS previous_health_at,h2.health_score AS previous_health_score,
         r1.as_of AS latest_reliability_at,(100-COALESCE(r1.risk_score,50))::numeric AS latest_reliability_score,
         r1.risk_band AS latest_reliability_band,
         r2.as_of AS previous_reliability_at,(100-COALESCE(r2.risk_score,50))::numeric AS previous_reliability_score
  FROM poles p
  JOIN junction_boxes j ON j.cabinet_id=p.cabinet_id
  JOIN wards wd ON wd.ward_id=j.ward_id
  JOIN zones z ON z.zone_id=wd.zone_id
  LEFT JOIN health_ranked h1 ON h1.pole_id=p.pole_id AND h1.rn=1
  LEFT JOIN health_ranked h2 ON h2.pole_id=p.pole_id AND h2.rn=2
  LEFT JOIN rel_ranked r1 ON r1.pole_id=p.pole_id AND r1.rn=1
  LEFT JOIN rel_ranked r2 ON r2.pole_id=p.pole_id AND r2.rn=2
  WHERE p.current_status <> 'DECOMMISSIONED'
), scored AS (
  SELECT *,
    ROUND((COALESCE(latest_health_score,50)-COALESCE(previous_health_score,latest_health_score,50)),2) AS health_delta,
    ROUND((COALESCE(latest_reliability_score,50)-COALESCE(previous_reliability_score,latest_reliability_score,50)),2) AS reliability_delta
  FROM paired
)
SELECT *,
  ROUND((health_delta*0.60+reliability_delta*0.40),2) AS composite_delta,
  CASE
    WHEN latest_health_at IS NULL AND latest_reliability_at IS NULL THEN 'NO_HISTORY'
    WHEN (health_delta*0.60+reliability_delta*0.40) >= 8 THEN 'RISING'
    WHEN (health_delta*0.60+reliability_delta*0.40) <= -8 THEN 'IMPROVING'
    ELSE 'STABLE'
  END AS trend_direction,
  CASE
    WHEN COALESCE(latest_health_at,latest_reliability_at) >= NOW()-INTERVAL '14 days'
         AND COALESCE(previous_health_at,previous_reliability_at) IS NULL THEN 'NEW'
    WHEN (health_delta*0.60+reliability_delta*0.40) <= -8 THEN 'RECOVERING'
    WHEN latest_health_band IN ('POOR','CRITICAL') OR latest_reliability_band IN ('HIGH','CRITICAL') THEN 'PERSISTENT'
    ELSE 'RECENT'
  END AS trend_persistence
FROM scored;

CREATE OR REPLACE VIEW v_municipal_risk_temporal_clusters AS
WITH asset_trends AS (
  SELECT * FROM v_municipal_asset_risk_trends
), cluster_assets AS (
  SELECT 'ZONE'::varchar AS cluster_type,zone_id::varchar AS cluster_key,zone_id,ward_id,road_name,pole_id,trend_direction,trend_persistence,composite_delta,latest_health_score,latest_reliability_score FROM asset_trends
  UNION ALL
  SELECT 'WARD',ward_id::varchar,zone_id,ward_id,road_name,pole_id,trend_direction,trend_persistence,composite_delta,latest_health_score,latest_reliability_score FROM asset_trends
  UNION ALL
  SELECT 'ROAD',CONCAT(COALESCE(zone_id::varchar,'0'),'::',COALESCE(road_name,'UNNAMED')),zone_id,NULL,road_name,pole_id,trend_direction,trend_persistence,composite_delta,latest_health_score,latest_reliability_score FROM asset_trends
), aggregated AS (
  SELECT cluster_type,cluster_key,zone_id,ward_id,road_name,
         COUNT(*)::int AS assets,
         COUNT(*) FILTER (WHERE trend_direction='RISING')::int AS rising_assets,
         COUNT(*) FILTER (WHERE trend_direction='IMPROVING')::int AS improving_assets,
         COUNT(*) FILTER (WHERE trend_direction='STABLE')::int AS stable_assets,
         COUNT(*) FILTER (WHERE trend_direction='NEW')::int AS new_signal_assets,
         COUNT(*) FILTER (WHERE trend_persistence='PERSISTENT')::int AS persistent_assets,
         COUNT(*) FILTER (WHERE trend_persistence='RECOVERING')::int AS recovering_assets,
         ROUND(AVG(composite_delta),2) AS avg_composite_delta,
         ROUND(AVG(latest_health_score),2) AS avg_health_score,
         ROUND(AVG(latest_reliability_score),2) AS avg_reliability_score
  FROM cluster_assets GROUP BY cluster_type,cluster_key,zone_id,ward_id,road_name
)
SELECT a.*,
  CASE
    WHEN a.rising_assets >= GREATEST(3,CEIL(a.assets*0.25)::int) OR a.avg_composite_delta >= 8 THEN 'RISING'
    WHEN a.improving_assets >= GREATEST(3,CEIL(a.assets*0.25)::int) AND a.avg_composite_delta <= -8 THEN 'IMPROVING'
    WHEN a.persistent_assets >= GREATEST(3,CEIL(a.assets*0.50)::int) THEN 'PERSISTENT'
    ELSE 'STABLE'
  END AS cluster_trend_direction,
  CASE
    WHEN a.new_signal_assets >= GREATEST(3,CEIL(a.assets*0.20)::int) THEN 'EMERGING'
    WHEN a.recovering_assets >= GREATEST(3,CEIL(a.assets*0.20)::int) THEN 'RECOVERING'
    WHEN a.persistent_assets >= GREATEST(3,CEIL(a.assets*0.50)::int) THEN 'PERSISTENT'
    ELSE 'NORMAL'
  END AS cluster_temporal_state
FROM aggregated a;

CREATE OR REPLACE VIEW v_municipal_risk_temporal_command AS
SELECT c.*,n.command_risk_score,n.command_risk_band,n.recommended_review,n.dominant_network_signal,
  CASE
    WHEN c.cluster_trend_direction='RISING' AND n.command_risk_band IN ('HIGH','CRITICAL') THEN 'ESCALATING_PRIORITY'
    WHEN c.cluster_temporal_state='EMERGING' THEN 'NEWLY_EMERGING'
    WHEN c.cluster_trend_direction='IMPROVING' THEN 'IMPROVING'
    WHEN c.cluster_temporal_state='PERSISTENT' THEN 'PERSISTENT_RISK'
    ELSE 'STABLE_MONITORING'
  END AS temporal_priority_state,
  ROUND(LEAST(100,GREATEST(0,n.command_risk_score + GREATEST(-10,LEAST(10,c.avg_composite_delta)))),2) AS temporal_risk_score
FROM v_municipal_risk_temporal_clusters c
JOIN v_municipal_risk_command n ON n.cluster_type=c.cluster_type AND n.cluster_key=c.cluster_key;

CREATE INDEX IF NOT EXISTS idx_asset_health_temporal ON asset_health_snapshots(pole_id,as_of DESC,health_score);
CREATE INDEX IF NOT EXISTS idx_asset_reliability_temporal ON asset_reliability_snapshots(pole_id,as_of DESC,risk_score);
