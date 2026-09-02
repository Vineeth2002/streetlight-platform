-- 082_work_order_state_machine.sql
-- Enforce the authoritative work-order lifecycle at the database boundary.
-- SLA_VIOLATED remains worker-controlled and is intentionally excluded from
-- the public status transition endpoint.

CREATE OR REPLACE FUNCTION enforce_work_order_state_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ticket_status = OLD.ticket_status THEN
    RETURN NEW;
  END IF;

  IF OLD.ticket_status = 'PENDING' AND NEW.ticket_status IN ('ASSIGNED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  IF OLD.ticket_status = 'ASSIGNED' AND NEW.ticket_status IN ('IN_PROGRESS', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  IF OLD.ticket_status = 'IN_PROGRESS' AND NEW.ticket_status IN ('RESOLVED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  -- SLA watchdog is the only lifecycle component allowed to mark a ticket
  -- SLA_VIOLATED. Existing SLA runtime logic remains authoritative for that
  -- transition; this trigger therefore permits the state transition itself.
  IF NEW.ticket_status = 'SLA_VIOLATED'
     AND OLD.ticket_status IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS') THEN
    RETURN NEW;
  END IF;

  -- A watchdog may also continue operating on an already violated ticket only
  -- through its existing worker logic; ordinary API lifecycle transitions must
  -- not move SLA_VIOLATED back into the normal workflow.
  IF OLD.ticket_status = 'SLA_VIOLATED' THEN
    RAISE EXCEPTION 'Invalid work order transition from SLA_VIOLATED to %', NEW.ticket_status
      USING ERRCODE = '23514';
  END IF;

  RAISE EXCEPTION 'Invalid work order transition from % to %',
    OLD.ticket_status, NEW.ticket_status
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_work_orders_state_machine ON work_orders;

CREATE TRIGGER trg_work_orders_state_machine
BEFORE UPDATE OF ticket_status ON work_orders
FOR EACH ROW
EXECUTE FUNCTION enforce_work_order_state_transition();

COMMENT ON FUNCTION enforce_work_order_state_transition() IS
  'Authoritative work-order lifecycle guard: PENDING→ASSIGNED/CANCELLED, ASSIGNED→IN_PROGRESS/CANCELLED, IN_PROGRESS→RESOLVED/CANCELLED, and worker-controlled SLA_VIOLATED.';
