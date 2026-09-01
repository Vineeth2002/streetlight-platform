'use strict';

const { reconcileStaleNodes } = require('./telemetryReconciler');
const logger = require('../utils/logger');

let timer = null;

function startReconciliationWorker({ intervalMs = Number(process.env.RECONCILIATION_INTERVAL_MS || 300000), staleMinutes = Number(process.env.STALE_TELEMETRY_MINUTES || 15) } = {}) {
  if (timer) return timer;
  const run = async () => {
    try {
      const changed = await reconcileStaleNodes({ staleMinutes });
      if (changed.length) logger.warn('Telemetry reconciliation marked nodes as NO_SIGNAL', { count: changed.length });
    } catch (err) {
      logger.error('Telemetry reconciliation failed', { error: err.message });
    }
  };
  run();
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

function stopReconciliationWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startReconciliationWorker, stopReconciliationWorker };
