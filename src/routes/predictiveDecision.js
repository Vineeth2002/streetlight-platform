'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const DECISION_ROLES = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'];

router.post('/alerts/:id/convert', requireRole(...DECISION_ROLES), async (req, res) => {
  const alertId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(alertId)) return res.status(400).json({ok:false,error:'Invalid alert id'});

  const contractorId = req.body?.contractor_id == null ? null : Number.parseInt(req.body.contractor_id, 10);
  if (contractorId !== null && !Number.isInteger(contractorId)) {
    return res.status(400).json({ok:false,error:'Invalid contractor id'});
  }

  try {
    const result = await db.tx(async t => {
      const alert = await t.oneOrNone(`
        SELECT a.*, p.pole_number, z.zone_id
        FROM predictive_alerts a
        JOIN poles p ON p.pole_id=a.pole_id
        JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id
        JOIN wards w ON w.ward_id=jb.ward_id
        JOIN zones z ON z.zone_id=w.zone_id
        WHERE a.alert_id=$1
        FOR UPDATE OF a`, [alertId]);
      if (!alert) return {error:404,message:'Predictive alert not found'};
      if (alert.status === 'CONVERTED' || alert.converted_work_order_id) return {error:409,message:'Predictive alert is already converted',work_order_id:alert.converted_work_order_id};
      if (!['OPEN','ACKNOWLEDGED'].includes(alert.status)) return {error:409,message:'Only open or acknowledged alerts can be converted'};
      if (req.user.role === 'GVMC_EE' && alert.zone_id !== req.user.zone_id) return {error:403,message:'Access denied'};

      if (contractorId !== null) {
        const contractor = await t.oneOrNone(`SELECT contractor_id,assigned_zone_id,is_active FROM contractors WHERE contractor_id=$1`, [contractorId]);
        if (!contractor || !contractor.is_active) return {error:400,message:'Contractor not found or inactive'};
        if (contractor.assigned_zone_id && contractor.assigned_zone_id !== alert.zone_id) return {error:400,message:'Contractor is not assigned to the alert zone'};
      }

      const existing = await t.oneOrNone(`
        SELECT work_order_id FROM work_orders
        WHERE pole_id=$1 AND fault_category='PREDICTIVE_DEGRADATION'
          AND ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
        LIMIT 1`, [alert.pole_id]);
      if (existing) return {error:409,message:'Open predictive work order already exists for this pole',work_order_id:existing.work_order_id};

      const description = String(req.body?.fault_description || `Predictive maintenance recommendation from alert ${alert.alert_id}: ${alert.reason}`).slice(0,1000);
      const wo = await t.one(`
        INSERT INTO work_orders(pole_id,contractor_id,fault_category,fault_description,reported_by,reported_timestamp)
        VALUES($1,$2,'PREDICTIVE_DEGRADATION',$3,$4,NOW()) RETURNING *`,
        [alert.pole_id, contractorId, description, req.user.full_name]);

      await t.none(`
        INSERT INTO work_order_events(work_order_id,from_status,to_status,changed_by,notes,metadata)
        VALUES($1,NULL,$2,$3,$4,$5)`,
        [wo.work_order_id, wo.ticket_status, req.user.user_id, 'Created from human-approved predictive recommendation', JSON.stringify({predictive_alert_id:alert.alert_id,score:alert.score,severity:alert.severity})]);

      await t.none(`
        UPDATE predictive_alerts
        SET status='CONVERTED',converted_work_order_id=$2,converted_at=NOW(),converted_by=$3
        WHERE alert_id=$1`, [alertId, wo.work_order_id, req.user.user_id]);

      return {alert,wo};
    });

    if (result.error) return res.status(result.error).json({ok:false,error:result.message,...(result.work_order_id?{work_order_id:result.work_order_id}:{})});
    await auditLog(req.user.user_id,'PREDICTIVE_ALERT_CONVERTED','predictive_alert',alertId,true,{work_order_id:result.wo.work_order_id,pole_id:result.wo.pole_id},req);
    res.status(201).json({ok:true,advisory:true,decision:'HUMAN_APPROVED',predictive_alert_id:alertId,work_order:result.wo});
  } catch (err) {
    logger.error('Predictive decision conversion error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

module.exports = router;
