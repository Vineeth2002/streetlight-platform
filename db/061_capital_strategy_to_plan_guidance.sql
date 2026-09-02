BEGIN;

-- Advisory bridge from validated capital-program learning to future capital-plan design.
-- It never creates, approves, funds, or executes a capital plan automatically.
CREATE OR REPLACE VIEW v_municipal_capital_strategy_to_plan_guidance AS
WITH plan_counts AS (
  SELECT investment_theme,zone_id,
         COUNT(*)::int AS existing_plans,
         COUNT(*) FILTER (WHERE status IN ('PROPOSED','UNDER_REVIEW'))::int AS pending_plans,
         COUNT(*) FILTER (WHERE status IN ('APPROVED','FUNDED','IN_EXECUTION'))::int AS active_or_committed_plans
  FROM municipal_capital_plans
  GROUP BY investment_theme,zone_id
), learning AS (
  SELECT * FROM v_municipal_capital_program_learning_patterns
)
SELECT l.investment_theme,l.zone_id,
       COALESCE(z.zone_name,'Citywide') AS zone_name,
       l.assessed_programs,l.measured_programs,l.delivered_programs,l.partial_programs,
       l.no_benefit_programs,l.insufficient_evidence_programs,
       l.effectiveness_rate,l.avg_benefit_score,l.avg_expected_benefit_score,
       l.avg_health_delta,l.avg_reliability_delta,l.learning_signal,l.learning_rationale,
       COALESCE(pc.existing_plans,0) AS existing_plans,
       COALESCE(pc.pending_plans,0) AS pending_plans,
       COALESCE(pc.active_or_committed_plans,0) AS active_or_committed_plans,
       CASE
         WHEN l.learning_signal='RETAIN' THEN 'CONSIDER_CONTINUING'
         WHEN l.learning_signal='REVISE' THEN 'REVIEW_DESIGN_BEFORE_REUSE'
         WHEN l.learning_signal='REVIEW' THEN 'COMPARE_CONTEXT_BEFORE_REUSE'
         ELSE 'BUILD_MORE_EVIDENCE'
       END AS plan_guidance,
       'HUMAN_DECISION_REQUIRED' AS governance_state
FROM learning l
LEFT JOIN zones z ON z.zone_id=l.zone_id
LEFT JOIN plan_counts pc ON pc.investment_theme=l.investment_theme
  AND pc.zone_id IS NOT DISTINCT FROM l.zone_id;

CREATE OR REPLACE VIEW v_municipal_capital_plan_strategy_guidance AS
SELECT p.plan_id,p.plan_year,p.zone_id,z.zone_name,p.plan_title,p.investment_theme,
       p.status,p.proposed_amount_inr,p.priority_score,p.strategy_policy_id,
       g.learning_signal,g.learning_rationale,g.plan_guidance,
       g.measured_programs,g.effectiveness_rate,g.avg_benefit_score,
       g.avg_health_delta,g.avg_reliability_delta,
       CASE WHEN g.investment_theme IS NULL THEN 'NO_LEARNING_EVIDENCE'
            ELSE 'LEARNING_EVIDENCE_AVAILABLE' END AS learning_evidence_state,
       'HUMAN_DECISION_REQUIRED' AS governance_state
FROM municipal_capital_plans p
LEFT JOIN zones z ON z.zone_id=p.zone_id
LEFT JOIN v_municipal_capital_strategy_to_plan_guidance g
  ON g.investment_theme=p.investment_theme
 AND g.zone_id IS NOT DISTINCT FROM p.zone_id;

COMMIT;
