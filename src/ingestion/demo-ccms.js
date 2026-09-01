'use strict';

/**
 * Demo CCMS source adapter.
 *
 * This is intentionally a source adapter, not dashboard logic. It produces
 * source-shaped telemetry that can be sent to the same /telemetry/node API
 * used by a future GVMC CCMS integration.
 */

function buildReading({ pole_number, node_id, state = 'ON', source = 'DEMO', now = new Date() }) {
  const failure = state === 'OFF';
  return {
    pole_number,
    node_id,
    source,
    event_type: failure ? 'STATE_CHANGE' : 'TELEMETRY',
    voltage_rms: failure ? 228 : 231,
    current_rms: failure ? 0 : 0.42,
    active_power: failure ? 0 : 92,
    power_factor: failure ? 0 : 0.96,
    temperature: 31,
    rssi: -67,
    cabinet_on: true,
    observed_at: now.toISOString()
  };
}

function createScenario() {
  const poles = [
    { pole_number: 'PL-DEMO-0001', node_id: 'DEMO-NODE-0001' },
    { pole_number: 'PL-DEMO-0002', node_id: 'DEMO-NODE-0002' },
    { pole_number: 'PL-DEMO-0003', node_id: 'DEMO-NODE-0003' }
  ];

  return {
    healthy: () => poles.map(p => buildReading(p)),
    singleFailure: () => [buildReading(poles[0]), buildReading({ ...poles[1], state: 'OFF' }), buildReading(poles[2])],
    recovery: () => poles.map(p => buildReading(p)),
    cabinetFailure: () => poles.map(p => buildReading({ ...p, state: 'OFF' }))
  };
}

module.exports = { buildReading, createScenario };
