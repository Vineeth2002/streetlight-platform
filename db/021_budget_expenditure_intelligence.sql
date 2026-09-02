-- 021_budget_expenditure_intelligence.sql
-- Budget intelligence is an advisory financial read model. It does not execute
-- payments or alter SLA, penalty, or glow-rate calculations.

CREATE TABLE IF NOT EXISTS municipal_budgets (
    budget_id            BIGSERIAL PRIMARY KEY,
    budget_year          INT NOT NULL CHECK (budget_year BETWEEN 2000 AND 2200),
    budget_name          VARCHAR(255) NOT NULL,
    department           VARCHAR(120) NOT NULL DEFAULT 'Streetlight',
    zone_id              INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    allocated_amount_inr NUMERIC(18,2) NOT NULL CHECK (allocated_amount_inr >= 0),
    revised_amount_inr   NUMERIC(18,2) CHECK (revised_amount_inr >= 0),
    status               VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('DRAFT','ACTIVE','CLOSED')),
    source_reference     VARCHAR(500),
    metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by           INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(budget_year, budget_name, department, zone_id)
);

CREATE INDEX IF NOT EXISTS idx_municipal_budgets_year_zone
    ON municipal_budgets(budget_year, zone_id, status);

CREATE TABLE IF NOT EXISTS budget_contract_commitments (
    commitment_id        BIGSERIAL PRIMARY KEY,
    budget_id            BIGINT NOT NULL REFERENCES municipal_budgets(budget_id) ON DELETE CASCADE,
    contract_id          INT NOT NULL REFERENCES municipal_contracts(contract_id) ON DELETE RESTRICT,
    committed_amount_inr NUMERIC(18,2) NOT NULL CHECK (committed_amount_inr >= 0),
    commitment_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    status               VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('PLANNED','ACTIVE','RELEASED','CLOSED')),
    notes                TEXT,
    created_by           INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(budget_id, contract_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_commitments_budget
    ON budget_contract_commitments(budget_id, status);
CREATE INDEX IF NOT EXISTS idx_budget_commitments_contract
    ON budget_contract_commitments(contract_id);

CREATE TABLE IF NOT EXISTS budget_expenditure_snapshots (
    snapshot_id          BIGSERIAL PRIMARY KEY,
    budget_id            BIGINT NOT NULL REFERENCES municipal_budgets(budget_id) ON DELETE CASCADE,
    as_of_date           DATE NOT NULL,
    committed_amount_inr NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (committed_amount_inr >= 0),
    invoice_basis_inr    NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (invoice_basis_inr >= 0),
    penalties_inr        NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (penalties_inr >= 0),
    net_payable_basis_inr NUMERIC(18,2) NOT NULL DEFAULT 0,
    remaining_budget_inr NUMERIC(18,2) NOT NULL DEFAULT 0,
    utilization_pct      NUMERIC(8,2),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(budget_id, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_budget_snapshot_date
    ON budget_expenditure_snapshots(as_of_date DESC, budget_id);

CREATE OR REPLACE FUNCTION touch_municipal_budget_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_municipal_budget_updated_at ON municipal_budgets;
CREATE TRIGGER trg_municipal_budget_updated_at
BEFORE UPDATE ON municipal_budgets
FOR EACH ROW EXECUTE FUNCTION touch_municipal_budget_updated_at();

CREATE OR REPLACE VIEW v_budget_expenditure_intelligence AS
SELECT
    b.budget_id,
    b.budget_year,
    b.budget_name,
    b.department,
    b.zone_id,
    z.zone_name,
    b.allocated_amount_inr,
    COALESCE(b.revised_amount_inr,b.allocated_amount_inr) AS effective_budget_inr,
    COALESCE(c.committed_amount_inr,0) AS committed_amount_inr,
    COALESCE(f.invoice_basis_inr,0) AS invoice_basis_inr,
    COALESCE(f.penalties_inr,0) AS penalties_inr,
    COALESCE(f.net_payable_basis_inr,0) AS net_payable_basis_inr,
    GREATEST(COALESCE(b.revised_amount_inr,b.allocated_amount_inr) - COALESCE(c.committed_amount_inr,0),0) AS uncommitted_budget_inr,
    GREATEST(COALESCE(b.revised_amount_inr,b.allocated_amount_inr) - COALESCE(f.net_payable_basis_inr,0),0) AS remaining_budget_basis_inr,
    CASE WHEN COALESCE(b.revised_amount_inr,b.allocated_amount_inr) > 0
         THEN ROUND(COALESCE(c.committed_amount_inr,0) / COALESCE(b.revised_amount_inr,b.allocated_amount_inr) * 100,2) END AS commitment_pct,
    CASE WHEN COALESCE(b.revised_amount_inr,b.allocated_amount_inr) > 0
         THEN ROUND(COALESCE(f.net_payable_basis_inr,0) / COALESCE(b.revised_amount_inr,b.allocated_amount_inr) * 100,2) END AS utilization_basis_pct
FROM municipal_budgets b
LEFT JOIN zones z ON z.zone_id=b.zone_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(bcc.committed_amount_inr) FILTER (WHERE bcc.status IN ('PLANNED','ACTIVE')),0) AS committed_amount_inr
    FROM budget_contract_commitments bcc
    WHERE bcc.budget_id=b.budget_id
) c ON TRUE
LEFT JOIN LATERAL (
    SELECT
        COALESCE(SUM(co.monthly_invoice_base),0) AS invoice_basis_inr,
        COALESCE(SUM(co.total_penalty_mtd),0) AS penalties_inr,
        COALESCE(SUM(co.monthly_invoice_base - co.total_penalty_mtd),0) AS net_payable_basis_inr
    FROM budget_contract_commitments bcc
    JOIN municipal_contracts mc ON mc.contract_id=bcc.contract_id
    JOIN contractors co ON co.contractor_id=mc.contractor_id
    WHERE bcc.budget_id=b.budget_id
      AND bcc.status IN ('PLANNED','ACTIVE')
) f ON TRUE;
