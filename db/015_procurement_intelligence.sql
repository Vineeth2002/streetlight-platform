-- 015_procurement_intelligence.sql
-- Procurement lifecycle is auditable and linked to municipal contracts.
-- It does not alter SLA rules, penalty formulas, or glow-rate calculations.

ALTER TABLE procurement_records
    ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS procurement_events (
    event_id        BIGSERIAL PRIMARY KEY,
    procurement_id  INT NOT NULL REFERENCES procurement_records(procurement_id) ON DELETE CASCADE,
    from_status     VARCHAR(20),
    to_status       VARCHAR(20) NOT NULL,
    changed_by      INT REFERENCES users(user_id) ON DELETE SET NULL,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes           TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_procurement_events_procurement_time
    ON procurement_events(procurement_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_contract
    ON procurement_records(contract_id, award_date DESC);

CREATE OR REPLACE FUNCTION touch_procurement_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_procurement_updated_at ON procurement_records;
CREATE TRIGGER trg_procurement_updated_at
BEFORE UPDATE ON procurement_records
FOR EACH ROW EXECUTE FUNCTION touch_procurement_updated_at();
