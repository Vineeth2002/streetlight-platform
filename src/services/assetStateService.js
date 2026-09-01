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
