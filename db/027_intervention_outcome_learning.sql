-- 027_intervention_outcome_learning.sql
-- Closed-loop learning only. Measurements never alter operational pole state,
-- SLA rules, penalty formulas, glow-rate calculations, or work-order status.

CREATE TABLE IF NOT EXISTS intervention_outcome_measurements (
    measurement_id BIGSERIAL PRIMARY KEY,
    intervention_id BIGINT NOT NULL REFERENCES municipal_interventions(intervention_id) ON DELETE CASCADE,
    pole_id INT REFERENCES poles(pole_id) ON DELETE SET NULL,
    outcome VARCHAR(15) NOT NULL CHECK (outcome IN ('EFFECTIVE','PARTIAL','INEFFECTIVE','UNMEASURED')),
    measurement_source VARCHAR(15) NOT NULL DEFAULT 'AUTOMATED' CHECK (measurement_source IN ('AUTOMATED','HUMAN')),
    observation_window_days INT NOT NULL DEFAULT 30 CHECK (observation_window_days BETWEEN 1 AND 3650),
    recurrence_count INT NOT NULL DEFAULT 0 CHECK (recurrence_count >= 0),
    work_order_status VARCHAR(30),
    verification_result VARCHAR(15),
    asset_status VARCHAR(30),
    measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes TEXT,
    measured_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intervention_outcome_intervention ON intervention_outcome_measurements(intervention_id,measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_intervention_outcome_pole ON intervention_outcome_measurements(pole_id,measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_intervention_outcome_type ON intervention_outcome_measurements(outcome,measured_at DESC);

CREATE OR REPLACE VIEW v_intervention_latest_outcomes AS
SELECT DISTINCT ON (iom.intervention_id)
    iom.intervention_id,iom.measurement_id,iom.pole_id,iom.outcome,iom.measurement_source,
    iom.observation_window_days,iom.recurrence_count,iom.work_order_status,iom.verification_result,
    iom.asset_status,iom.measured_at,iom.evidence,iom.notes,iom.measured_by,
    mi.intervention_type,mi.priority,mi.priority_score,mi.status AS intervention_status
FROM intervention_outcome_measurements iom
JOIN municipal_interventions mi ON mi.intervention_id=iom.intervention_id
ORDER BY iom.intervention_id,iom.measured_at DESC,iom.measurement_id DESC;

CREATE OR REPLACE VIEW v_intervention_learning_summary AS
SELECT
    mi.intervention_type,
    COUNT(*) FILTER (WHERE lo.outcome='EFFECTIVE')::int AS effective_count,
    COUNT(*) FILTER (WHERE lo.outcome='PARTIAL')::int AS partial_count,
    COUNT(*) FILTER (WHERE lo.outcome='INEFFECTIVE')::int AS ineffective_count,
    COUNT(*) FILTER (WHERE lo.outcome='UNMEASURED')::int AS unmeasured_count,
    COUNT(lo.measurement_id)::int AS measured_interventions,
    CASE WHEN COUNT(lo.measurement_id) FILTER (WHERE lo.outcome IN ('EFFECTIVE','PARTIAL','INEFFECTIVE'))=0 THEN NULL
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE lo.outcome='EFFECTIVE') /
              COUNT(*) FILTER (WHERE lo.outcome IN ('EFFECTIVE','PARTIAL','INEFFECTIVE')),2) END AS effectiveness_rate
FROM municipal_interventions mi
LEFT JOIN v_intervention_latest_outcomes lo ON lo.intervention_id=mi.intervention_id
GROUP BY mi.intervention_type;
