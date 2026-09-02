-- 051_program_event_append_only.sql
-- Enforce municipal program lifecycle events as immutable audit history.
-- Events may be appended, but existing events cannot be updated or deleted.
-- This does not alter lifecycle transitions or operational behavior.

CREATE OR REPLACE FUNCTION prevent_municipal_program_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'municipal_program_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_municipal_program_events_append_only ON municipal_program_events;
CREATE TRIGGER trg_municipal_program_events_append_only
BEFORE UPDATE OR DELETE ON municipal_program_events
FOR EACH ROW EXECUTE FUNCTION prevent_municipal_program_event_mutation();

COMMENT ON TABLE municipal_program_events IS
  'Append-only lifecycle audit history. Existing events cannot be updated or deleted.';
