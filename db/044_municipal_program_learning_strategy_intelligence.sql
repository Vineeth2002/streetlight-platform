-- 044_municipal_program_learning_strategy_intelligence.sql
-- Advisory learning from governed program outcomes. It identifies recurring
-- delivery patterns and strategy-review signals; it never executes, approves,
-- closes, reallocates, changes SLA/penalties, or alters glow-rate calculations.

CREATE TABLE IF NOT EXISTS municipal_program_strategy_reviews (
    review_id BIGSERIAL PRIMARY KEY,
    program_type VARCHAR(80) NOT NULL,
    zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    strategy_signal VARCHAR(30) NOT NULL CHECK (strategy_signal IN ('RETAIN','REVIEW','REVISE','INSUFFICIENT_EVIDENCE')),
    evidence_count INT NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
    effectiveness_rate NUMERIC(6,2) CHECK (effectiveness_rate BETWEEN 0 AND 100),
    avg_benefit_score NUMERIC(6,2) CHECK (avg_benefit_score BETWEEN 0 AND 100),
    rationale TEXT,
    decision_notes TEXT,
    evidence_uri TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    reviewed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_program_strategy_reviews_type_zone
  ON municipal_program_strategy_reviews(program_type,zone_id,reviewed_at DESC);

CREATE OR REPLACE VIEW v_municipal_program_learning_patterns AS
WITH measured AS (
  SELECT b.program_type,b.zone_id,b.program_id,b.outcome_band,
         b.observed_benefit_score,b.expected_benefit_score,b.measured_metric_count
  FROM v_municipal_program_outcome_benefits b
), grouped AS (
  SELECT program_type,zone_id,
         COUNT(*)::int AS assessed_programs,
         COUNT(*) FILTER (WHERE outcome_band IN ('DELIVERED','PARTIAL','NO_MEASURABLE_BENEFIT'))::int AS measured_programs,
         COUNT(*) FILTER (WHERE outcome_band='DELIVERED')::int AS delivered_programs,
         COUNT(*) FILTER (WHERE outcome_band='PARTIAL')::int AS partial_programs,
         COUNT(*) FILTER (WHERE outcome_band='NO_MEASURABLE_BENEFIT')::int AS no_benefit_programs,
         COUNT(*) FILTER (WHERE outcome_band='INSUFFICIENT_EVIDENCE')::int AS insufficient_evidence_programs,
         ROUND(100.0*COUNT(*) FILTER (WHERE outcome_band='DELIVERED')/
           NULLIF(COUNT(*) FILTER (WHERE outcome_band IN ('DELIVERED','PARTIAL','NO_MEASURABLE_BENEFIT')),0),2) AS effectiveness_rate,
         ROUND(AVG(observed_benefit_score) FILTER (WHERE observed_benefit_score IS NOT NULL),2) AS avg_benefit_score,
         ROUND(AVG(expected_benefit_score) FILTER (WHERE expected_benefit_score IS NOT NULL),2) AS avg_expected_benefit_score,
         ROUND(AVG(measured_metric_count),2) AS avg_metrics_measured
  FROM measured
  GROUP BY program_type,zone_id
)
SELECT g.*,
  CASE
    WHEN g.measured_programs < 2 THEN 'INSUFFICIENT_EVIDENCE'
    WHEN g.effectiveness_rate >= 70 AND COALESCE(g.avg_benefit_score,0) >= 50 THEN 'RETAIN'
    WHEN g.effectiveness_rate < 40 OR COALESCE(g.avg_benefit_score,0) < 30 THEN 'REVISE'
    ELSE 'REVIEW'
  END AS learning_signal,
  CASE
    WHEN g.measured_programs < 2 THEN 'Too little measured program evidence for a strategy conclusion.'
    WHEN g.effectiveness_rate >= 70 AND COALESCE(g.avg_benefit_score,0) >= 50 THEN 'Observed program outcomes show a consistently useful delivery pattern; retain for human strategic review.'
    WHEN g.effectiveness_rate < 40 OR COALESCE(g.avg_benefit_score,0) < 30 THEN 'Observed outcomes are weak; review program design, targeting, execution conditions, or measurement quality before reuse.'
    ELSE 'Evidence is mixed; compare program design and execution context before changing strategy.'
  END AS learning_rationale
FROM grouped g;

CREATE OR REPLACE VIEW v_municipal_program_strategy_command AS
WITH latest_review AS (
  SELECT DISTINCT ON (program_type,zone_id) program_type,zone_id,strategy_signal AS human_strategy_signal,
         decision_notes AS human_decision_notes,reviewed_by,reviewed_at
  FROM municipal_program_strategy_reviews
  ORDER BY program_type,zone_id,reviewed_at DESC,review_id DESC
)
SELECT l.*,r.human_strategy_signal,r.human_decision_notes,r.reviewed_by,r.reviewed_at,
       CASE WHEN r.human_strategy_signal IS NOT NULL THEN 'HUMAN_REVIEW_RECORDED' ELSE 'LEARNING_REQUIRES_HUMAN_REVIEW' END AS strategy_review_state
FROM v_municipal_program_learning_patterns l
LEFT JOIN latest_review r ON r.program_type=l.program_type AND r.zone_id IS NOT DISTINCT FROM l.zone_id;

CREATE OR REPLACE VIEW v_municipal_program_learning_summary AS
SELECT learning_signal,COUNT(*)::int AS strategy_groups,
       SUM(measured_programs)::int AS measured_programs,
       SUM(delivered_programs)::int AS delivered_programs,
       SUM(no_benefit_programs)::int AS no_benefit_programs,
       ROUND(AVG(effectiveness_rate),2) AS avg_effectiveness_rate,
       ROUND(AVG(avg_benefit_score),2) AS avg_benefit_score
FROM v_municipal_program_learning_patterns
GROUP BY learning_signal;
