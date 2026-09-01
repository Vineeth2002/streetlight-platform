-- Execution evidence integrity constraints.
-- Does not alter SLA logic or asset glow-rate calculations.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_work_order_evidence_gps_pair'
    ) THEN
        ALTER TABLE work_order_evidence
            ADD CONSTRAINT ck_work_order_evidence_gps_pair
            CHECK ((latitude IS NULL AND longitude IS NULL)
                OR (latitude IS NOT NULL AND longitude IS NOT NULL));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_work_order_evidence_latitude_range'
    ) THEN
        ALTER TABLE work_order_evidence
            ADD CONSTRAINT ck_work_order_evidence_latitude_range
            CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_work_order_evidence_longitude_range'
    ) THEN
        ALTER TABLE work_order_evidence
            ADD CONSTRAINT ck_work_order_evidence_longitude_range
            CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wo_evidence_type_gps
    ON work_order_evidence(work_order_id, evidence_type, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_wo_verifications_latest
    ON work_order_verifications(work_order_id, verified_at DESC);
