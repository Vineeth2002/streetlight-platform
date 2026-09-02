-- 024_asset_health_index.sql
-- Explainable advisory health index. Does not alter pole status, SLA, penalties, or glow-rate calculations.

CREATE TABLE IF NOT EXISTS asset_health_snapshots (
    health_snapshot_id BIGSERIAL PRIMARY KEY,
    pole_id INT NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
    as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    health_score NUMERIC(6,2) NOT NULL CHECK (health_score BETWEEN 0 AND 100),
    health_band VARCHAR(12) NOT NULL CHECK (health_band IN ('EXCELLENT','GOOD','FAIR','POOR','CRITICAL')),
    reliability_component NUMERIC(6,2) NOT NULL,
    operational_component NUMERIC(6,2) NOT NULL,
    maintenance_component NUMERIC(6,2) NOT NULL,
    telemetry_component NUMERIC(6,2) NOT NULL,
    warranty_component NUMERIC(6,2) NOT NULL,
    factors JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_health_pole_time
    ON asset_health_snapshots(pole_id, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_asset_health_band_time
    ON asset_health_snapshots(health_band, as_of DESC);

CREATE OR REPLACE VIEW v_asset_health_index AS
WITH latest_reliability AS (
    SELECT DISTINCT ON (pole_id)
        pole_id, risk_score, risk_band, repair_count_90d, repair_count_365d,
        recurrence_count_90d, mttr_hours_365d, mtbf_hours_365d, days_since_last_repair,
        last_failure_at, dominant_fault_category
    FROM asset_reliability_snapshots
    ORDER BY pole_id, as_of DESC
),
latest_telemetry AS (
    SELECT DISTINCT ON (pole_number)
        pole_number, timestamp, voltage_rms, current_rms, active_power,
        power_factor, temperature, rssi
    FROM node_telemetry
    ORDER BY pole_number, timestamp DESC
),
maintenance AS (
    SELECT
        p.pole_id,
        CASE
            WHEN p.last_maintenance IS NULL THEN 55.0
            WHEN p.last_maintenance >= CURRENT_DATE - INTERVAL '180 days' THEN 100.0
            WHEN p.last_maintenance >= CURRENT_DATE - INTERVAL '365 days' THEN 85.0
            WHEN p.last_maintenance >= CURRENT_DATE - INTERVAL '730 days' THEN 65.0
            ELSE 40.0
        END AS maintenance_component,
        CASE
            WHEN p.installation_date IS NULL THEN 70.0
            WHEN p.installation_date >= CURRENT_DATE - INTERVAL '5 years' THEN 100.0
            WHEN p.installation_date >= CURRENT_DATE - INTERVAL '10 years' THEN 80.0
            WHEN p.installation_date >= CURRENT_DATE - INTERVAL '15 years' THEN 60.0
            ELSE 40.0
        END AS age_component
    FROM poles p
),
warranty AS (
    SELECT DISTINCT ON (pole_id)
        pole_id, warranty_end
    FROM contract_asset_assignments
    WHERE assignment_status='ACTIVE'
    ORDER BY pole_id, warranty_end DESC NULLS LAST
),
open_orders AS (
    SELECT pole_id, COUNT(*)::int AS open_work_orders
    FROM work_orders
    WHERE ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
    GROUP BY pole_id
),
components AS (
    SELECT
        p.pole_id, p.pole_number, p.current_status, p.installation_date, p.last_maintenance,
        p.road_name, p.luminaire_wattage, z.zone_id, z.zone_name, w.ward_id, w.ward_number,
        COALESCE(r.risk_score, 0) AS risk_score,
        COALESCE(r.risk_band, 'LOW') AS risk_band,
        COALESCE(r.repair_count_90d,0) AS repair_count_90d,
        COALESCE(r.repair_count_365d,0) AS repair_count_365d,
        COALESCE(r.recurrence_count_90d,0) AS recurrence_count_90d,
        r.mttr_hours_365d, r.mtbf_hours_365d, r.days_since_last_repair,
        r.last_failure_at, r.dominant_fault_category,
        m.maintenance_component,
        m.age_component,
        CASE p.current_status
            WHEN 'OPERATIONAL' THEN 100.0
            WHEN 'FAULTY' THEN 45.0
            WHEN 'UNDER_REPAIR' THEN 35.0
            WHEN 'DAY_BURN' THEN 50.0
            WHEN 'NO_SIGNAL' THEN 55.0
            ELSE 0.0
        END AS operational_component,
        CASE
            WHEN t.timestamp IS NULL THEN 50.0
            WHEN t.timestamp < NOW() - INTERVAL '24 hours' THEN 45.0
            WHEN t.power_factor IS NOT NULL AND t.power_factor < 0.70 THEN 55.0
            WHEN t.voltage_rms IS NOT NULL AND (t.voltage_rms < 180 OR t.voltage_rms > 260) THEN 55.0
            WHEN t.temperature IS NOT NULL AND t.temperature > 85 THEN 55.0
            ELSE 100.0
        END AS telemetry_component,
        CASE
            WHEN wa.warranty_end IS NULL THEN 70.0
            WHEN wa.warranty_end >= NOW() THEN 100.0
            WHEN wa.warranty_end >= NOW() - INTERVAL '365 days' THEN 65.0
            ELSE 50.0
        END AS warranty_component,
        COALESCE(oo.open_work_orders,0) AS open_work_orders,
        t.timestamp AS telemetry_at, t.voltage_rms, t.current_rms, t.active_power,
        t.power_factor, t.temperature, t.rssi,
        wa.warranty_end
    FROM poles p
    JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id
    JOIN wards w ON w.ward_id=jb.ward_id
    JOIN zones z ON z.zone_id=w.zone_id
    LEFT JOIN latest_reliability r ON r.pole_id=p.pole_id
    LEFT JOIN latest_telemetry t ON t.pole_number=p.pole_number
    LEFT JOIN maintenance m ON m.pole_id=p.pole_id
    LEFT JOIN warranty wa ON wa.pole_id=p.pole_id
    LEFT JOIN open_orders oo ON oo.pole_id=p.pole_id
    WHERE p.current_status <> 'DECOMMISSIONED'
)
SELECT *,
    ROUND(GREATEST(0, LEAST(100,
        operational_component * 0.30
        + (100 - risk_score) * 0.30
        + maintenance_component * 0.15
        + telemetry_component * 0.15
        + warranty_component * 0.10
        - LEAST(open_work_orders * 5, 20)
    )),2) AS health_score,
    CASE
        WHEN (operational_component * 0.30 + (100-risk_score)*0.30 + maintenance_component*0.15 + telemetry_component*0.15 + warranty_component*0.10 - LEAST(open_work_orders*5,20)) >= 85 THEN 'EXCELLENT'
        WHEN (operational_component * 0.30 + (100-risk_score)*0.30 + maintenance_component*0.15 + telemetry_component*0.15 + warranty_component*0.10 - LEAST(open_work_orders*5,20)) >= 70 THEN 'GOOD'
        WHEN (operational_component * 0.30 + (100-risk_score)*0.30 + maintenance_component*0.15 + telemetry_component*0.15 + warranty_component*0.10 - LEAST(open_work_orders*5,20)) >= 50 THEN 'FAIR'
        WHEN (operational_component * 0.30 + (100-risk_score)*0.30 + maintenance_component*0.15 + telemetry_component*0.15 + warranty_component*0.10 - LEAST(open_work_orders*5,20)) >= 30 THEN 'POOR'
        ELSE 'CRITICAL'
    END AS health_band
FROM components;
