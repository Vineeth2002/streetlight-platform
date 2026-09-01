(() => {
  'use strict';

  const state = {
    connected: false,
    lastEventAt: null,
    assets: new Map(),
    incidents: new Map(),
    workOrders: new Map(),
    sla: new Map(),
    telemetry: new Map(),
  };

  const listeners = new Set();
  const notify = (type, payload) => listeners.forEach(fn => fn(type, payload, state));

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function upsert(map, id, value) {
    if (id == null) return;
    map.set(String(id), { ...(map.get(String(id)) || {}), ...value });
  }

  function applyEvent(message) {
    const type = message?.type || message?.event_type;
    const payload = message?.data || message?.payload || message;
    state.lastEventAt = new Date().toISOString();

    if (type === 'NODE_TELEMETRY' || type === 'TELEMETRY') {
      const id = payload.pole_number || payload.node_id || payload.asset_id;
      upsert(state.telemetry, id, payload);
      upsert(state.assets, payload.asset_id || id, {
        asset_id: payload.asset_id || id,
        pole_number: payload.pole_number,
        node_id: payload.node_id,
        last_seen_at: state.lastEventAt,
        current_state: payload.cabinet_on === false || payload.active_power === 0 ? 'FAULT' : 'ONLINE'
      });
      notify('telemetry', payload);
      return;
    }

    if (type === 'INCIDENT_CREATED' || type === 'INCIDENT_UPDATED' || type === 'INCIDENT') {
      upsert(state.incidents, payload.incident_id || payload.incident_number, payload);
      notify('incident', payload);
      return;
    }

    if (type === 'WORK_ORDER_UPDATED' || type === 'WORK_ORDER') {
      upsert(state.workOrders, payload.work_order_id, payload);
      notify('work_order', payload);
      return;
    }

    if (type === 'SLA_UPDATED' || type === 'SLA_BREACH' || type === 'SLA_AT_RISK') {
      upsert(state.sla, payload.work_order_id, payload);
      notify('sla', payload);
      return;
    }

    notify('event', payload);
  }

  function connectWebSocket({ url, protocols } = {}) {
    if (!url) throw new Error('WebSocket URL is required');
    const ws = new WebSocket(url, protocols);
    ws.addEventListener('open', () => {
      state.connected = true;
      notify('connection', { connected: true });
    });
    ws.addEventListener('message', event => {
      try { applyEvent(JSON.parse(event.data)); }
      catch (err) { notify('error', err); }
    });
    ws.addEventListener('close', () => {
      state.connected = false;
      notify('connection', { connected: false });
    });
    ws.addEventListener('error', error => notify('error', error));
    return ws;
  }

  window.streetlightDashboardState = { state, subscribe, applyEvent, connectWebSocket };
})();
