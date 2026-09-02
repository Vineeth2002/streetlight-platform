BEGIN;

-- Records the human decision that connects an advisory scenario to a real capital program.
-- The link is immutable: scenario intelligence never creates or modifies capital programs.
CREATE TABLE IF NOT EXISTS municipal_capital_scenario_program_links (
    link_id BIGSERIAL PRIMARY KEY,
    scenario_key VARCHAR(100) NOT NULL,
    zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    capital_program_id BIGINT NOT NULL REFERENCES municipal_capital_programs(capital_program_id) ON DELETE RESTRICT,
    decision_id BIGINT REFERENCES municipal_capital_portfolio_decisions(decision_id) ON DELETE RESTRICT,
    guidance_state VARCHAR(80),
    revalidation_state VARCHAR(80),
    selection_rationale TEXT NOT NULL,
    evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    selected_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT municipal_capital_scenario_program_link_unique UNIQUE(scenario_key,zone_id,capital_program_id)
);

CREATE INDEX IF NOT EXISTS idx_capital_scenario_program_links_program
  ON municipal_capital_scenario_program_links(capital_program_id,selected_at DESC);
CREATE INDEX IF NOT EXISTS idx_capital_scenario_program_links_scenario
  ON municipal_capital_scenario_program_links(zone_id,scenario_key,selected_at DESC);

CREATE OR REPLACE FUNCTION prevent_capital_scenario_program_link_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Capital scenario-program traceability is append-only' USING ERRCODE='55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_capital_scenario_program_link_immutable
  ON municipal_capital_scenario_program_links;
CREATE TRIGGER trg_capital_scenario_program_link_immutable
BEFORE UPDATE OR DELETE ON municipal_capital_scenario_program_links
FOR EACH ROW EXECUTE FUNCTION prevent_capital_scenario_program_link_mutation();

CREATE OR REPLACE VIEW v_municipal_capital_scenario_program_traceability AS
SELECT l.link_id,l.scenario_key,l.zone_id,z.zone_name,
       l.capital_program_id,cp.program_key,cp.title AS capital_program_title,
       cp.status AS capital_program_status,cp.investment_theme,
       l.decision_id,l.guidance_state,l.revalidation_state,
       l.selection_rationale,l.evidence_snapshot,l.selected_by,l.selected_at,l.created_at,
       'HUMAN_SELECTED_SCENARIO_TO_PROGRAM_LINK' AS linkage_authority,
       'NO_AUTOMATIC_PROGRAM_CREATION_OR_EXECUTION' AS governance_constraint
FROM municipal_capital_scenario_program_links l
LEFT JOIN zones z ON z.zone_id=l.zone_id
JOIN municipal_capital_programs cp ON cp.capital_program_id=l.capital_program_id;

CREATE OR REPLACE VIEW v_municipal_capital_scenario_program_traceability_summary AS
SELECT zone_id,zone_name,scenario_key,
       COUNT(*)::int AS program_links,
       COUNT(DISTINCT capital_program_id)::int AS distinct_programs,
       COUNT(*) FILTER (WHERE capital_program_status IN ('IN_EXECUTION','MONITORED','COMPLETED'))::int AS progressed_programs
FROM v_municipal_capital_scenario_program_traceability
GROUP BY zone_id,zone_name,scenario_key;

COMMIT;
