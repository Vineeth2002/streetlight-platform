require('dotenv').config();
const db     = require('../../config/database');
const logger = require('../utils/logger');

const MODEL_VERSION = 'rule-based-v1';

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

// ─── HISTORY LOOKUP — feeds confidence scoring ───────────────────────────────
// Checks how many prior faults this exact pole has had. A pole with repeat
// failures shifts confidence toward "recurring hardware issue" rather than
// a one-off. This is a simple heuristic today — the same signal a future
// real ML model would use, just computed by hand for now.
async function _getPriorFaultCount(poleNumber) {
  try {
    const row = await db.oneOrNone(`
      SELECT COUNT(*) AS cnt FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      WHERE p.pole_number = $1
    `, [poleNumber]);
    return parseInt(row?.cnt || 0);
  } catch (err) {
    return 0;
  }
}

// ─── CORE DIAGNOSIS — now returns MULTIPLE possible causes with confidence ───
// IMPORTANT: These confidence percentages are rule-based ESTIMATES, not
// output from a trained model. There is no real fault history to learn
// from yet. Once fault_feedback accumulates real verified corrections
// from field engineers, a real model can replace this — model_version
// will change from 'rule-based-v1' so it's always clear which era of
// logic produced any given historical recommendation.
async function diagnose(reading) {
  const {
    poleNumber,
    voltageRms: V,
    currentRms: I,
    activePower: P,
    powerFactor: PF = 0.9,
    cabinetOn,
    wiringType,
  } = reading;

  const priorFaults = await _getPriorFaultCount(poleNumber);

  // ── Case 1: Driver / cable ambiguity when cabinet is ON but no current ──
  if (cabinetOn && V > THRESHOLDS.MIN_VOLTAGE && I === 0) {
    // Two real possibilities here that a single-fault-code hides:
    // the driver itself failed, OR the cable segment between the
    // cabinet and the pole failed. Voltage-present-but-no-current
    // alone can't fully distinguish them — a field engineer needs
    // to actually check. So we present both, weighted by history.
    const driverConfidence = priorFaults > 0 ? 62 : 72;
    const cableConfidence  = 100 - driverConfidence - 8;
    const possibleCauses = [
      { fault: 'DRIVER_FAULT', confidence: driverConfidence,
        reason: 'Voltage present, zero current — classic driver failure signature' },
      { fault: 'LINE_FAULT', confidence: cableConfidence,
        reason: 'Cannot fully rule out a downstream cable break from electrical signature alone' },
      { fault: 'PREDICTIVE_DEGRADATION', confidence: 8,
        reason: priorFaults > 1 ? `Pole has ${priorFaults} prior tickets — chronic issue possible` : 'Low likelihood, included for completeness' },
    ];
    const top = possibleCauses[0];

    logger.warn('Multi-cause diagnosis: driver/cable ambiguity', { poleNumber, priorFaults });

    return {
      status: 'RECOMMENDATION',
      recommendedFault: top.fault,
      confidencePct: top.confidence,
      possibleCauses,
      severity: 'MEDIUM',
      priority: 'NORMAL',
      message: `Pole ${poleNumber}: Likely ${top.fault} (${top.confidence}% confidence). Verification required.`,
      createWorkOrder: true,
      modelVersion: MODEL_VERSION,
      evidence: { voltage: V, current: I, prior_faults_at_pole: priorFaults },
      watts_wasted: 0,
    };
  }

  // ── Case 2: No supply at all — line fault, high confidence but not certain ──
  if (cabinetOn && V === 0 && I === 0) {
    const isOverhead = wiringType === 'OVERHEAD';
    const lineFaultConfidence = isOverhead ? 78 : 70;
    const possibleCauses = [
      { fault: 'LINE_FAULT', confidence: lineFaultConfidence,
        reason: `No voltage or current — ${wiringType} wiring, ${isOverhead ? 'higher' : 'lower'} baseline failure rate` },
      { fault: 'CABLE_THEFT', confidence: isOverhead ? 15 : 5,
        reason: isOverhead ? 'Overhead copper theft is a known regional risk pattern' : 'Underground theft less common but not impossible' },
      { fault: 'CABINET_FAULT', confidence: 100 - lineFaultConfidence - (isOverhead ? 15 : 5),
        reason: 'Upstream cabinet/fuse failure would present identically from this pole\'s perspective' },
    ];
    const top = possibleCauses[0];

    logger.error('Multi-cause diagnosis: no-supply condition', { poleNumber, wiringType, priorFaults });

    return {
      status: 'RECOMMENDATION',
      recommendedFault: top.fault,
      confidencePct: top.confidence,
      possibleCauses,
      severity: isOverhead ? 'CRITICAL' : 'HIGH',
      priority: isOverhead ? 'CRITICAL' : 'HIGH',
      message: `Pole ${poleNumber}: ${isOverhead ? '[CRITICAL] ' : ''}Likely ${top.fault} (${top.confidence}% confidence). Verification required.`,
      createWorkOrder: true,
      modelVersion: MODEL_VERSION,
      evidence: { voltage: V, current: I, wiring_type: wiringType, prior_faults_at_pole: priorFaults },
      watts_wasted: 0,
    };
  }

  // ── Case 3: Day burning — cabinet OFF but pole still drawing power ──
  if (!cabinetOn && V > THRESHOLDS.MIN_VOLTAGE && I > THRESHOLDS.MIN_CURRENT_DAY_BURN) {
    const watts = parseFloat((V * I * PF).toFixed(3));
    const possibleCauses = [
      { fault: 'DAY_BURNING_FAULT', confidence: 88,
        reason: 'Cabinet commanded OFF but pole actively drawing power — photocell/timer relay is the near-certain cause' },
      { fault: 'CABINET_FAULT', confidence: 12,
        reason: 'Relay itself could be physically stuck rather than the photocell sensor being faulty' },
    ];
    const top = possibleCauses[0];

    logger.warn('Multi-cause diagnosis: day burning', { poleNumber, watts });

    return {
      status: 'RECOMMENDATION',
      recommendedFault: top.fault,
      confidencePct: top.confidence,
      possibleCauses,
      severity: 'MEDIUM',
      priority: 'HIGH',
      message: `Pole ${poleNumber}: Likely ${top.fault} (${top.confidence}% confidence). Wasted: ${watts}W. Verification required.`,
      createWorkOrder: true,
      modelVersion: MODEL_VERSION,
      evidence: { voltage: V, current: I, watts_wasted: watts },
      watts_wasted: watts,
    };
  }

  // ── Case 4: Predictive degradation — fluctuating current, not yet failed ──
  const window = _updateCurrentWindow(poleNumber, I);
  if (_evaluateFluctuation(window)) {
    logger.warn('Multi-cause diagnosis: predictive degradation', { poleNumber });

    const possibleCauses = [
      { fault: 'PREDICTIVE_DEGRADATION', confidence: 65,
        reason: 'Current unstable over 60s window — early-stage PCB/driver decay pattern' },
      { fault: 'DRIVER_FAULT', confidence: 20,
        reason: 'Could already be an intermittent driver fault rather than gradual decay' },
      { fault: 'NONE_MONITOR_ONLY', confidence: 15,
        reason: 'Could be transient grid noise unrelated to the pole itself — recommend monitoring before dispatch' },
    ];
    const top = possibleCauses[0];

    return {
      status: 'RECOMMENDATION',
      recommendedFault: top.fault,
      confidencePct: top.confidence,
      possibleCauses,
      severity: 'LOW',
      priority: 'SCHEDULED',
      message: `Pole ${poleNumber}: Current unstable. Likely ${top.fault} (${top.confidence}% confidence). Salt-air PCB decay suspected but not confirmed.`,
      createWorkOrder: false,
      modelVersion: MODEL_VERSION,
      evidence: { voltage: V, current_window: window.map(w => w.i) },
      watts_wasted: 0,
    };
  }

  return {
    status: 'NOMINAL',
    recommendedFault: null,
    confidencePct: null,
    possibleCauses: [],
    severity: 'NONE',
    priority: 'NONE',
    message: `Pole ${poleNumber}: OK. V=${V}V, I=${I}A, P=${P}W.`,
    createWorkOrder: false,
    modelVersion: MODEL_VERSION,
    evidence: null,
    watts_wasted: 0,
  };
}

