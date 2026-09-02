BEGIN;

ALTER TABLE municipal_capital_program_strategy_reviews
  ADD COLUMN IF NOT EXISTS source_assessed_programs_at INT CHECK (source_assessed_programs_at >= 0),
  ADD COLUMN IF NOT EXISTS source_measured_programs_at INT CHECK (source_measured_programs_at >= 0),
  ADD COLUMN IF NOT EXISTS source_delivered_programs_at INT CHECK (source_delivered_programs_at >= 0),
  ADD COLUMN IF NOT EXISTS source_effectiveness_rate_at NUMERIC(6,2) CHECK (source_effectiveness_rate_at BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS source_avg_benefit_score_at NUMERIC(6,2) CHECK (source_avg_benefit_score_at BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS source_avg_health_delta_at NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS source_avg_reliability_delta_at NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS source_evidence_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence_state VARCHAR(40) NOT NULL DEFAULT 'EVIDENCE_CURRENT'
    CHECK (evidence_state IN ('EVIDENCE_CURRENT','EVIDENCE_CHANGED_REVIEW_REQUIRED','NO_CURRENT_EVIDENCE'));

CREATE OR REPLACE VIEW v_municipal_capital_program_strategy_evidence AS
SELECT r.review_id,r.investment_theme,r.zone_id,r.strategy_signal,
       r.source_assessed_programs_at,r.source_measured_programs_at,
       r.source_delivered_programs_at,r.source_effectiveness_rate_at,
       r.source_avg_benefit_score_at,r.source_avg_health_delta_at,
       r.source_avg_reliability_delta_at,r.source_evidence_captured_at,
       CASE WHEN l.investment_theme IS NULL THEN 'NO_CURRENT_EVIDENCE'
            WHEN l.assessed_programs<>COALESCE(r.source_assessed_programs_at,-1)
              OR l.measured_programs<>COALESCE(r.source_measured_programs_at,-1)
              OR l.delivered_programs<>COALESCE(r.source_delivered_programs_at,-1)
              OR l.effectiveness_rate IS DISTINCT FROM r.source_effectiveness_rate_at
              OR l.avg_benefit_score IS DISTINCT FROM r.source_avg_benefit_score_at
              OR l.avg_health_delta IS DISTINCT FROM r.source_avg_health_delta_at
              OR l.avg_reliability_delta IS DISTINCT FROM r.source_avg_reliability_delta_at
            THEN 'EVIDENCE_CHANGED_REVIEW_REQUIRED'
            ELSE 'EVIDENCE_CURRENT' END AS current_evidence_state
FROM municipal_capital_program_strategy_reviews r
LEFT JOIN v_municipal_capital_program_learning_patterns l
  ON l.investment_theme=r.investment_theme
 AND l.zone_id IS NOT DISTINCT FROM r.zone_id;

CREATE OR REPLACE VIEW v_municipal_capital_program_strategy_command AS
WITH latest_review AS (
  SELECT DISTINCT ON (investment_theme,zone_id) investment_theme,zone_id,
         strategy_signal AS human_strategy_signal,decision_notes AS human_decision_notes,
         reviewed_by,reviewed_at,review_id
  FROM municipal_capital_program_strategy_reviews
  ORDER BY investment_theme,zone_id,reviewed_at DESC,review_id DESC
)
SELECT l.*,r.human_strategy_signal,r.human_decision_notes,r.reviewed_by,r.reviewed_at,
       COALESCE(e.current_evidence_state,'NO_CURRENT_EVIDENCE') AS evidence_state,
       CASE WHEN r.human_strategy_signal IS NOT NULL AND COALESCE(e.current_evidence_state,'NO_CURRENT_EVIDENCE')='EVIDENCE_CURRENT'
            THEN 'HUMAN_REVIEW_RECORDED'
            ELSE 'LEARNING_REQUIRES_HUMAN_REVIEW' END AS strategy_review_state
FROM v_municipal_capital_program_learning_patterns l
LEFT JOIN latest_review r ON r.investment_theme=l.investment_theme AND r.zone_id IS NOT DISTINCT FROM l.zone_id
LEFT JOIN v_municipal_capital_program_strategy_evidence e ON e.review_id=r.review_id;

CREATE OR REPLACE FUNCTION prevent_capital_program_strategy_review_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Capital program strategy reviews are append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_capital_program_strategy_review_append_only
  ON municipal_capital_program_strategy_reviews;
CREATE TRIGGER trg_capital_program_strategy_review_append_only
BEFORE UPDATE OR DELETE ON municipal_capital_program_strategy_reviews
FOR EACH ROW EXECUTE FUNCTION prevent_capital_program_strategy_review_mutation();

CREATE INDEX IF NOT EXISTS idx_capital_program_strategy_evidence_state
  ON municipal_capital_program_strategy_reviews(investment_theme,zone_id,evidence_state,reviewed_at DESC);

COMMIT;
