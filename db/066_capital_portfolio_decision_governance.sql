BEGIN;

-- Human decision record for portfolio/scenario review. Append-only by design.
CREATE TABLE IF NOT EXISTS municipal_capital_portfolio_decisions (
  decision_id BIGSERIAL PRIMARY KEY,
  zone_id BIGINT REFERENCES zones(zone_id) ON DELETE SET NULL,
  decision_title TEXT NOT NULL,
  selected_scenario_key TEXT NOT NULL,
  decision_state TEXT NOT NULL CHECK (decision_state IN ('PROPOSED','UNDER_REVIEW','ENDORSED','REJECTED','SUPERSEDED')),
  decision_rationale TEXT,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capital_portfolio_decisions_zone ON municipal_capital_portfolio_decisions(zone_id);
CREATE INDEX IF NOT EXISTS idx_capital_portfolio_decisions_state ON municipal_capital_portfolio_decisions(decision_state);

CREATE OR REPLACE FUNCTION prevent_capital_portfolio_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Capital portfolio decisions are append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_capital_portfolio_decision_append_only ON municipal_capital_portfolio_decisions;
CREATE TRIGGER trg_capital_portfolio_decision_append_only
BEFORE UPDATE OR DELETE ON municipal_capital_portfolio_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_capital_portfolio_decision_mutation();

CREATE OR REPLACE VIEW v_municipal_capital_portfolio_decision_context AS
SELECT d.decision_id,d.zone_id,z.zone_name,d.decision_title,d.selected_scenario_key,
       d.decision_state,d.decision_rationale,d.evidence_snapshot,
       d.evidence_captured_at,d.decided_by,d.decided_at,d.created_at,
       CASE WHEN d.selected_scenario_key='CURRENT_MIX' THEN 'BASELINE'
            WHEN s.scenario_key IS NULL THEN 'SCENARIO_NOT_CURRENTLY_AVAILABLE'
            ELSE 'SCENARIO_CONTEXT_AVAILABLE' END AS scenario_context_state,
       'HUMAN_GOVERNANCE_RECORD' AS decision_authority
FROM municipal_capital_portfolio_decisions d
LEFT JOIN zones z ON z.zone_id=d.zone_id
LEFT JOIN v_municipal_capital_portfolio_scenario_summary s
  ON s.zone_id IS NOT DISTINCT FROM d.zone_id
 AND s.scenario_key=d.selected_scenario_key;

CREATE OR REPLACE VIEW v_municipal_capital_portfolio_decision_summary AS
SELECT zone_id,zone_name,COUNT(*)::int AS decision_count,
       COUNT(*) FILTER (WHERE decision_state='ENDORSED')::int AS endorsed_count,
       COUNT(*) FILTER (WHERE decision_state='UNDER_REVIEW')::int AS under_review_count,
       COUNT(*) FILTER (WHERE decision_state='REJECTED')::int AS rejected_count,
       MAX(decided_at) AS last_decided_at
FROM v_municipal_capital_portfolio_decision_context
GROUP BY zone_id,zone_name;

COMMIT;
