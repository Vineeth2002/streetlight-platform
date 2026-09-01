const Joi = require('joi');

const canonicalEventSchema = Joi.object({
  event_type: Joi.string().valid(
    'TELEMETRY',
    'FAULT',
    'STATE_CHANGE',
    'HEARTBEAT',
    'ALARM'
  ).required(),
  source: Joi.string().valid(
    'CCMS',
    'IOT',
    'FIELD',
    'CITIZEN',
    'SYSTEM',
    'DEMO'
  ).required(),
  source_device_id: Joi.string().max(200).required(),
  asset_id: Joi.string().max(200).allow(null),
  observed_at: Joi.date().iso().required(),
  received_at: Joi.date().iso().required(),
  data: Joi.object().required(),
  quality: Joi.object({
    valid: Joi.boolean().required(),
    freshness_seconds: Joi.number().min(0).allow(null),
    status: Joi.string().valid('FRESH', 'STALE', 'INVALID', 'UNKNOWN').required()
  }).required(),
  correlation_id: Joi.string().max(100).allow(null)
}).required();

function validateCanonicalEvent(event) {
  return canonicalEventSchema.validate(event, {
    abortEarly: false,
    stripUnknown: false
  });
}

module.exports = {
  canonicalEventSchema,
  validateCanonicalEvent
};
