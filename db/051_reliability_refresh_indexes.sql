-- 051_reliability_refresh_indexes.sql
-- Supports incremental reliability refresh by locating work orders changed
-- since the previous reliability snapshot run without scanning all work orders.

CREATE INDEX IF NOT EXISTS idx_wo_updated_pole
    ON work_orders(updated_at DESC, pole_id);
