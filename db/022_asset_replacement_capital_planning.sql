-- 022_asset_replacement_capital_planning.sql
-- Replacement planning is advisory and human-controlled. It does not alter
-- operational pole state, SLA rules, penalty formulas, or glow-rate calculations.

CREATE TABLE IF NOT EXISTS asset_replacement_plans (
    plan_id                  BIGSERIAL PRIMARY KEY,
    pole_id                  INT NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
    budget_id                BIGINT REFERENCES municipal_budgets(budget_id) ON DELETE SET NULL,
    priority                 VARCHAR(12) NOT NULL DEFAULT 'MEDIUM'
                             CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    proposed_replacement_date DATE,
    estimated_cost_inr       NUMERIC(16,2) CHECK (estimated_cost_inr >= 0),
    reason                   TEXT NOT NULL,
    status                   VARCHAR(15) NOT NULL DEFAULT 'PROPOSED'
                             CHECK (status IN ('PROPOSED','APPROVED','SCHEDULED','COMPLETED','DEFERRED','CANCELLED')),
    approved_by              INT REFERENCES users(user_id) ON DELETE SET NULL,
    approved_at              TIMESTAMPTZ,
    notes                    TEXT,
    metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by               INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replacement_plan_pole
    ON asset_replacement_plans(pole_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replacement_plan_priority_status
    ON asset_replacement_plans(priority, status, proposed_replacement_date);
CREATE INDEX IF NOT EXISTS idx_replacement_plan_budget
    ON asset_replacement_plans(budget_id, status);

CREATE OR REPLACE FUNCTION touch_asset_replacement_plan_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_replacement_plan_updated_at ON asset_replacement_plans;
CREATE TRIGGER trg_asset_replacement_plan_updated_at
BEFORE UPDATE ON asset_replacement_plans
FOR EACH ROW EXECUTE FUNCTION touch_asset_replacement_plan_updated_at();

CREATE OR REPLACE VIEW v_asset_replacement_candidates AS
WITH reliability AS (
    SELECT DISTINCT ON (ars.pole_id)
        ars.pole_id,
        ars.risk_score,
        ars.risk_band,
        ars.repair_count_90d,
        ars.repair_count_365d,
        ars.recurrence_count_90d,
        ars.mttr_hours_365d,
        ars.mtbf_hours_365d,
        ars.days_since_last_repair,
        ars.last_failure_at,
        ars.dominant_fault_category
    FROM asset_reliability_snapshots ars
    ORDER BY ars.pole_id, ars.as_of DESC
),
age_data AS (
    SELECT
        p.pole_id,
        CASE WHEN p.installation_date IS NOT NULL
             THEN GREATEST(EXTRACT(EPOCH FROM (NOW() - p.installation_date::timestamptz)) / 31557600.0,0)
        END AS asset_age_years
    FROM poles p
)
SELECT
    p.pole_id,
    p.pole_number,
    p.current_status,
    p.installation_date,
    p.last_maintenance,
    p.road_name,
    p.luminaire_wattage,
    j.nominal_voltage,
    j.rated_capacity_kva,
    w.ward_number,
    z.zone_id,
    z.zone_name,
    r.risk_score,
    r.risk_band,
    r.repair_count_90d,
    r.repair_count_365d,
    r.recurrence_count_90d,
    r.mttr_hours_365d,
    r.mtbf_hours_365d,
    r.days_since_last_repair,
    r.last_failure_at,
    r.dominant_fault_category,
    a.asset_age_years,
    wa.warranty_end,
    CASE WHEN wa.warranty_end IS NOT NULL AND wa.warranty_end >= NOW() THEN TRUE ELSE FALSE END AS under_warranty,
    COALESCE(open_orders.open_work_orders,0) AS open_work_orders,
    COALESCE(recent_repair.recent_repair_cost_inr,0) AS recent_repair_cost_inr,
    CASE
        WHEN COALESCE(r.risk_score,0) >= 85 OR COALESCE(r.recurrence_count_90d,0) >= 3 THEN 'CRITICAL'
        WHEN COALESCE(r.risk_score,0) >= 70 OR COALESCE(r.repair_count_365d,0) >= 5 THEN 'HIGH'
        WHEN COALESCE(r.risk_score,0) >= 50 OR COALESCE(r.repair_count_365d,0) >= 3 OR COALESCE(a.asset_age_years,0) >= 10 THEN 'MEDIUM'
        ELSE 'LOW'
    END AS replacement_priority,
    CASE
        WHEN COALESCE(r.risk_score,0) >= 85 OR COALESCE(r.recurrence_count_90d,0) >= 3 THEN 'High failure recurrence or critical reliability risk'
        WHEN COALESCE(r.risk_score,0) >= 70 OR COALESCE(r.repair_count_365d,0) >= 5 THEN 'High reliability risk or repeated annual repairs'
        WHEN COALESCE(r.risk_score,0) >= 50 OR COALESCE(r.repair_count_365d,0) >= 3 OR COALESCE(a.asset_age_years,0) >= 10 THEN 'Aging or repeated maintenance burden'
        ELSE 'No strong replacement signal'
    END AS replacement_reason
FROM poles p
LEFT JOIN reliability r ON r.pole_id=p.pole_id
LEFT JOIN age_data a ON a.pole_id=p.pole_id
LEFT JOIN junction_boxes j ON j.cabinet_id=p.cabinet_id
LEFT JOIN wards w ON w.ward_id=j.ward_id
LEFT JOIN zones z ON z.zone_id=w.zone_id
LEFT JOIN LATERAL (
    SELECT ca.warranty_end
    FROM contract_asset_assignments ca
    WHERE ca.pole_id=p.pole_id AND ca.assignment_status='ACTIVE'
    ORDER BY ca.warranty_end DESC NULLS LAST
    LIMIT 1
) wa ON TRUE
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS open_work_orders
    FROM work_orders wo
    WHERE wo.pole_id=p.pole_id
      AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
) open_orders ON TRUE
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(wo.penalty_deducted),0) AS recent_repair_cost_inr
    FROM work_orders wo
    WHERE wo.pole_id=p.pole_id
      AND wo.ticket_status='RESOLVED'
      AND wo.resolved_timestamp >= NOW() - INTERVAL '365 days'
) recent_repair ON TRUE
WHERE p.current_status <> 'DECOMMISSIONED';

CREATE INDEX IF NOT EXISTS idx_poles_installation_date ON poles(installation_date);
