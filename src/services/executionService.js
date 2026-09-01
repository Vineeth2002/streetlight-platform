'use strict';

const db = require('../../config/database');

const TRANSITIONS = {
  PENDING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: []
};

async function recordStatusChange(workOrderId, toStatus, changedBy, notes = null, metadata = {}) {
  return db.tx(async t => {
    const wo = await t.oneOrNone(
      'SELECT work_order_id, ticket_status FROM work_orders WHERE work_order_id = $1 FOR UPDATE',
      [workOrderId]
    );
    if (!wo) throw Object.assign(new Error('Work order not found'), { status: 404 });
    if (wo.ticket_status === toStatus) return { work_order_id: workOrderId, status: toStatus, changed: false };

    const allowed = TRANSITIONS[wo.ticket_status] || [];
    if (!allowed.includes(toStatus)) {
      throw Object.assign(new Error(`Invalid work-order transition: ${wo.ticket_status} -> ${toStatus}`), { status: 409 });
    }

    const timestampField = toStatus === 'ASSIGNED'
      ? ', assigned_timestamp = NOW()'
      : toStatus === 'RESOLVED'
        ? ', resolved_timestamp = NOW()'
        : '';

    await t.none(`UPDATE work_orders SET ticket_status = $1${timestampField} WHERE work_order_id = $2`, [toStatus, workOrderId]);
    await t.none(
      `INSERT INTO work_order_events (work_order_id, from_status, to_status, changed_by, notes, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [workOrderId, wo.ticket_status, toStatus, changedBy || null, notes, JSON.stringify(metadata)]
    );

    return { work_order_id: workOrderId, from_status: wo.ticket_status, status: toStatus, changed: true };
  });
}

async function addEvidence(workOrderId, input, capturedBy) {
  return db.one(
    `INSERT INTO work_order_evidence
      (work_order_id, evidence_type, uri, captured_at, latitude, longitude, captured_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [workOrderId, input.evidence_type, input.uri, input.captured_at || new Date().toISOString(),
     input.latitude ?? null, input.longitude ?? null, capturedBy || null, JSON.stringify(input.metadata || {})]
  );
}

async function verifyWorkOrder(workOrderId, result, verifiedBy, notes = null, metadata = {}) {
  return db.tx(async t => {
    const row = await t.oneOrNone(
      'SELECT work_order_id, ticket_status FROM work_orders WHERE work_order_id = $1 FOR UPDATE', [workOrderId]
    );
    if (!row) throw Object.assign(new Error('Work order not found'), { status: 404 });

    const verification = await t.one(
      `INSERT INTO work_order_verifications (work_order_id,result,verified_by,notes,metadata)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [workOrderId, result, verifiedBy, notes, JSON.stringify(metadata)]
    );

    if (result === 'PASS' && row.ticket_status === 'RESOLVED') {
      await t.none(`UPDATE work_orders SET ticket_status = 'CLOSED' WHERE work_order_id = $1`, [workOrderId]);
      await t.none(
        `INSERT INTO work_order_events (work_order_id,from_status,to_status,changed_by,notes,metadata)
         VALUES ($1,'RESOLVED','CLOSED',$2,$3,$4)`,
        [workOrderId, verifiedBy, 'Verification passed', JSON.stringify({ verification_id: verification.verification_id })]
      );
    }
    return verification;
  });
}

module.exports = { recordStatusChange, addEvidence, verifyWorkOrder, TRANSITIONS };
