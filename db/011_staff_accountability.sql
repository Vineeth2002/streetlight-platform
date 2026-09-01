-- 011_staff_accountability.sql
-- Link work-order execution and evidence actors to the existing users identity table.
-- Preserve the existing users table as the single staff identity source of truth.

ALTER TABLE work_orders
    ADD COLUMN IF NOT EXISTS assigned_to INT
        REFERENCES users(user_id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_work_order_events_changed_by_users'
    ) THEN
        ALTER TABLE work_order_events
            ADD CONSTRAINT fk_work_order_events_changed_by_users
            FOREIGN KEY (changed_by) REFERENCES users(user_id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_work_order_evidence_captured_by_users'
    ) THEN
        ALTER TABLE work_order_evidence
            ADD CONSTRAINT fk_work_order_evidence_captured_by_users
            FOREIGN KEY (captured_by) REFERENCES users(user_id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_work_order_verifications_verified_by_users'
    ) THEN
        ALTER TABLE work_order_verifications
            ADD CONSTRAINT fk_work_order_verifications_verified_by_users
            FOREIGN KEY (verified_by) REFERENCES users(user_id) ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_work_orders_assigned_to
    ON work_orders(assigned_to);

CREATE INDEX IF NOT EXISTS idx_work_order_events_changed_by
    ON work_order_events(changed_by);

CREATE INDEX IF NOT EXISTS idx_work_order_evidence_captured_by
    ON work_order_evidence(captured_by);

CREATE INDEX IF NOT EXISTS idx_work_order_verifications_verified_by
    ON work_order_verifications(verified_by);
