-- 083_work_order_resolution_timestamp_governance.sql
-- The resolution timestamp is workflow-owned. It may only be populated when
-- an IN_PROGRESS work order transitions to RESOLVED through the lifecycle path.

CREATE OR REPLACE FUNCTION enforce_work_order_resolution_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.resolved_timestamp IS DISTINCT FROM OLD.resolved_timestamp THEN
    IF NOT (
      OLD.ticket_status = 'IN_PROGRESS'
      AND NEW.ticket_status = 'RESOLVED'
      AND NEW.resolved_timestamp IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'resolved_timestamp is workflow-controlled and may only be set during IN_PROGRESS to RESOLVED transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_orders_resolution_timestamp ON work_orders;

CREATE TRIGGER trg_work_orders_resolution_timestamp
BEFORE UPDATE OF resolved_timestamp ON work_orders
FOR EACH ROW
EXECUTE FUNCTION enforce_work_order_resolution_timestamp();

COMMENT ON FUNCTION enforce_work_order_resolution_timestamp() IS
  'Prevents direct mutation of resolved_timestamp; only an IN_PROGRESS to RESOLVED workflow transition may populate it.';
