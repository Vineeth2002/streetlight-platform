-- 023_spatial_infrastructure_intelligence.sql
-- Spatial intelligence is an advisory read model. It does not alter operational
-- asset state, SLA rules, penalty formulas, or glow-rate calculations.

CREATE OR REPLACE VIEW v_spatial_failure_hotspots AS
WITH base AS (
    SELECT
        p.pole_id,
        p.pole_number,
        p.road_name,
        p.current_status,
        p.geolocation,
        w.ward_id,
        w.ward_number,
        z.zone_id,
        z.zone_name,
        COUNT(wo.work_order_id) FILTER (
            WHERE wo.reported_timestamp >= NOW() - INTERVAL '90 days'
        )::int AS failures_90d,
        COUNT(wo.work_order_id) FILTER (
            WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
        )::int AS open_work_orders,
        COUNT(wo.work_order_id) FILTER (
            WHERE wo.ticket_status='SLA_VIOLATED'
        )::int AS sla_violations_90d
    FROM poles p
    LEFT JOIN junction_boxes j ON j.cabinet_id=p.cabinet_id
    LEFT JOIN wards w ON w.ward_id=j.ward_id
    LEFT JOIN zones z ON z.zone_id=w.zone_id
    LEFT JOIN work_orders wo
      ON wo.pole_id=p.pole_id
     AND wo.reported_timestamp >= NOW() - INTERVAL '90 days'
    WHERE p.current_status <> 'DECOMMISSIONED'
    GROUP BY p.pole_id,p.pole_number,p.road_name,p.current_status,p.geolocation,
             w.ward_id,w.ward_number,z.zone_id,z.zone_name
), grid AS (
    SELECT
        ST_SnapToGrid(geolocation::geometry, 0.0025) AS grid_cell,
        zone_id,zone_name,ward_id,ward_number,
        COUNT(*)::int AS asset_count,
        SUM(failures_90d)::int AS failures_90d,
        SUM(open_work_orders)::int AS open_work_orders,
        SUM(sla_violations_90d)::int AS sla_violations_90d,
        COUNT(*) FILTER (WHERE current_status='FAULTY')::int AS faulty_assets,
        COUNT(*) FILTER (WHERE current_status='NO_SIGNAL')::int AS no_signal_assets
    FROM base
    WHERE geolocation IS NOT NULL
    GROUP BY ST_SnapToGrid(geolocation::geometry, 0.0025),zone_id,zone_name,ward_id,ward_number
)
SELECT
    grid_cell,
    ST_Centroid(grid_cell) AS centroid,
    zone_id,zone_name,ward_id,ward_number,
    asset_count,failures_90d,open_work_orders,sla_violations_90d,
    faulty_assets,no_signal_assets,
    CASE
      WHEN failures_90d >= 10 OR sla_violations_90d >= 5 THEN 'CRITICAL'
      WHEN failures_90d >= 5 OR sla_violations_90d >= 3 THEN 'HIGH'
      WHEN failures_90d >= 2 OR faulty_assets >= 2 THEN 'MEDIUM'
      ELSE 'LOW'
    END AS hotspot_band
FROM grid;

CREATE INDEX IF NOT EXISTS idx_work_orders_pole_reported_spatial
    ON work_orders(pole_id, reported_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_poles_geolocation_spatial
    ON poles USING GIST(geolocation);

CREATE OR REPLACE VIEW v_spatial_road_intelligence AS
SELECT
    z.zone_id,z.zone_name,w.ward_id,w.ward_number,
    p.road_name,
    COUNT(DISTINCT p.pole_id)::int AS asset_count,
    COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.reported_timestamp >= NOW()-INTERVAL '90 days')::int AS failures_90d,
    COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED'))::int AS open_work_orders,
    COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.ticket_status='SLA_VIOLATED' AND wo.reported_timestamp >= NOW()-INTERVAL '90 days')::int AS sla_violations_90d,
    COUNT(DISTINCT p.pole_id) FILTER (WHERE p.current_status='FAULTY')::int AS faulty_assets
FROM poles p
LEFT JOIN junction_boxes j ON j.cabinet_id=p.cabinet_id
LEFT JOIN wards w ON w.ward_id=j.ward_id
LEFT JOIN zones z ON z.zone_id=w.zone_id
LEFT JOIN work_orders wo ON wo.pole_id=p.pole_id
WHERE p.current_status <> 'DECOMMISSIONED'
  AND NULLIF(TRIM(p.road_name),'') IS NOT NULL
GROUP BY z.zone_id,z.zone_name,w.ward_id,w.ward_number,p.road_name;
