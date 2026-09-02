BEGIN;

CREATE TABLE IF NOT EXISTS municipal_capital_plans (
  plan_id BIGSERIAL PRIMARY KEY,
  plan_year INT NOT NULL CHECK (plan_year >= 2000 AND plan_year <= 2100),
  zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
  plan_title TEXT NOT NULL,
  investment_theme TEXT NOT NULL CHECK (investment_theme IN ('ASSET_RENEWAL','PREVENTIVE_MAINTENANCE','NETWORK_RESILIENCE','CONTRACTOR_CAPACITY','DATA_INFRASTRUCTURE','MIXED_CAPITAL')),
  proposed_amount_inr NUMERIC(18,2) NOT NULL CHECK (proposed_amount_inr >= 0),
  priority_score NUMERIC(6,2) CHECK (priority_score >= 0 AND priority_score <= 100),
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','UNDER_REVIEW','APPROVED','FUNDED','IN_EXECUTION','COMPLETED','PAUSED','REJECTED')),
  created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  decision_notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_capital_plans_year_zone ON municipal_capital_plans(plan_year, zone_id);
CREATE INDEX IF NOT EXISTS idx_capital_plans_status ON municipal_capital_plans(status);
CREATE OR REPLACE FUNCTION touch_municipal_capital_plan_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_municipal_capital_plan_updated_at ON municipal_capital_plans;
CREATE TRIGGER trg_municipal_capital_plan_updated_at BEFORE UPDATE ON municipal_capital_plans FOR EACH ROW EXECUTE FUNCTION touch_municipal_capital_plan_updated_at();

CREATE OR REPLACE VIEW v_municipal_capital_investment_pipeline AS
WITH pressure AS (
  SELECT zone_id,COUNT(*) FILTER (WHERE replacement_priority IN ('CRITICAL','HIGH')) AS high_replacement_assets,COUNT(*) AS replacement_candidates
  FROM v_asset_replacement_candidates GROUP BY zone_id
), resource AS (
  SELECT zone_id,COUNT(*) FILTER (WHERE forecast_30d_exposure IN ('CRITICAL_EXPOSURE','HIGH_EXPOSURE')) AS forecast_high_exposure_assets,MAX(allocation_priority_score) AS allocation_priority_score
  FROM v_municipal_resource_allocation GROUP BY zone_id
), programs AS (
  SELECT zone_id,COUNT(*) FILTER (WHERE program_priority_score >= 70) AS priority_programs,SUM(COALESCE(program_priority_score,0)) AS program_priority_total
  FROM v_municipal_program_portfolio GROUP BY zone_id
), budget AS (
  SELECT zone_id,SUM(COALESCE(uncommitted_budget_inr,0)) AS uncommitted_budget_inr,SUM(GREATEST(COALESCE(effective_budget_inr,0)-COALESCE(net_payable_basis_inr,0),0)) AS expenditure_exposure_inr
  FROM v_budget_expenditure_intelligence GROUP BY zone_id
)
SELECT z.zone_id,z.zone_name,
       COALESCE(p.high_replacement_assets,0) AS high_replacement_assets,
       COALESCE(p.replacement_candidates,0) AS replacement_candidates,
       COALESCE(r.forecast_high_exposure_assets,0) AS forecast_high_exposure_assets,
       COALESCE(r.allocation_priority_score,0) AS allocation_priority_score,
       COALESCE(pr.priority_programs,0) AS priority_programs,
       COALESCE(pr.program_priority_total,0) AS program_priority_total,
       COALESCE(b.uncommitted_budget_inr,0) AS uncommitted_budget_inr,
       COALESCE(b.expenditure_exposure_inr,0) AS expenditure_exposure_inr,
       LEAST(100,ROUND(LEAST(35,COALESCE(p.high_replacement_assets,0)*1.5)+LEAST(25,COALESCE(r.allocation_priority_score,0)*0.25)+LEAST(20,COALESCE(pr.priority_programs,0)*2)+LEAST(20,CASE WHEN COALESCE(b.uncommitted_budget_inr,0)>0 AND COALESCE(b.expenditure_exposure_inr,0)>COALESCE(b.uncommitted_budget_inr,0) THEN 20 ELSE 0 END),2)) AS capital_pressure_score
FROM zones z
LEFT JOIN pressure p ON p.zone_id=z.zone_id
LEFT JOIN resource r ON r.zone_id=z.zone_id
LEFT JOIN programs pr ON pr.zone_id=z.zone_id
LEFT JOIN budget b ON b.zone_id=z.zone_id;

CREATE OR REPLACE VIEW v_municipal_multi_year_capital_outlook AS
SELECT plan_year,COUNT(*) AS plan_count,SUM(proposed_amount_inr) AS proposed_investment_inr,
       SUM(proposed_amount_inr) FILTER (WHERE status IN ('APPROVED','FUNDED','IN_EXECUTION')) AS committed_or_approved_inr,
       SUM(proposed_amount_inr) FILTER (WHERE status='COMPLETED') AS completed_inr,
       COUNT(*) FILTER (WHERE status IN ('PROPOSED','UNDER_REVIEW')) AS decision_pending_count
FROM municipal_capital_plans GROUP BY plan_year;

CREATE OR REPLACE VIEW v_municipal_capital_command AS
SELECT c.zone_id,c.zone_name,c.capital_pressure_score,c.high_replacement_assets,c.replacement_candidates,c.forecast_high_exposure_assets,
       c.allocation_priority_score,c.priority_programs,c.uncommitted_budget_inr,c.expenditure_exposure_inr,
       CASE WHEN c.capital_pressure_score >= 75 THEN 'CRITICAL_REVIEW' WHEN c.capital_pressure_score >= 50 THEN 'HIGH_REVIEW' WHEN c.capital_pressure_score >= 25 THEN 'PLANNING_REVIEW' ELSE 'ROUTINE_REVIEW' END AS capital_review_band,
       CASE WHEN c.high_replacement_assets > 0 AND c.uncommitted_budget_inr <= c.expenditure_exposure_inr THEN 'CAPITAL_RENEWAL_PRESSURE'
            WHEN c.high_replacement_assets > 0 THEN 'REPLACEMENT_PIPELINE'
            WHEN c.priority_programs > 0 THEN 'PROGRAM_INVESTMENT_PRESSURE'
            ELSE 'MONITOR' END AS dominant_capital_signal
FROM v_municipal_capital_investment_pipeline c;
COMMIT;
