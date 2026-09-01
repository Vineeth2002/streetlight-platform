-- Runtime SLA/escalation state. Keeps contractual policy separate from work execution.

CREATE TABLE IF NOT EXISTS sla_events (
    sla_event_id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_order_id   INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    event_type      VARCHAR(30) NOT NULL CHECK (event_type IN ('WARNING','AT_RISK','BREACH','ESCALATION','RECOVERY')),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    hours_remaining NUMERIC(12,2),
    hours_overdue   NUMERIC(12,2),
    escalation_level INT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_sla_events_work_order_time
    ON sla_events(work_order_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS escalation_events (
    escalation_id   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_order_id   INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    level           INT NOT NULL,
    reason          VARCHAR(40) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by INT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_escalation_work_order_time
    ON escalation_events(work_order_id, created_at DESC);
