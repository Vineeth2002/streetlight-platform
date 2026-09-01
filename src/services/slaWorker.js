'use strict';

const logger = require('../utils/logger');
const { scanOpenWorkOrders } = require('./slaEngine');

let timer = null;
let running = false;

async function runSlaSweep() {
  if (running) return;
  running = true;
  try {
    const results = await scanOpenWorkOrders();
    const breached = results.filter(r => r.state === 'BREACHED').length;
    const atRisk = results.filter(r => r.state === 'AT_RISK').length;
    if (breached || atRisk) logger.warn('SLA sweep', { checked: results.length, at_risk: atRisk, breached });
  } catch (err) {
    logger.error('SLA sweep failed', { error: err.message });
  } finally {
    running = false;
  }
}

function startSlaWorker(intervalMs = Number(process.env.SLA_SCAN_INTERVAL_MS) || 60000) {
  if (timer) return timer;
  runSlaSweep();
  timer = setInterval(runSlaSweep, Math.max(intervalMs, 10000));
  return timer;
}

function stopSlaWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startSlaWorker, stopSlaWorker, runSlaSweep };
