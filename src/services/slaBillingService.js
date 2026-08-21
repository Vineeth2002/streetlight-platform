require('dotenv').config();
const cron   = require('node-cron');
const db     = require('../../config/database');
const logger = require('../utils/logger');
const { sendMonthlyReport } = require('./reportService');

const CONSTANTS = {
  ENERGY_TARIFF:      parseFloat(process.env.ENERGY_TARIFF_INR_PER_KWH)           || 6.00,
  BURN_HOURS_PER_DAY: parseFloat(process.env.STREETLIGHT_BURN_HOURS_PER_DAY)      || 11,
  DEMURRAGE_PER_POLE: parseFloat(process.env.DEMURRAGE_RATE_INR_PER_POLE_PER_DAY) || 25.00,
};

function calcPenaltyA(luminaireWattage, daysOverdue) {
  return 2 * ((luminaireWattage / 1000) * CONSTANTS.BURN_HOURS_PER_DAY * daysOverdue * CONSTANTS.ENERGY_TARIFF);
}

function calcPenaltyB(daysOverdue, totalUnresolvedPoles) {
  return CONSTANTS.DEMURRAGE_PER_POLE * daysOverdue * totalUnresolvedPoles;
}

async function runMonthlyBillingAudit(options = {}) {
  const { dryRun = false } = options;
  const billingMonth = options.billingMonth || new Date();
  const monthLabel = billingMonth.toISOString().slice(0, 7);

  logger.info('SLA billing audit started', { monthLabel, dryRun });

  const report = {
    monthLabel, dryRun,
    processedOrders: 0,
    totalPenaltyINR: 0,
    contractorSummaries: [],
    errors: [],
    startedAt: new Date().toISOString(),
  };

  try {
    const violatedOrders = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.pole_id, wo.contractor_id,
             wo.reported_timestamp, wo.resolved_timestamp, wo.sla_deadline,
             wo.penalty_deducted, p.luminaire_wattage, c.company_name AS contractor_name
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN contractors c ON wo.contractor_id = c.contractor_id
      WHERE wo.ticket_status IN ('SLA_VIOLATED','RESOLVED')
        AND (
          (wo.resolved_timestamp IS NOT NULL AND wo.resolved_timestamp > wo.sla_deadline)
          OR (wo.resolved_timestamp IS NULL AND NOW() > wo.sla_deadline)
        )
        AND wo.reported_timestamp >= date_trunc('month', $1::date)
        AND wo.reported_timestamp <  date_trunc('month', $1::date) + INTERVAL '1 month'
        AND wo.penalty_deducted = 0
    `, [billingMonth]);

    if (!violatedOrders || violatedOrders.length === 0) {
      logger.info('No SLA violations found', { monthLabel });
      report.completedAt = new Date().toISOString();
      return report;
    }

    const byContractor = new Map();
    for (const order of violatedOrders) {
      if (!byContractor.has(order.contractor_id)) {
        byContractor.set(order.contractor_id, {
          contractor_id: order.contractor_id,
          contractor_name: order.contractor_name,
          orders: [], totalPenalty: 0,
        });
      }
      byContractor.get(order.contractor_id).orders.push(order);
    }

    for (const [contractorId, contractorData] of byContractor) {
      const totalUnresolvedPoles = contractorData.orders.length;
      let contractorTotalPenalty = 0;

      for (const order of contractorData.orders) {
        try {
          const resolvedAt  = order.resolved_timestamp || new Date();
          const msOverdue   = Math.max(0, new Date(resolvedAt) - new Date(order.sla_deadline));
          const daysOverdue = Math.ceil(msOverdue / (1000 * 60 * 60 * 24));
          if (daysOverdue <= 0) continue;

          const penaltyA    = calcPenaltyA(order.luminaire_wattage, daysOverdue);
          const penaltyB    = calcPenaltyB(daysOverdue, totalUnresolvedPoles);
          const finalPenalty = parseFloat(Math.max(penaltyA, penaltyB).toFixed(2));
          const penaltyType  = penaltyA >= penaltyB ? 'ENERGY' : 'DEMURRAGE';

          if (!dryRun) {
            await db.none(`
              UPDATE work_orders
              SET penalty_deducted=$1, penalty_type=$2, days_overdue=$3
              WHERE work_order_id=$4
            `, [finalPenalty, penaltyType, daysOverdue, order.work_order_id]);
          }

          contractorTotalPenalty += finalPenalty;
          report.totalPenaltyINR += finalPenalty;
          report.processedOrders++;
        } catch (err) {
          report.errors.push({ work_order_id: order.work_order_id, error: err.message });
        }
      }

      if (!dryRun && contractorTotalPenalty > 0) {
        await db.none(`
          UPDATE contractors SET total_penalty_mtd = total_penalty_mtd + $1
          WHERE contractor_id = $2
        `, [contractorTotalPenalty.toFixed(2), contractorId]);
      }

      report.contractorSummaries.push({
        contractor_id:   contractorId,
        contractor_name: contractorData.contractor_name,
        violations:      contractorData.orders.length,
        totalPenaltyINR: parseFloat(contractorTotalPenalty.toFixed(2)),
      });
    }

    report.totalPenaltyINR = parseFloat(report.totalPenaltyINR.toFixed(2));
    report.completedAt = new Date().toISOString();
    logger.info('Billing audit complete', { totalPenaltyINR: report.totalPenaltyINR });
    return report;
  } catch (err) {
    logger.error('Billing audit failed', { error: err.message });
    throw err;
  }
}

async function saveMonthlyGlowSnapshot(){
  try {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const snapshotMonth = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1);
    const zones = await db.manyOrNone(`
      SELECT z.zone_id, z.zone_name,
             COUNT(p.pole_id) AS total_poles,
             COUNT(p.pole_id) FILTER(WHERE p.current_status='OPERATIONAL') AS operational_poles,
             ROUND(COUNT(p.pole_id) FILTER(WHERE p.current_status='OPERATIONAL')::NUMERIC
               / NULLIF(COUNT(p.pole_id),0)*100,2) AS glow_rate_pct,
             c.contractor_id, c.company_name, c.target_glow_rate
      FROM zones z
      LEFT JOIN wards w ON w.zone_id=z.zone_id
      LEFT JOIN junction_boxes jb ON jb.ward_id=w.ward_id
      LEFT JOIN poles p ON p.cabinet_id=jb.cabinet_id
      LEFT JOIN contractors c ON c.assigned_zone_id=z.zone_id
      GROUP BY z.zone_id,z.zone_name,c.contractor_id,c.company_name,c.target_glow_rate
    `);
    for(const zone of zones){
      const glow   = parseFloat(zone.glow_rate_pct||0);
      const target = parseFloat(zone.target_glow_rate||98);
      await db.none(`
        INSERT INTO monthly_glow_snapshots
          (snapshot_month,zone_id,zone_name,total_poles,
           operational_poles,glow_rate_pct,contractor_id,
           company_name,target_glow_rate,met_target)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (snapshot_month,zone_id) DO UPDATE
          SET glow_rate_pct=EXCLUDED.glow_rate_pct,
              met_target=EXCLUDED.met_target
      `,[snapshotMonth,zone.zone_id,zone.zone_name,
         parseInt(zone.total_poles||0),parseInt(zone.operational_poles||0),
         glow,zone.contractor_id||null,zone.company_name||null,target,glow>=target]);
    }
    logger.info('Monthly glow snapshots saved',{month:snapshotMonth});
  } catch(err){
    logger.error('Glow snapshot failed',{error:err.message});
  }
}

// ─── HOURLY SLA SWEEP ──────────────────────────────────────────────────────
// Catches silent SLA breaches that no one has touched since they opened.
// The DB trigger only fires on INSERT/UPDATE of work_orders — if a ticket
// sits untouched past its deadline, nothing flips its status until this
// sweep runs. Without this, a breach could go unnoticed and unpenalized
// until the monthly billing audit finally looks at it.
async function sweepStaleWorkOrders() {
  try {
    const stale = await db.manyOrNone(`
      UPDATE work_orders
      SET ticket_status = 'SLA_VIOLATED',
          days_overdue  = CEIL(EXTRACT(EPOCH FROM (NOW() - sla_deadline)) / 86400.0)
      WHERE ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
        AND NOW() > sla_deadline
      RETURNING work_order_id, pole_id, contractor_id, days_overdue
    `);

    if (stale && stale.length) {
      logger.warn('SLA sweep flagged stale work orders', {
        count: stale.length,
        work_order_ids: stale.map(s => s.work_order_id),
      });

      // Broadcast alert for each newly-breached order so live dashboards
      // reflect it immediately instead of waiting for next poll
      const { broadcastAlert } = require('../websocket/wsServer');
      stale.forEach(s => {
        broadcastAlert('SLA_BREACH_DETECTED', {
          work_order_id: s.work_order_id,
          pole_id: s.pole_id,
          days_overdue: s.days_overdue,
        });
      });
    }

    return { swept: stale ? stale.length : 0 };
  } catch (err) {
    logger.error('SLA sweep failed', { error: err.message });
    return { swept: 0, error: err.message };
  }
}

async function resetMonthlyCounters() {
  await db.none(`UPDATE contractors SET total_penalty_mtd=0, total_solved_daily=0`);
  logger.info('Monthly counters reset');
}

function startBillingCron() {
  const schedule = process.env.BILLING_CRON_SCHEDULE || '0 2 1 * *';
  cron.schedule(schedule, async () => {
    logger.info('Billing cron triggered');
    try {
      await resetMonthlyCounters();
      await runMonthlyBillingAudit();
      await saveMonthlyGlowSnapshot();
      await sendMonthlyReport();
    } catch (err) {
      logger.error('Cron billing error', { error: err.message });
    }
  }, { scheduled: true, timezone: 'Asia/Kolkata' });
  logger.info('Billing cron registered', { schedule });

  // Hourly sweep — catches silent SLA breaches between monthly audits
  const sweepSchedule = process.env.SLA_SWEEP_CRON_SCHEDULE || '0 * * * *';
  cron.schedule(sweepSchedule, async () => {
    const result = await sweepStaleWorkOrders();
    logger.info('Hourly SLA sweep ran', { swept: result.swept, timestamp: new Date().toISOString() });
  }, { scheduled: true, timezone: 'Asia/Kolkata' });
  logger.info('SLA sweep cron registered', { schedule: sweepSchedule });
}

if (require.main === module) {
  runMonthlyBillingAudit({ dryRun: process.argv.includes('--dry-run') })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { runMonthlyBillingAudit, calcPenaltyA, calcPenaltyB, startBillingCron, sweepStaleWorkOrders };
