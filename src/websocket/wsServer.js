const WebSocket = require('ws');
const logger    = require('../utils/logger');

let wss = null;
const clientTopics = new Map();

function initWsServer(httpServer) {
  wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.info('WS client connected', { ip });
    clientTopics.set(ws, new Set(['*']));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'subscribe' && Array.isArray(msg.topics)) {
          clientTopics.set(ws, new Set(msg.topics));
          ws.send(JSON.stringify({ type: 'SUBSCRIBED', topics: msg.topics }));
        }
        if (msg.action === 'ping') ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
      } catch {}
    });

    ws.on('close', () => clientTopics.delete(ws));
    ws.on('error', (err) => logger.error('WS error', { ip, error: err.message }));

    ws.send(JSON.stringify({
      type: 'CONNECTED',
      message: 'Visakhapatnam Streetlight Platform — live feed active',
      poles: 200000,
      ts: Date.now(),
    }));
  });

  logger.info('WebSocket server initialised');
  return wss;
}

function broadcast(topic, payload) {
  if (!wss) return;
  const message = JSON.stringify({ topic, ...payload, ts: Date.now() });
  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const subs = clientTopics.get(ws);
    if (subs && (subs.has('*') || subs.has(topic))) ws.send(message);
  });
}

function broadcastNodeTelemetry(poleNumber, telemetry, diagnosis) {
  broadcast('NODE', { type: 'TELEMETRY', pole_number: poleNumber, telemetry, diagnosis });
}

function broadcastAttachmentTelemetry(sensorType, attachmentId, payload) {
  broadcast(sensorType, { type: 'ATTACHMENT_DATA', attachment_id: attachmentId, sensor_type: sensorType, data: payload });
}

function broadcastAlert(alertType, alertData) {
  if (!wss) return;
  const message = JSON.stringify({ topic: 'ALERT', type: alertType, data: alertData, ts: Date.now(), priority: 'HIGH' });
  wss.clients.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(message); });
  logger.warn('Alert broadcast', { alertType });
}

function getStats() {
  if (!wss) return { connected: 0 };
  return { connected: wss.clients.size };
}

module.exports = {
  initWsServer, broadcast,
  broadcastNodeTelemetry, broadcastAttachmentTelemetry,
  broadcastAlert, getStats,
  get wss() { return wss; },
};