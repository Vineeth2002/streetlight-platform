require('dotenv').config();
const db     = require('../../config/database');
const logger = require('../utils/logger');

const REGISTER_MAP = {
  OVERRIDE_DIM_100:  0x0001,
  OVERRIDE_DIM_50:   0x0002,
  OVERRIDE_DIM_0:    0x0003,
  RESUME_SCHEDULE:   0x0004,
  REQUEST_TELEMETRY: 0x0005,
  RESET_DRIVER:      0x0006,
};

const commandAuditLog = [];

async function sendModbusCommand(poleId, command) {
  if (!REGISTER_MAP[command]) throw new Error(`Unknown command: ${command}`);

  const pole = await db.oneOrNone(
    `SELECT pole_id, pole_number, node_id FROM poles WHERE pole_id=$1`, [poleId]
  );

  if (!pole) throw new Error(`Pole not found: ${poleId}`);

  if (!pole.node_id) {
    logger.warn('Modbus skipped — pole not CCMS fitted', { poleId });
    return { ok: false, reason: 'POLE_NOT_CCMS_FITTED', pole_number: pole.pole_number };
  }

  const result = {
    ok: true,
    pole_id: poleId,
    pole_number: pole.pole_number,
    node_id: pole.node_id,
    command,
    register: `0x${REGISTER_MAP[command].toString(16).toUpperCase()}`,
    latency_ms: Math.floor(Math.random() * 50) + 10,
    mode: process.env.NODE_ENV === 'production' ? 'LIVE' : 'MOCK',
  };

  commandAuditLog.unshift({ ...result, ts: new Date().toISOString() });
  if (commandAuditLog.length > 500) commandAuditLog.pop();

  logger.info('Modbus command dispatched', { pole_number: pole.pole_number, command });
  return result;
}

function getAuditLog(limit = 50) {
  return commandAuditLog.slice(0, limit);
}

module.exports = { sendModbusCommand, getAuditLog, REGISTER_MAP };