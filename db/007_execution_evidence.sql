-- Execution evidence and verification layer.
-- Preserves existing work_orders and adds append-only operational history.

CREATE TABLE IF NOT EXISTS work_order_events (
    event_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_order_id   INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    from_status     VARCHAR(30),
    to_status       VARCHAR(30) NOT NULL,
    changed_by      INT,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes           TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_wo_events_work_order_time
    ON work_order_events(work_order_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS work_order_evidence (
    evidence_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_order_id   INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    evidence_type   VARCHAR(30) NOT NULL CHECK (evidence_type IN ('BEFORE','AFTER','INSPECTION','GPS','DOCUMENT','OTHER')),
    uri             TEXT NOT NULL,
    captured_at     TIMESTAMPTZ,
    latitude        NUMERIC(10,7),
    longitude       NUMERIC(10,7),
    captured_by     INT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wo_evidence_work_order
    ON work_order_evidence(work_order_id, evidence_type, captured_at DESC);

CREATE TABLE IF NOT EXISTS work_order_verifications (
    verification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_order_id   INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    result          VARCHAR(15) NOT NULL CHECK (result IN ('PASS','FAIL','PARTIAL')),
    verified_by     INT NOT NULL,
    verified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes           TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_wo_verifications_work_order
    ON work_order_verifications(work_order_id, verified_at DESC);
