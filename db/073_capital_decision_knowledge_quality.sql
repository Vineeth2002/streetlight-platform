BEGIN;

-- Evidence freshness and knowledge-quality guardrail for capital decision precedent.
-- Advisory only: stale evidence is surfaced for review; historical records are never rewritten.
CREATE OR REPLACE VIEW v_municipal_capital_decision_knowledge_quality AS
SELECT
  m.*,
  CURRENT_DATE - COALESCE(m.outcome_evidence_captured_at::date,m.decision_evidence_captured_at::date) AS evidence_age_days,
  CASE
    WHEN m.memory_state='EVIDENCE_GAP' THEN 'EVIDENCE_GAP'
    WHEN m.memory_state='VALIDATED_DECISION_HISTORY'
      AND COALESCE(m.outcome_evidence_captured_at,m.decision_evidence_captured_at) >= NOW() - INTERVAL '180 days' THEN 'CURRENT'
    WHEN m.memory_state='VALIDATED_DECISION_HISTORY' THEN 'STALE_REVIEW_REQUIRED'
    WHEN m.memory_state='SUPERSEDED_DECISION_HISTORY' THEN 'SUPERSEDED'
    ELSE 'REVIEW_REQUIRED'
  END AS evidence_freshness_state,
  CASE
    WHEN m.memory_state='VALIDATED_DECISION_HISTORY'
      AND COALESCE(m.outcome_evidence_captured_at,m.decision_evidence_captured_at) >= NOW() - INTERVAL '180 days' THEN 'PRECEDENT_USABLE_WITH_CONTEXT_REVIEW'
    WHEN m.memory_state='VALIDATED_DECISION_HISTORY' THEN 'REFRESH_EVIDENCE_BEFORE_REUSE'
    WHEN m.memory_state='EVIDENCE_GAP' THEN 'DO_NOT_GENERALIZE'
    WHEN m.memory_state='SUPERSEDED_DECISION_HISTORY' THEN 'DO_NOT_USE_AS_CURRENT_PRECEDENT'
    ELSE 'REVIEW_SOURCE_RECORDS'
  END AS knowledge_guidance,
  'HUMAN_REVIEW_REQUIRED' AS decision_authority
FROM v_municipal_capital_decision_institutional_memory m;

CREATE OR REPLACE VIEW v_municipal_capital_decision_knowledge_quality_summary AS
SELECT zone_id,zone_name,selected_scenario_key,evidence_freshness_state,
       COUNT(DISTINCT decision_id)::int AS decisions,
       COUNT(*)::int AS evidence_records,
       ROUND(AVG(observed_benefit_score),2) AS avg_observed_benefit_score
FROM v_municipal_capital_decision_knowledge_quality
GROUP BY zone_id,zone_name,selected_scenario_key,evidence_freshness_state;

COMMIT;
