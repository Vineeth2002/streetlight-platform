-- 043_municipal_program_outcome_benefits_intelligence.sql
-- Measures whether governed municipal programs produced observable benefits.
-- This layer is evidence-oriented and advisory: it never closes programs,
-- changes asset/work-order state, recalculates SLA/penalties, or changes glow rates.

CREATE TABLE IF NOT EXISTS municipal_program_outcome_assessments (
    assessment_id BIGSERIAL PRIMARY KEY,
    program_id BIGINT NOT NULL REFERENCES municipal_programs(program_id) ON DELETE CASCADE,
    observation_window_days INT NOT NULL DEFAULT 30 CHECK (observation_window_days BETWEEN 1 AND 3650),
    expected_benefit_score NUMERIC(6,2) CHECK (expected_benefit_score BETWEEN 0 AND 100),
    baseline_health_score NUMERIC(6,2) CHECK (baseline_health_score BETWEEN 0 AND 100),
    observed_health_score NUMERIC(6,2) CHECK (observed_health_score BETWEEN 0 AND 100),
    baseline_reliability_score NUMERIC(6,2) CHECK (baseline_reliability_score BETWEEN 0 AND 100),
    observed_reliability_score NUMERIC(6,2) CHECK (observed_reliability_score BETWEEN 0 AND 100),
    baseline_open_work_orders INT CHECK (baseline_open_work_orders >= 0),
    observed_open_work_orders INT CHECK (observed_open_work_orders >= 0),
    baseline_sla_exposure INT CHECK (baseline_sla_exposure >= 0),
    observed_sla_exposure INT CHECK (observed_sla_exposure >= 0),
    baseline_penalty_inr NUMERIC(16,2) CHECK (baseline_penalty_inr >= 0),
    observed_penalty_inr NUMERIC(16,2) CHECK (observed_penalty_inr >= 0),
    measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    evidence_uri TEXT,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes TEXT,
    assessed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_program_outcome_program_date
  ON municipal_program_outcome_assessments(program_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_program_outcome_assessed_by
  ON municipal_program_outcome_assessments(assessed_by, measured_at DESC);

CREATE OR REPLACE VIEW v_municipal_program_outcome_benefits AS
WITH latest AS (
  SELECT DISTINCT ON (po.program_id) po.*, p.program_type,p.program_key,p.zone_id,p.title,p.status,p.priority_score
  FROM municipal_program_outcome_assessments po
  JOIN municipal_programs p ON p.program_id=po.program_id
  ORDER BY po.program_id,po.measured_at DESC,po.assessment_id DESC
), metrics AS (
  SELECT l.*,
    (CASE WHEN l.baseline_health_score IS NOT NULL AND l.observed_health_score IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN l.baseline_reliability_score IS NOT NULL AND l.observed_reliability_score IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN l.baseline_open_work_orders IS NOT NULL AND l.observed_open_work_orders IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN l.baseline_sla_exposure IS NOT NULL AND l.observed_sla_exposure IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN l.baseline_penalty_inr IS NOT NULL AND l.observed_penalty_inr IS NOT NULL THEN 1 ELSE 0 END) AS measured_metric_count,
    COALESCE(l.observed_health_score-l.baseline_health_score,0) AS health_delta,
    COALESCE(l.observed_reliability_score-l.baseline_reliability_score,0) AS reliability_delta,
    COALESCE(l.baseline_open_work_orders-l.observed_open_work_orders,0) AS work_order_reduction,
    COALESCE(l.baseline_sla_exposure-l.observed_sla_exposure,0) AS sla_reduction,
    COALESCE(l.baseline_penalty_inr-l.observed_penalty_inr,0) AS penalty_reduction_inr
  FROM latest l
)
SELECT m.*,
  ROUND(LEAST(100,GREATEST(0,
    (GREATEST(-100,LEAST(100,m.health_delta))*0.25 +
     GREATEST(-100,LEAST(100,m.reliability_delta))*0.25 +
     CASE WHEN m.baseline_open_work_orders IS NULL OR m.baseline_open_work_orders=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.work_order_reduction/m.baseline_open_work_orders))*0.20 END +
     CASE WHEN m.baseline_sla_exposure IS NULL OR m.baseline_sla_exposure=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.sla_reduction/m.baseline_sla_exposure))*0.20 END +
     CASE WHEN m.baseline_penalty_inr IS NULL OR m.baseline_penalty_inr=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.penalty_reduction_inr/m.baseline_penalty_inr))*0.10
     END))),2) AS observed_benefit_score,
  CASE
    WHEN m.measured_metric_count < 2 THEN 'INSUFFICIENT_EVIDENCE'
    WHEN m.expected_benefit_score IS NULL THEN 'MEASURED_WITHOUT_TARGET'
    WHEN (LEAST(100,GREATEST(0,
      (GREATEST(-100,LEAST(100,m.health_delta))*0.25 + GREATEST(-100,LEAST(100,m.reliability_delta))*0.25 +
       CASE WHEN m.baseline_open_work_orders IS NULL OR m.baseline_open_work_orders=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.work_order_reduction/m.baseline_open_work_orders))*0.20 END +
       CASE WHEN m.baseline_sla_exposure IS NULL OR m.baseline_sla_exposure=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.sla_reduction/m.baseline_sla_exposure))*0.20 END +
       CASE WHEN m.baseline_penalty_inr IS NULL OR m.baseline_penalty_inr=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.penalty_reduction_inr/m.baseline_penalty_inr))*0.10 END))),2)) >= m.expected_benefit_score*0.70 THEN 'DELIVERED'
    WHEN (LEAST(100,GREATEST(0,
      (GREATEST(-100,LEAST(100,m.health_delta))*0.25 + GREATEST(-100,LEAST(100,m.reliability_delta))*0.25 +
       CASE WHEN m.baseline_open_work_orders IS NULL OR m.baseline_open_work_orders=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.work_order_reduction/m.baseline_open_work_orders))*0.20 END +
       CASE WHEN m.baseline_sla_exposure IS NULL OR m.baseline_sla_exposure=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.sla_reduction/m.baseline_sla_exposure))*0.20 END +
       CASE WHEN m.baseline_penalty_inr IS NULL OR m.baseline_penalty_inr=0 THEN 0 ELSE GREATEST(-100,LEAST(100,100.0*m.penalty_reduction_inr/m.baseline_penalty_inr))*0.10 END))),2)) >= m.expected_benefit_score*0.35 THEN 'PARTIAL'
    ELSE 'NO_MEASURABLE_BENEFIT'
  END AS outcome_band
FROM metrics m;

CREATE OR REPLACE VIEW v_municipal_program_outcome_summary AS
SELECT zone_id,outcome_band,COUNT(*)::int AS programs,
       ROUND(AVG(observed_benefit_score),2) AS avg_observed_benefit_score,
       ROUND(AVG(expected_benefit_score),2) AS avg_expected_benefit_score,
       SUM(measured_metric_count)::int AS measured_metric_observations
FROM v_municipal_program_outcome_benefits
GROUP BY zone_id,outcome_band;
