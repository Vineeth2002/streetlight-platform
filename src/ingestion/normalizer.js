const { validateCanonicalEvent } = require('./schema');

function normalizeIncomingEvent(input) {
  const receivedAt = input.received_at || new Date().toISOString();
  const observedAt = input.observed_at || receivedAt;

  const event = {
    event_type: input.event_type || 'TELEMETRY',
    source: input.source || 'DEMO',
    source_device_id: String(input.source_device_id || input.device_id || input.node_id || ''),
    asset_id: input.asset_id || null,
    observed_at: new Date(observedAt).toISOString(),
    received_at: new Date(receivedAt).toISOString(),
    data: input.data || input.measurements || input.telemetry || {},
    quality: input.quality || {
      valid: true,
      freshness_seconds: Math.max(0, (Date.parse(receivedAt) - Date.parse(observedAt)) / 1000),
      status: 'FRESH'
    },
    correlation_id: input.correlation_id || null
  };

  const { error, value } = validateCanonicalEvent(event);
  if (error) {
    const details = error.details.map(detail => detail.message).join('; ');
    const validationError = new Error(`Invalid canonical event: ${details}`);
    validationError.status = 400;
    throw validationError;
  }

  return value;
}

module.exports = { normalizeIncomingEvent };
