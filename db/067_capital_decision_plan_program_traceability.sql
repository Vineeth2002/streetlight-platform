BEGIN;

CREATE TABLE IF NOT EXISTS municipal_capital_decision_links (
  decision_link_id BIGSERIAL PRIMARY KEY,
  decision_id BIGINT NOT NULL REFERENCES municipal_capital_portfolio_decisions(decision_id) ON DELETE RESTRICT,
  capital_plan_id BIGINT REFERENCES municipal_capital_plans(plan_id) ON DELETE RESTRICT,
  capital_program_id BIGINT REFERENCES municipal_capital_programs(capital_program_id) ON DELETE RESTRICT,
  linkage_type TEXT NOT NULL CHECK (linkage_type IN ('PLAN_INFLUENCED','PROGRAM_INFLUENCED')),
  linkage_rationale TEXT,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((linkage_type='PLAN_INFLUENCED' AND capital_plan_id IS NOT NULL AND capital_program_id IS NULL)
      OR (linkage_type='PROGRAM_INFLUENCED' AND capital_program_id IS NOT NULL AND capital_plan_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_capital_decision_plan_link ON municipal_capital_decision_links(decision_id,capital_plan_id) WHERE capital_plan_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_capital_decision_program_link ON municipal_capital_decision_links(decision_id,capital_program_id) WHERE capital_program_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_capital_decision_link_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Capital decision traceability records are append-only' USING ERRCODE='55000'; END;
$$;
DROP TRIGGER IF EXISTS trg_capital_decision_link_append_only ON municipal_capital_decision_links;
CREATE TRIGGER trg_capital_decision_link_append_only BEFORE UPDATE OR DELETE ON municipal_capital_decision_links FOR EACH ROW EXECUTE FUNCTION prevent_capital_decision_link_mutation();

CREATE OR REPLACE VIEW v_municipal_capital_decision_traceability AS
SELECT l.decision_link_id,l.decision_id,d.zone_id,z.zone_name,d.selected_scenario_key,d.decision_state,
       l.linkage_type,l.capital_plan_id,l.capital_program_id,
       p.title AS plan_title,p.status AS plan_status,
       cp.title AS program_title,cp.status AS program_status,
       l.linkage_rationale,l.evidence_snapshot,l.evidence_captured_at,l.linked_by,l.linked_at,
       CASE WHEN d.decision_state='ENDORSED' THEN 'ENDORSED_DECISION_LINKED'
            WHEN d.decision_state='SUPERSEDED' THEN 'SUPERSEDED_DECISION'
            ELSE 'DECISION_NOT_ENDORSED' END AS traceability_state,
       'HUMAN_GOVERNANCE_TRACE' AS decision_authority
FROM municipal_capital_decision_links l
JOIN municipal_capital_portfolio_decisions d ON d.decision_id=l.decision_id
LEFT JOIN zones z ON z.zone_id=d.zone_id
LEFT JOIN municipal_capital_plans p ON p.plan_id=l.capital_plan_id
LEFT JOIN municipal_capital_programs cp ON cp.capital_program_id=l.capital_program_id;

CREATE OR REPLACE VIEW v_municipal_capital_decision_traceability_summary AS
SELECT zone_id,zone_name,COUNT(DISTINCT decision_id)::int AS decisions,
       COUNT(*)::int AS linked_records,
       COUNT(*) FILTER (WHERE traceability_state='ENDORSED_DECISION_LINKED')::int AS endorsed_links,
       COUNT(*) FILTER (WHERE traceability_state='DECISION_NOT_ENDORSED')::int AS pending_links,
       COUNT(*) FILTER (WHERE traceability_state='SUPERSEDED_DECISION')::int AS superseded_links
FROM v_municipal_capital_decision_traceability
GROUP BY zone_id,zone_name;

COMMIT;
