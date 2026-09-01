-- 012_penalty_ledger.sql
-- Append-only financial evidence for SLA penalties.
-- work_orders remains the operational source; this ledger preserves the
-- auditable monetary event so contractor totals cannot silently drift.

CREATE TABLE IF NOT EXISTS contractor_penalty_ledger (
    penalty_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_order_id    INT NOT NULL UNIQUE REFERENCES work_orders(work_order_id) ON DELETE RESTRICT,
    contractor_id    INT NOT NULL REFERENCES contractors(contractor_id) ON DELETE RESTRICT,
    penalty_amount   NUMERIC(12,2) NOT NULL CHECK (penalty_amount >= 0),
    penalty_type     VARCHAR(30) NOT NULL,
    days_overdue     INT NOT NULL CHECK (days_overdue >= 0),
    assessed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_penalty_ledger_contractor_time
    ON contractor_penalty_ledger(contractor_id, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_penalty_ledger_assessed_at
    ON contractor_penalty_ledger(assessed_at DESC);
