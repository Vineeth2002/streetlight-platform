-- 012_contractor_penalty_ledger.sql
-- Idempotent financial audit ledger for contractor penalties.

CREATE TABLE IF NOT EXISTS contractor_penalty_ledger (
    penalty_id          BIGSERIAL PRIMARY KEY,
    work_order_id       INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE RESTRICT,
    contractor_id       INT REFERENCES contractors(contractor_id) ON DELETE SET NULL,
    penalty_type        VARCHAR(10) NOT NULL CHECK (penalty_type IN ('ENERGY','DEMURRAGE')),
    amount_inr          NUMERIC(14,2) NOT NULL CHECK (amount_inr >= 0),
    days_overdue        INT NOT NULL DEFAULT 0 CHECK (days_overdue >= 0),
    assessed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assessed_by         INT REFERENCES users(user_id) ON DELETE SET NULL,
    calculation_basis   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_penalty_ledger_work_order
    ON contractor_penalty_ledger(work_order_id);
CREATE INDEX IF NOT EXISTS idx_penalty_ledger_contractor_date
    ON contractor_penalty_ledger(contractor_id, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_penalty_ledger_date
    ON contractor_penalty_ledger(assessed_at DESC);
