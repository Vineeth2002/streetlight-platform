'use strict';

const express = require('express');
const Joi = require('joi');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const assignSchema = Joi.object({
  assigned_to: Joi.number().integer().required(),
  notes: Joi.string().max(1000).optional().allow('', null),
});

const statusSchema = Joi.object({
  ticket_status: Joi.string().valid(
    'PENDING', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED'
  ).required(),
  notes: Joi.string().max(1000).optional().allow('', null),
});

async function loadWorkOrder(workOrderId) {
  return db.oneOrNone(`
    SELECT wo.work_order_id, wo.pole_id, wo.contractor_id,
           wo.assigned_to, wo.ticket_status, wo.sla_deadline,
           p.pole_number, w.zone_id, z.zone_name
    FROM work_orders wo
    JOIN poles p ON wo.pole_id = p.pole_id
    JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
    JOIN wards w ON jb.ward_id = w.ward_id
    JOIN zones z ON w.zone_id = z.zone_id
    WHERE wo.work_order_id = $1
  `, [workOrderId]);
}

function assertZoneAccess(user, workOrder) {
  if (user.role === 'GVMC_EE' && user.zone_id !== workOrder.zone_id) {
    const error = new Error('Work order belongs to another zone');
    error.statusCode = 403;
    throw error;
  }
}

// Explicit assignment endpoint. Assignment is a staff accountability action,
// separate from contractor ownership and separate from the SLA clock.
router.patch('/:id/assign',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'),
  async (req, res) => {
    const { error, value } = assignSchema.validate(req.body);
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const workOrderId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(workOrderId)) {
      return res.status(400).json({ ok: false, error: 'Invalid work order id' });
    }

    try {
      const wo = await loadWorkOrder(workOrderId);
      if (!wo) return res.status(404).json({ ok: false, error: 'Work order not found' });
      assertZoneAccess(req.user, wo);

      const assignee = await db.oneOrNone(`
        SELECT user_id, full_name, role, zone_id, is_active
        FROM users
        WHERE user_id = $1
      `, [value.assigned_to]);

      if (!assignee || !assignee.is_active) {
        return res.status(400).json({ ok: false, error: 'Assigned user not found or inactive' });
      }
      if (assignee.role !== 'FIELD_ENGINEER') {
        return res.status(400).json({ ok: false, error: 'Work orders can only be assigned to active field engineers' });
      }
      if (assignee.zone_id !== wo.zone_id) {
        return res.status(400).json({ ok: false, error: 'Field engineer must belong to the work order zone' });
      }

      const updated = await db.one(`
        UPDATE work_orders
        SET assigned_to = $1,
            assigned_timestamp = COALESCE(assigned_timestamp, NOW()),
            ticket_status = CASE
              WHEN ticket_status = 'PENDING' THEN 'ASSIGNED'
              ELSE ticket_status
            END
        WHERE work_order_id = $2
        RETURNING *
      `, [assignee.user_id, workOrderId]);

      if (updated.ticket_status !== wo.ticket_status) {
        await db.none(`
          INSERT INTO work_order_events
            (work_order_id, from_status, to_status, changed_by, notes, metadata)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `, [
          workOrderId,
          wo.ticket_status,
          updated.ticket_status,
          req.user.user_id,
          value.notes || `Assigned to ${assignee.full_name}`,
          JSON.stringify({ assigned_to: assignee.user_id, assigned_name: assignee.full_name }),
        ]);
      }

      await auditLog(req.user.user_id, 'WORK_ORDER_ASSIGNED', 'work_orders',
        workOrderId, true,
        { assigned_to: assignee.user_id, assigned_name: assignee.full_name, notes: value.notes || null },
        req);

      res.json({ ok: true, data: updated });
    } catch (err) {
      logger.error('Assign work order error', { error: err.message });
      res.status(err.statusCode || 500).json({ ok: false, error: err.statusCode ? err.message : 'Internal server error' });
    }
  }
);

// Explicit lifecycle endpoint. Existing SLA definitions are deliberately not
// recalculated here; this only records an authorized human transition.
router.patch('/:id/status',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'CONTRACTOR', 'FIELD_ENGINEER'),
  async (req, res) => {
    const { error, value } = statusSchema.validate(req.body);
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const workOrderId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(workOrderId)) {
      return res.status(400).json({ ok: false, error: 'Invalid work order id' });
    }

    try {
      const wo = await loadWorkOrder(workOrderId);
      if (!wo) return res.status(404).json({ ok: false, error: 'Work order not found' });
      assertZoneAccess(req.user, wo);

      if (req.user.role === 'CONTRACTOR' && wo.contractor_id !== req.user.contractor_id) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      if (req.user.role === 'FIELD_ENGINEER') {
        const allowed = ['IN_PROGRESS', 'RESOLVED'];
        if (!allowed.includes(value.ticket_status)) {
          return res.status(403).json({ ok: false, error: 'Field engineers can only set IN_PROGRESS or RESOLVED' });
        }
        if (wo.assigned_to !== req.user.user_id) {
          return res.status(403).json({ ok: false, error: 'Work order is not assigned to this field engineer' });
        }
      }

      if (wo.ticket_status === value.ticket_status) {
        return res.status(400).json({ ok: false, error: 'Work order is already in that status' });
      }

      const updated = await db.one(`
        UPDATE work_orders
        SET ticket_status = $1,
            resolved_timestamp = CASE
              WHEN $1 = 'RESOLVED' THEN COALESCE(resolved_timestamp, NOW())
              ELSE resolved_timestamp
            END
        WHERE work_order_id = $2
        RETURNING *
      `, [value.ticket_status, workOrderId]);

      await db.none(`
        INSERT INTO work_order_events
          (work_order_id, from_status, to_status, changed_by, notes, metadata)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `, [
        workOrderId,
        wo.ticket_status,
        updated.ticket_status,
        req.user.user_id,
        value.notes || null,
        JSON.stringify({ actor_role: req.user.role }),
      ]);

      await auditLog(req.user.user_id, 'WORK_ORDER_STATUS_CHANGED', 'work_orders',
        workOrderId, true,
        { from_status: wo.ticket_status, to_status: updated.ticket_status, notes: value.notes || null },
        req);

      res.json({ ok: true, data: updated });
    } catch (err) {
      logger.error('Work order status error', { error: err.message });
      res.status(err.statusCode || 500).json({ ok: false, error: err.statusCode ? err.message : 'Internal server error' });
    }
  }
);

module.exports = router;
