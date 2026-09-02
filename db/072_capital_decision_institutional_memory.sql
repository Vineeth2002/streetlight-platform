BEGIN;

-- Durable, read-only institutional memory assembled from governed decision evidence.
-- This is a historical synthesis layer; it never rewrites source decisions or outcomes.
CREATE OR REPLACE VIEW v_municipal_capital_decision_institutional_memory AS
SELECT
  d.decision_id,
  d.zone_id,
  z.zone_name,
  d.decision_title,
  d.selected_scenario_key,
  d.decision_state,
  d.rationale AS decision_rationale,
  d.evidence_captured_at AS decision_evidence_captured_at,
  d.decided_by,
  d.decided_at,
  l.decision_link_id,
  l.linkage_type,
  l.capital_plan_id,
  l.capital_program_id,
  p.title AS program_title,
  p.status AS program_status,
  a.attribution_id,
  a.attribution_state,
  a.attribution_rationale,
  a.evidence_captured_at AS outcome_evidence_captured_at,
  o.outcome_band,
  o.expected_benefit_score,
  o.observed_benefit_score,
  o.health_delta,
  o.reliability_delta,
  o.work_order_delta,
  o.sla_exposure_delta,
  o.penalty_delta_inr,
  CASE
    WHEN d.decision_state='ENDORSED' AND a.attribution_state='ATTRIBUTED' THEN 'VALIDATED_DECISION_HISTORY'
    WHEN a.attribution_state='INSUFFICIENT_EVIDENCE' THEN 'EVIDENCE_GAP'
    WHEN d.decision_state='SUPERSEDED' THEN 'SUPERSEDED_DECISION_HISTORY'
    ELSE 'DECISION_HISTORY_REQUIRES_REVIEW'
  END AS memory_state,
  CASE
    WHEN d.decision_state='ENDORSED' AND a.attribution_state='ATTRIBUTED' THEN 'DECISION_OUTCOME_CAN_INFORM_FUTURE_REVIEW'
    WHEN a.attribution_state='INSUFFICIENT_EVIDENCE' THEN 'DO_NOT_GENERALIZE_WITHOUT_MORE_EVIDENCE'
    ELSE 'REVIEW_SOURCE_EVIDENCE_BEFORE_REUSE'
  END AS institutional_guidance,
  'HISTORICAL_EVIDENCE_ONLY' AS authority_scope
FROM municipal_capital_portfolio_decisions d
LEFT JOIN zones z ON z.zone_id=d.zone_id
LEFT JOIN municipal_capital_decision_links l ON l.decision_id=d.decision_id
LEFT JOIN municipal_capital_programs p ON p.program_id=l.capital_program_id
LEFT JOIN municipal_capital_decision_outcome_attributions a ON a.decision_id=d.decision_id AND a.decision_link_id=l.decision_link_id
LEFT JOIN v_municipal_capital_program_outcomes o ON o.assessment_id=a.outcome_assessment_id;

CREATE OR REPLACE VIEW v_municipal_capital_decision_institutional_memory_summary AS
SELECT zone_id,zone_name,selected_scenario_key,
       COUNT(DISTINCT decision_id)::int AS decisions,
       COUNT(*) FILTER (WHERE memory_state='VALIDATED_DECISION_HISTORY')::int AS validated_histories,
       COUNT(*) FILTER (WHERE memory_state='EVIDENCE_GAP')::int AS evidence_gaps,
       COUNT(*) FILTER (WHERE memory_state='SUPERSEDED_DECISION_HISTORY')::int AS superseded_histories,
       ROUND(AVG(observed_benefit_score) FILTER (WHERE memory_state='VALIDATED_DECISION_HISTORY'),2) AS avg_validated_benefit
FROM v_municipal_capital_decision_institutional_memory
GROUP BY zone_id,zone_name,selected_scenario_key;

COMMIT;
