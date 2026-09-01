'use strict';

const db = require('../../config/database');

function evaluateSla(workOrder) {
  if (!workOrder.sla_deadline || ['RESOLVED', 'CLOSED', 'CANCELLED'].includes(workOrder.ticket_status)) {
    return { state: 'NOT_RUNNING', escalationLevel: 0, hoursRemaining: null, hoursOverdue: 0 };
  }

  const now = Date.now();
  const deadline = new Date(workOrder.sla_deadline).getTime();
  const diffHours = (deadline - now) / 3600000;

  if (diffHours < 0) {
    const overdue = Math.abs(diffHours);
    return { state: 'BREACHED', escalationLevel: overdue >= 24 ? 3 : overdue >= 12 ? 2 : 1, hoursRemaining: 0, hoursOverdue: overdue };
  }

  if (diffHours <= 12) return { state: 'AT_RISK', escalationLevel: 0, hoursRemaining: diffHours, hoursOverdue: 0 };
  return { state: 'ON_TRACK', escalationLevel: 0, hoursRemaining: diffHours, hoursOverdue: 0 };
}

async function recordSlaState(workOrder) {
  const evaluation = evaluateSla(workOrder);
  if (!['AT_RISK', 'BREACHED'].includes(evaluation.state)) return evaluation;

  const eventType = evaluation.state === 'BREACHED' ? 'BREACH' : 'AT_RISK';
  const recent = await db.oneOrNone(
    `SELECT sla_event_id FROM sla_events
      WHERE work_order_id = $1 AND event_type = $2
        AND occurred_at >= NOW() - INTERVAL '1 hour'
      ORDER BY occurred_at DESC LIMIT 1`,
    [workOrder.work_order_id, eventType]
  );

  if (!recent) {
    await db.none(
      `INSERT INTO sla_events
        (work_order_id,event_type,hours_remaining,hours_overdue,escalation_level,metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [workOrder.work_order_id, eventType, evaluation.hoursRemaining, evaluation.hoursOverdue,
       evaluation.escalationLevel, JSON.stringify({ ticket_status: workOrder.ticket_status })]
    );
  }

  if (evaluation.state === 'BREACHED' && evaluation.escalationLevel > 0) {
    const existing = await db.oneOrNone(
      `SELECT escalation_id FROM escalation_events
        WHERE work_order_id = $1 AND level = $2
          AND created_at >= NOW() - INTERVAL '24 hours'
        LIMIT 1`,
      [workOrder.work_order_id, evaluation.escalationLevel]
    );
    if (!existing) {
      await db.none(
        `INSERT INTO escalation_events (work_order_id,level,reason,metadata)
         VALUES ($1,$2,'SLA_BREACH',$3)`,
        [workOrder.work_order_id, evaluation.escalationLevel, JSON.stringify({ hours_overdue: evaluation.hoursOverdue })]
      );
    }
  }

  return evaluation;
}

async function scanOpenWorkOrders() {
  const rows = await db.manyOrNone(
    `SELECT work_order_id, ticket_status, sla_deadline
       FROM work_orders
      WHERE sla_deadline IS NOT NULL
        AND ticket_status NOT IN ('RESOLVED','CLOSED','CANCELLED')`
  );

  const results = [];
  for (const row of rows) results.push({ work_order_id: row.work_order_id, ...(await recordSlaState(row)) });
  return results;
}

module.exports = { evaluateSla, recordSlaState, scanOpenWorkOrders };
