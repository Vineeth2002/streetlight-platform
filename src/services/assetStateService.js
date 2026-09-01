'use strict';

const db = require('../../config/database');

// These values must remain aligned with poles.current_status in db/001_schema.sql.
const VALID_STATES = new Set([
  'OPERATIONAL',
  'FAULTY',
  'UNDER_REPAIR',
  'DECOMMISSIONED',
  'DAY_BURN',
  'NO_SIGNAL'
]);

async function transitionPoleState({ poleNumber, nextState, source = 'SYSTEM', reason = null, observedAt = null }) {
  if (!poleNumber) throw new Error('poleNumber is required');
  if (!VALID_STATES.has(nextState)) throw new Error(`Unsupported pole state: ${nextState}`);

  return db.tx(async t => {
    const pole = await t.oneOrNone(
      `SELECT pole_id, pole_number, current_status FROM poles WHERE pole_number = $1 FOR UPDATE`,
      [poleNumber]
    );
    if (!pole) return { changed: false, reason: 'ASSET_NOT_FOUND' };

    // Telemetry must not overwrite an active repair or decommissioned state.
    if (source === 'TELEMETRY' && ['UNDER_REPAIR', 'DECOMMISSIONED'].includes(pole.current_status)) {
      return { changed: false, reason: 'STATE_OWNED_BY_WORKFLOW', pole };
    }
    if (pole.current_status === nextState) return { changed: false, reason: 'NO_CHANGE', pole };

    await t.none(
      `UPDATE poles SET current_status = $2, updated_at = NOW() WHERE pole_id = $1`,
      [pole.pole_id, nextState]
    );

    return {
      changed: true,
      previousState: pole.current_status,
      currentState: nextState,
      pole_id: pole.pole_id,
      pole_number: pole.pole_number,
      source,
      reason,
      observedAt: observedAt || new Date().toISOString()
    };
  });
}

async function applyTelemetryState({ poleNumber, healthy, signalPresent = true, source = 'TELEMETRY', observedAt = null }) {
  const pole = await db.oneOrNone(
    `SELECT p.pole_id, p.pole_number, p.current_status,
            EXISTS (
              SELECT 1 FROM work_orders wo
              WHERE wo.pole_id = p.pole_id
                AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
            ) AS has_active_work_order
       FROM poles p
      WHERE p.pole_number = $1`,
    [poleNumber]
  );

  if (!pole) return { changed: false, reason: 'ASSET_NOT_FOUND' };

  // Healthy telemetry is evidence of electrical recovery, not proof that an
  // active field repair has been completed. Human execution verification owns
  // the final transition to OPERATIONAL while a work order remains active.
  if (healthy && pole.has_active_work_order) {
    return { changed: false, reason: 'RECOVERY_REQUIRES_WORKFLOW_VERIFICATION', pole };
  }

  const nextState = !signalPresent ? 'NO_SIGNAL' : healthy ? 'OPERATIONAL' : 'FAULTY';
  return transitionPoleState({
    poleNumber,
    nextState,
    source,
    reason: signalPresent ? (healthy ? 'TELEMETRY_HEALTHY' : 'TELEMETRY_FAULT') : 'TELEMETRY_STALE',
    observedAt
  });
}

module.exports = { VALID_STATES, transitionPoleState, applyTelemetryState };
