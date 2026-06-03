CREATE OR REPLACE FUNCTION fn_set_sla_deadline()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.sla_deadline := NEW.reported_timestamp + INTERVAL '48 hours';
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_wo_set_sla_deadline
    BEFORE INSERT ON work_orders
    FOR EACH ROW EXECUTE FUNCTION fn_set_sla_deadline();

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_zones_updated_at       BEFORE UPDATE ON zones           FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_wards_updated_at       BEFORE UPDATE ON wards           FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_contractors_updated_at BEFORE UPDATE ON contractors      FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_jbox_updated_at        BEFORE UPDATE ON junction_boxes   FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_poles_updated_at       BEFORE UPDATE ON poles            FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_wo_updated_at          BEFORE UPDATE ON work_orders      FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE OR REPLACE FUNCTION fn_auto_flag_sla_violation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
       AND NOW() > NEW.sla_deadline THEN
        NEW.ticket_status := 'SLA_VIOLATED';
        NEW.days_overdue  := CEIL(EXTRACT(EPOCH FROM (NOW() - NEW.sla_deadline)) / 86400.0);
    END IF;
    IF NEW.ticket_status = 'RESOLVED' AND NEW.resolved_timestamp IS NOT NULL THEN
        NEW.days_overdue := GREATEST(0,
            CEIL(EXTRACT(EPOCH FROM (NEW.resolved_timestamp - NEW.sla_deadline)) / 86400.0)
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_wo_sla_check
    BEFORE INSERT OR UPDATE ON work_orders
    FOR EACH ROW EXECUTE FUNCTION fn_auto_flag_sla_violation();

CREATE OR REPLACE FUNCTION fn_sync_contractor_pending()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.contractor_id IS NOT NULL THEN
        UPDATE contractors
        SET total_pending = (
            SELECT COUNT(*) FROM work_orders
            WHERE contractor_id = NEW.contractor_id
              AND ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
        )
        WHERE contractor_id = NEW.contractor_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_wo_sync_contractor
    AFTER INSERT OR UPDATE ON work_orders
    FOR EACH ROW EXECUTE FUNCTION fn_sync_contractor_pending();

CREATE OR REPLACE FUNCTION fn_sync_pole_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.ticket_status = 'RESOLVED' THEN
        UPDATE poles SET current_status = 'OPERATIONAL'
        WHERE pole_id = NEW.pole_id
          AND current_status IN ('FAULTY','DAY_BURN','NO_SIGNAL');
    ELSIF NEW.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
          AND OLD.ticket_status = 'PENDING' THEN
        IF NEW.fault_category IN ('DRIVER_FAULT','LINE_FAULT','PHYSICAL_DAMAGE','CABLE_THEFT') THEN
            UPDATE poles SET current_status = 'FAULTY'   WHERE pole_id = NEW.pole_id;
        ELSIF NEW.fault_category = 'DAY_BURNING_FAULT' THEN
            UPDATE poles SET current_status = 'DAY_BURN' WHERE pole_id = NEW.pole_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_wo_sync_pole_status
    AFTER INSERT OR UPDATE ON work_orders
    FOR EACH ROW EXECUTE FUNCTION fn_sync_pole_status();