'use strict';

const db = require('../../config/database');

/**
 * Links an incident to a work order without replacing the existing work-order
 * workflow. A single incident may have multiple response work orders.
 */
async function linkWorkOrder(incidentId, workOrderId, relationship = 'RESPONSE') {
  if (!incidentId || !workOrderId) return null;

  return db.one(`
    INSERT INTO incident_work_orders (incident_id, work_order_id, relationship)
    VALUES ($1, $2, $3)
    ON CONFLICT (incident_id, work_order_id)
    DO UPDATE SET relationship = EXCLUDED.relationship
    RETURNING incident_id, work_order_id, relationship
  `, [incidentId, workOrderId, relationship]);
}

async function attachIncidentToWorkOrder(incidentId, workOrderId) {
  await db.none(`
    UPDATE work_orders
       SET incident_id = $1, updated_at = NOW()
     WHERE work_order_id = $2
  `, [incidentId, workOrderId]);

  return linkWorkOrder(incidentId, workOrderId);
}

module.exports = { linkWorkOrder, attachIncidentToWorkOrder };
