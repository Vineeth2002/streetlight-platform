BEGIN;

CREATE TABLE IF NOT EXISTS municipal_capital_program_outcome_assessments (
  assessment_id BIGSERIAL PRIMARY KEY,
  capital_program_id BIGINT NOT NULL REFERENCES municipal_capital_programs(capital_program_id) ON DELETE CASCADE,
  observation_window_days INT NOT NULL CHECK (observation_window_days > 0),
  baseline_health_score NUMERIC(6,2) CHECK (baseline_health_score BETWEEN 0 AND 100),
  observed_health_score NUMERIC(6,2) CHECK (observed_health_score BETWEEN 0 AND 100),
  baseline_reliability_score NUMERIC(6,2) CHECK (baseline_reliability_score BETWEEN 0 AND 100),
  observed_reliability_score NUMERIC(6,2) CHECK (observed_reliability_score BETWEEN 0 AND 100),
  baseline_open_work_orders INT CHECK (baseline_open_work_orders >= 0),
  observed_open_work_orders INT CHECK (observed_open_work_orders >= 0),
  baseline_sla_exposure INT CHECK (baseline_sla_exposure >= 0),
  observed_sla_exposure INT CHECK (observed_sla_exposure >= 0),
  baseline_penalty_inr NUMERIC(18,2) CHECK (baseline_penalty_inr >= 0),
  observed_penalty_inr NUMERIC(18,2) CHECK (observed_penalty_inr >= 0),
  expected_benefit_score NUMERIC(6,2) CHECK (expected_benefit_score BETWEEN 0 AND 100),
  observed_benefit_score NUMERIC(6,2) CHECK (observed_benefit_score BETWEEN 0 AND 100),
  evidence_uri TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  assessed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_capital_program_outcomes_program_time ON municipal_capital_program_outcome_assessments(capital_program_id,measured_at DESC);

CREATE OR REPLACE VIEW v_municipal_capital_program_outcomes AS
WITH latest AS (
  SELECT a.*,ROW_NUMBER() OVER (PARTITION BY a.capital_program_id ORDER BY a.measured_at DESC,a.assessment_id DESC) AS rn
  FROM municipal_capital_program_outcome_assessments a
)
SELECT cp.capital_program_id,cp.program_key,cp.title,cp.zone_id,z.zone_name,cp.status,
       l.assessment_id,l.observation_window_days,l.measured_at,
       l.baseline_health_score,l.observed_health_score,
       ROUND(l.observed_health_score-l.baseline_health_score,2) AS health_delta,
       l.baseline_reliability_score,l.observed_reliability_score,
       ROUND(l.observed_reliability_score-l.baseline_reliability_score,2) AS reliability_delta,
       l.baseline_open_work_orders,l.observed_open_work_orders,
       l.observed_open_work_orders-l.baseline_open_work_orders AS work_order_delta,
       l.baseline_sla_exposure,l.observed_sla_exposure,
       l.observed_sla_exposure-l.baseline_sla_exposure AS sla_exposure_delta,
       l.baseline_penalty_inr,l.observed_penalty_inr,
       ROUND(l.observed_penalty_inr-l.baseline_penalty_inr,2) AS penalty_delta_inr,
       l.expected_benefit_score,l.observed_benefit_score,
       CASE WHEN l.observed_benefit_score IS NULL THEN 'INSUFFICIENT_EVIDENCE'
            WHEN l.observed_benefit_score >= 70 THEN 'DELIVERED'
            WHEN l.observed_benefit_score >= 40 THEN 'PARTIAL'
            ELSE 'NO_MEASURABLE_BENEFIT' END AS outcome_band,
       l.evidence_uri,l.evidence,l.notes,l.assessed_by
FROM municipal_capital_programs cp
JOIN latest l ON l.capital_program_id=cp.capital_program_id AND l.rn=1
LEFT JOIN zones z ON z.zone_id=cp.zone_id;

CREATE OR REPLACE VIEW v_municipal_capital_program_outcome_summary AS
SELECT zone_id,zone_name,outcome_band,COUNT(*)::int AS programs,
       ROUND(AVG(observed_benefit_score),2) AS avg_observed_benefit_score,
       ROUND(AVG(health_delta),2) AS avg_health_delta,
       ROUND(AVG(reliability_delta),2) AS avg_reliability_delta,
       SUM(CASE WHEN work_order_delta < 0 THEN 1 ELSE 0 END)::int AS programs_reducing_work_orders,
       SUM(CASE WHEN sla_exposure_delta < 0 THEN 1 ELSE 0 END)::int AS programs_reducing_sla_exposure,
       SUM(CASE WHEN penalty_delta_inr < 0 THEN 1 ELSE 0 END)::int AS programs_reducing_penalties
FROM v_municipal_capital_program_outcomes
GROUP BY zone_id,zone_name,outcome_band;

COMMIT;
