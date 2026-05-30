require('dotenv').config();
const db     = require('../../config/database');
const logger = require('../utils/logger');

const THRESHOLDS = {
  MIN_VOLTAGE:             parseFloat(process.env.DIAG_MIN_VOLTAGE)               || 180,
  MIN_CURRENT_DAY_BURN:    parseFloat(process.env.DIAG_MIN_CURRENT_DAY_BURN)      || 0.05,
  FLUCTUATION_THRESHOLD:   parseFloat(process.env.DIAG_FLUCTUATION_THRESHOLD_PCT) || 15,
  FLUCTUATION_WINDOW_SECS: parseInt(process.env.DIAG_FLUCTUATION_WINDOW_SECONDS)  || 60,
};

const _currentWindows = new Map();

function _updateCurrentWindow(poleNumber, currentRms) {
  const now = Date.now();
  if (!_currentWindows.has(poleNumber)) _currentWindows.set(poleNumber, []);
  const window = _currentWindows.get(poleNumber);
  window.push({ ts: now, i: currentRms });
  const cutoff = now - (THRESHOLDS.FLUCTUATION_WINDOW_SECS * 1000);
  const pruned = window.filter(r => r.ts >= cutoff);
  _currentWindows.set(poleNumber, pruned);
  return pruned;
}

function _evaluateFluctuation(window) {
  if (window.length < 3) return false;
  const values = window.map(r => r.i);
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === 0) return false;
  return ((max - min) / max) * 100 > THRESHOLDS.FLUCTUATION_THRESHOLD;
}

function diagnose(reading) {
  const {
    poleNumber,
    voltageRms: V,
    currentRms: I,
    activePower: P,
    powerFactor: PF = 0.9,
    cabinetOn,
    wiringType,
  } = reading;

  if (cabinetOn && V > THRESHOLDS.MIN_VOLTAGE && I === 0) {
    logger.warn('DRIVER_FAULT detected', { poleNumber, V, I });
    return {
      status: 'DRIVER_FAULT', severity: 'MEDIUM', priority: 'NORMAL',
      message: `Pole ${poleNumber}: LED driver failure. V=${V}V, I=0A.`,
      createWorkOrder: true, faultCategory: 'DRIVER_FAULT', watts_wasted: 0,
    };
  }

  if (cabinetOn && V === 0 && I === 0) {
    const isOverhead = wiringType === 'OVERHEAD';
    logger.error('LINE_FAULT detected', { poleNumber, wiringType });
    return {
      status: 'LINE_FAULT',
      severity: isOverhead ? 'CRITICAL' : 'HIGH',
      priority: isOverhead ? 'CRITICAL' : 'HIGH',
      message: `Pole ${poleNumber}: ${isOverhead ? '[CRITICAL] ' : ''}Cable fault. Wiring: ${wiringType}.`,
      createWorkOrder: true, faultCategory: 'LINE_FAULT', watts_wasted: 0,
    };
  }

  if (!cabinetOn && V > THRESHOLDS.MIN_VOLTAGE && I > THRESHOLDS.MIN_CURRENT_DAY_BURN) {
    const watts = parseFloat((V * I * PF).toFixed(3));
    logger.warn('DAY_BURNING_FAULT detected', { poleNumber, watts });
    return {
      status: 'DAY_BURNING_FAULT', severity: 'MEDIUM', priority: 'HIGH',
      message: `Pole ${poleNumber}: Day-burning. Cabinet OFF but active. Wasted: ${watts}W.`,
      createWorkOrder: true, faultCategory: 'DAY_BURNING_FAULT', watts_wasted: watts,
    };
  }

  const window = _updateCurrentWindow(poleNumber, I);
  if (_evaluateFluctuation(window)) {
    logger.warn('PREDICTIVE_DEGRADATION detected', { poleNumber });
    return {
      status: 'PREDICTIVE_DEGRADATION', severity: 'LOW', priority: 'SCHEDULED',
      message: `Pole ${poleNumber}: Current unstable over 60s. Salt-air PCB decay suspected.`,
      createWorkOrder: false, faultCategory: 'PREDICTIVE_DEGRADATION', watts_wasted: 0,
    };
  }

  return {
    status: 'NOMINAL', severity: 'NONE', priority: 'NONE',
    message: `Pole ${poleNumber}: OK. V=${V}V, I=${I}A, P=${P}W.`,
    createWorkOrder: false, faultCategory: null, watts_wasted: 0,
  };
}

async function createAutoWorkOrder(poleId, faultCategory, description) {
  try {
    const contractorRow = await db.oneOrNone(`
      SELECT c.contractor_id FROM poles p
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN contractors c ON c.assigned_zone_id = z.zone_id
      WHERE p.pole_id = $1 LIMIT 1
    `, [poleId]);

    const existing = await db.oneOrNone(`
      SELECT work_order_id FROM work_orders
      WHERE pole_id = $1 AND fault_category = $2
        AND ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
      LIMIT 1
    `, [poleId, faultCategory]);

    if (existing) return { suppressed: true, existing_id: existing.work_order_id };

    const workOrder = await db.one(`
      INSERT INTO work_orders
        (pole_id, contractor_id, fault_category, fault_description, reported_by)
      VALUES ($1, $2, $3, $4, 'SYSTEM_DIAGNOSTIC') RETURNING *
    `, [poleId, contractorRow?.contractor_id || null, faultCategory, description]);

    logger.info('Work order auto-created', { work_order_id: workOrder.work_order_id });
    return workOrder;
  } catch (err) {
    logger.error('Failed to create work order', { error: err.message });
    throw err;
  }
}

module.exports = { diagnose, createAutoWorkOrder };