// ─── AUTO WORK ORDER CREATION — now stores recommendation, not certainty ─────
async function createAutoWorkOrder(poleId, diagnosis, description) {
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
      WHERE pole_id = $1 AND recommended_fault = $2
        AND ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
      LIMIT 1
    `, [poleId, diagnosis.recommendedFault]);

    if (existing) return { suppressed: true, existing_id: existing.work_order_id };

    const workOrder = await db.one(`
      INSERT INTO work_orders
        (pole_id, contractor_id, fault_category, fault_description, reported_by,
         recommended_fault, confidence_pct, possible_causes, model_version, severity_hint)
      VALUES ($1, $2, $3, $4, 'SYSTEM_DIAGNOSTIC', $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      poleId,
      contractorRow?.contractor_id || null,
      diagnosis.recommendedFault,
      description,
      diagnosis.recommendedFault,
      diagnosis.confidencePct,
      JSON.stringify(diagnosis.possibleCauses),
      diagnosis.modelVersion,
      diagnosis.severity,
    ]);

    logger.info('Work order created from recommendation', {
      work_order_id: workOrder.work_order_id,
      recommended_fault: diagnosis.recommendedFault,
      confidence_pct: diagnosis.confidencePct,
    });
    return workOrder;
  } catch (err) {
    logger.error('Failed to create work order', { error: err.message });
    throw err;
  }
}

module.exports = { diagnose, createAutoWorkOrder };