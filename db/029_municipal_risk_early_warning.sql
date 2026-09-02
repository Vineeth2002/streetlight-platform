-- 029_municipal_risk_early_warning.sql
-- Advisory early-warning layer. Never changes pole state, work orders, SLA rules,
-- penalties, or glow-rate calculations.
CREATE TABLE IF NOT EXISTS municipal_risk_alerts (
 risk_alert_id BIGSERIAL PRIMARY KEY, zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
 ward_id INT REFERENCES wards(ward_id) ON DELETE SET NULL, pole_id INT REFERENCES poles(pole_id) ON DELETE SET NULL,
 risk_type VARCHAR(40) NOT NULL CHECK (risk_type IN ('ASSET_DETERIORATION','FAILURE_CLUSTER','SLA_EXPOSURE','CONTRACTOR_CONCENTRATION','REPLACEMENT_PRESSURE','INTERVENTION_EFFECTIVENESS','MULTI_SIGNAL')),
 severity VARCHAR(10) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')), risk_score NUMERIC(5,2) NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
 title VARCHAR(250) NOT NULL, rationale JSONB NOT NULL DEFAULT '{}'::jsonb,
 status VARCHAR(15) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED')),
 detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), acknowledged_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ,
 acknowledged_by INT REFERENCES users(user_id) ON DELETE SET NULL, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_municipal_risk_alerts_scope ON municipal_risk_alerts(zone_id,ward_id,severity,status);
CREATE INDEX IF NOT EXISTS idx_municipal_risk_alerts_pole ON municipal_risk_alerts(pole_id,risk_type,status);
CREATE INDEX IF NOT EXISTS idx_municipal_risk_alerts_detected ON municipal_risk_alerts(detected_at DESC,severity);

CREATE OR REPLACE VIEW v_municipal_early_warnings AS
WITH asset AS (
 SELECT p.pole_id,p.road_name,jb.ward_id,w.ward_number,z.zone_id,z.zone_name,p.current_status,
 COALESCE(h.health_score,100)::numeric AS health_score,COALESCE(r.risk_score,0)::numeric AS reliability_risk,
 COALESCE(fp.fault_episodes_365d,0)::int AS failures_365d,COALESCE(fp.work_orders_365d,0)::int AS work_orders_365d,
 COALESCE(fp.sla_violations_365d,0)::int AS sla_violations_365d,COALESCE(fp.failure_pattern,'NONE') AS failure_pattern,
 COALESCE(hs.hotspot_band,'LOW') AS hotspot_band,COALESCE(rc.root_cause_count,0)::int AS root_cause_count,
 COALESCE(wo.open_count,0)::int AS open_work_orders,COALESCE(wo.open_sla_count,0)::int AS open_sla_exposure
 FROM poles p
 LEFT JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id LEFT JOIN wards w ON w.ward_id=jb.ward_id LEFT JOIN zones z ON z.zone_id=w.zone_id
 LEFT JOIN LATERAL (SELECT health_score FROM v_asset_health_index x WHERE x.pole_id=p.pole_id LIMIT 1) h ON TRUE
 LEFT JOIN LATERAL (SELECT risk_score FROM asset_reliability_snapshots x WHERE x.pole_id=p.pole_id ORDER BY x.as_of DESC LIMIT 1) r ON TRUE
 LEFT JOIN LATERAL (SELECT fault_episodes_365d,work_orders_365d,sla_violations_365d,failure_pattern FROM v_asset_failure_patterns x WHERE x.pole_id=p.pole_id LIMIT 1) fp ON TRUE
 LEFT JOIN LATERAL (SELECT hotspot_band FROM v_spatial_failure_hotspots x WHERE x.zone_id=z.zone_id AND x.ward_id=w.ward_id ORDER BY CASE x.hotspot_band WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END LIMIT 1) hs ON TRUE
 LEFT JOIN LATERAL (SELECT COUNT(*) FILTER(WHERE ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED'))::int open_count, COUNT(*) FILTER(WHERE ticket_status='SLA_VIOLATED')::int open_sla_count FROM work_orders WHERE pole_id=p.pole_id) wo ON TRUE
 LEFT JOIN LATERAL (SELECT COUNT(*)::int root_cause_count FROM incident_root_causes x WHERE x.pole_id=p.pole_id AND x.determined_at>=NOW()-INTERVAL '365 days') rc ON TRUE
 WHERE p.current_status<>'DECOMMISSIONED'
), scored AS (
 SELECT a.*,LEAST(100,ROUND(
 (CASE WHEN health_score<40 THEN 25 WHEN health_score<60 THEN 18 WHEN health_score<75 THEN 10 ELSE 0 END)+
 (CASE WHEN reliability_risk>=80 THEN 25 WHEN reliability_risk>=60 THEN 18 WHEN reliability_risk>=40 THEN 10 ELSE 0 END)+
 (CASE WHEN open_sla_exposure>=2 THEN 20 WHEN open_sla_exposure=1 THEN 12 WHEN sla_violations_365d>=1 THEN 6 ELSE 0 END)+
 (CASE WHEN failure_pattern='SYSTEMIC' THEN 15 WHEN failure_pattern='RECURRING' THEN 10 WHEN failure_pattern='ISOLATED' THEN 3 ELSE 0 END)+
 (CASE hotspot_band WHEN 'CRITICAL' THEN 10 WHEN 'HIGH' THEN 7 WHEN 'MEDIUM' THEN 4 ELSE 0 END)+
 (CASE WHEN root_cause_count>=3 THEN 5 WHEN root_cause_count>=1 THEN 2 ELSE 0 END),2)) AS risk_score
 FROM asset a)
SELECT *,CASE WHEN risk_score>=85 THEN 'CRITICAL' WHEN risk_score>=70 THEN 'HIGH' WHEN risk_score>=50 THEN 'MEDIUM' ELSE 'LOW' END severity,
CASE WHEN risk_score>=85 THEN 'Multiple independent signals indicate material near-term municipal risk.' WHEN risk_score>=70 THEN 'Several deterioration, recurrence, SLA, or spatial signals are converging.' WHEN risk_score>=50 THEN 'Emerging risk warrants planned review before failure concentration increases.' ELSE 'No strong multi-signal early-warning condition detected.' END warning
FROM scored;
