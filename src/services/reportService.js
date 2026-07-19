const db           = require('../../config/database');
const logger       = require('../utils/logger');
const { sendEmail } = require('./emailService');

// ─── BUILD REPORT DATA ────────────────────────────────────────────────────────
async function buildMonthlyReportData(){
  const now       = new Date();
  const monthName = now.toLocaleString('en-IN',{month:'long'});
  const year      = now.getFullYear();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd   = new Date(now.getFullYear(), now.getMonth()+1, 0);

  // Zone glow rates
  const zones = await db.manyOrNone(`
    SELECT z.zone_id, z.zone_name,
           COUNT(p.pole_id) AS total_poles,
           COUNT(p.pole_id) FILTER(WHERE p.current_status='OPERATIONAL') AS operational,
           ROUND(COUNT(p.pole_id) FILTER(WHERE p.current_status='OPERATIONAL')::NUMERIC
             / NULLIF(COUNT(p.pole_id),0)*100,2) AS glow_rate
    FROM zones z
    LEFT JOIN wards w ON w.zone_id=z.zone_id
    LEFT JOIN junction_boxes jb ON jb.ward_id=w.ward_id
    LEFT JOIN poles p ON p.cabinet_id=jb.cabinet_id
    GROUP BY z.zone_id, z.zone_name
    ORDER BY z.zone_id
  `);

  // Work order stats
  const woStats = await db.oneOrNone(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER(WHERE ticket_status='RESOLVED') AS resolved,
      COUNT(*) FILTER(WHERE ticket_status='SLA_VIOLATED') AS violated,
      COUNT(*) FILTER(WHERE ticket_status IN('PENDING','ASSIGNED','IN_PROGRESS')) AS pending,
      COALESCE(SUM(penalty_deducted),0) AS total_penalty
    FROM work_orders
    WHERE reported_timestamp >= $1 AND reported_timestamp <= $2
  `, [monthStart, monthEnd]);

  // Contractor performance
const contractors = await db.manyOrNone(`
    SELECT c.contractor_id, c.company_name, z.zone_name,
           c.target_glow_rate, c.monthly_invoice_base,
           c.total_penalty_mtd,
           (c.monthly_invoice_base - c.total_penalty_mtd) AS net_payable,
           (
             SELECT COUNT(*) FROM work_orders wo
             WHERE wo.contractor_id = c.contractor_id
               AND wo.ticket_status = 'SLA_VIOLATED'
               AND wo.reported_timestamp >= $1
           ) AS sla_violations
    FROM contractors c
    LEFT JOIN zones z ON c.assigned_zone_id = z.zone_id
    ORDER BY c.contractor_id
  `, [monthStart]);
  // SLA breaches
  const breaches = await db.manyOrNone(`
    SELECT wo.work_order_id, p.pole_number, z.zone_name,
           w.ward_number, wo.fault_category,
           wo.reported_timestamp, wo.sla_deadline,
           wo.penalty_deducted, wo.days_overdue
    FROM work_orders wo
    JOIN poles p ON wo.pole_id=p.pole_id
    JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
    JOIN wards w ON jb.ward_id=w.ward_id
    JOIN zones z ON w.zone_id=z.zone_id
    WHERE wo.ticket_status='SLA_VIOLATED'
      AND wo.reported_timestamp >= $1
    ORDER BY wo.penalty_deducted DESC
    LIMIT 20
  `, [monthStart]);

  return {
    monthName, year, monthStart, monthEnd,
    zones, woStats, contractors, breaches,
    generatedAt: new Date().toLocaleString('en-IN'),
  };
}

// ─── BUILD HTML REPORT ────────────────────────────────────────────────────────
function buildReportHTML(data){
  const { monthName, year, zones, woStats, contractors, breaches, generatedAt } = data;

  const avgGlow = zones.length
    ? (zones.reduce((s,z)=>s+parseFloat(z.glow_rate||0),0)/zones.length).toFixed(1)
    : '—';

  const zoneRows = zones.map(z=>{
    const glow = parseFloat(z.glow_rate||0);
    const col  = glow>=98?'#198754':glow>=96?'#ff8800':'#dc3545';
    const status = glow>=98?'✅ MEETING':'⚠️ AT RISK';
    return `<tr>
      <td>${z.zone_name}</td>
      <td>${parseInt(z.total_poles||0).toLocaleString('en-IN')}</td>
      <td style="color:${col};font-weight:700">${glow}%</td>
      <td style="color:${col}">${status}</td>
    </tr>`;
  }).join('');

  const contractorRows = contractors.map(c=>{
    const net = parseFloat(c.net_payable||0);
    return `<tr>
      <td>${c.company_name}</td>
      <td>${c.zone_name||'—'}</td>
      <td>₹${parseFloat(c.monthly_invoice_base||0).toLocaleString('en-IN')}</td>
      <td style="color:#dc3545">₹${parseFloat(c.total_penalty_mtd||0).toLocaleString('en-IN')}</td>
      <td style="color:#198754;font-weight:700">₹${net.toLocaleString('en-IN')}</td>
      <td>${parseInt(c.sla_violations||0)}</td>
    </tr>`;
  }).join('');

  const breachRows = breaches.length ? breaches.map(b=>`<tr>
    <td>#${b.work_order_id}</td>
    <td>${b.pole_number}</td>
    <td>${b.zone_name}</td>
    <td>Ward ${b.ward_number}</td>
    <td>${b.fault_category?.replace(/_/g,' ')}</td>
    <td>${b.days_overdue||0} days</td>
    <td style="color:#dc3545;font-weight:700">₹${parseFloat(b.penalty_deducted||0).toLocaleString('en-IN')}</td>
  </tr>`).join('')
  : '<tr><td colspan="7" style="text-align:center;color:#198754">✅ No SLA breaches this month</td></tr>';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;margin:0;padding:0;background:#f5f5f5;color:#333}
  .container{max-width:800px;margin:0 auto;background:#fff}
  .header{background:#00529c;color:#fff;padding:24px 32px;text-align:center}
  .header h1{margin:0;font-size:20px;font-weight:700}
  .header p{margin:6px 0 0;font-size:12px;opacity:0.85}
  .orange-bar{height:4px;background:linear-gradient(90deg,#ff6600,#ff9933)}
  .section{padding:20px 32px;border-bottom:1px solid #e9ecef}
  .section-title{font-size:13px;font-weight:700;color:#00529c;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid #e9ecef}
  .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:8px}
  .kpi-box{background:#f8f9fa;border:1px solid #dee2e6;border-radius:6px;padding:12px;text-align:center}
  .kpi-val{font-size:22px;font-weight:700;color:#00529c}
  .kpi-lbl{font-size:10px;color:#666;margin-top:3px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
  th{background:#00529c;color:#fff;padding:8px 10px;text-align:left;font-size:11px}
  td{padding:7px 10px;border-bottom:1px solid #f0f0f0}
  tr:nth-child(even) td{background:#f8f9fa}
  .footer{background:#f8f9fa;padding:16px 32px;text-align:center;font-size:11px;color:#666;border-top:2px solid #00529c}
  .notice{background:#fff8e1;border:1px solid #ffe082;border-radius:4px;padding:10px 14px;font-size:11px;color:#5d4037;margin:12px 0}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div style="font-size:11px;margin-bottom:8px;opacity:0.8">🇮🇳 Government of Andhra Pradesh — GVMC Smart City Mission</div>
    <h1>🏛️ GVMC Streetlight Monitoring System</h1>
    <p>Monthly Performance Report — ${monthName} ${year}</p>
    <p style="font-size:10px;margin-top:4px">Generated: ${generatedAt} | Confidential — For Official Use Only</p>
  </div>
  <div class="orange-bar"></div>

  <div class="section">
    <div class="section-title">Executive Summary</div>
    <div class="kpi-grid">
      <div class="kpi-box"><div class="kpi-val">${avgGlow}%</div><div class="kpi-lbl">City Glow Rate</div></div>
      <div class="kpi-box"><div class="kpi-val" style="color:#dc3545">${parseInt(woStats?.violated||0)}</div><div class="kpi-lbl">SLA Violations</div></div>
      <div class="kpi-box"><div class="kpi-val" style="color:#198754">${parseInt(woStats?.resolved||0)}</div><div class="kpi-lbl">Resolved</div></div>
      <div class="kpi-box"><div class="kpi-val" style="color:#dc3545">₹${parseFloat(woStats?.total_penalty||0).toLocaleString('en-IN')}</div><div class="kpi-lbl">Total Penalty</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Zone-wise Glow Rate Performance</div>
    <table>
      <thead><tr><th>Zone</th><th>Total Poles</th><th>Glow Rate</th><th>SLA Status</th></tr></thead>
      <tbody>${zoneRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Contractor Performance & Billing</div>
    <table>
      <thead><tr><th>Contractor</th><th>Zone</th><th>Invoice</th><th>Penalty</th><th>Net Payable</th><th>SLA Violations</th></tr></thead>
      <tbody>${contractorRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">SLA Breach Details</div>
    <table>
      <thead><tr><th>WO#</th><th>Pole</th><th>Zone</th><th>Ward</th><th>Fault</th><th>Overdue</th><th>Penalty</th></tr></thead>
      <tbody>${breachRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="notice">
      ⚠️ This is a system-generated report. Data reflects the period ${data.monthStart.toLocaleDateString('en-IN')} to ${data.monthEnd.toLocaleDateString('en-IN')}.
      For disputes or clarifications, contact GVMC IT Helpdesk: 0891-2755555
    </div>
  </div>

  <div class="footer">
    Greater Visakhapatnam Municipal Corporation — Smart City Streetlight Monitoring Platform v1.0<br>
    Government of Andhra Pradesh | This report is auto-generated and digitally authenticated.
  </div>
</div>
</body>
</html>`;
}

// ─── SEND MONTHLY REPORT ─────────────────────────────────────────────────────
async function sendMonthlyReport(){
  logger.info('Monthly report generation started');

  try {
    const data = await buildMonthlyReportData();
    const html = buildReportHTML(data);

    const recipients = (process.env.REPORT_RECIPIENTS || '').split(',').filter(Boolean);
    if(!recipients.length){
      logger.warn('No report recipients configured — skipping email');
      return { ok: false, error: 'No recipients configured' };
    }

    const result = await sendEmail({
      to:      recipients,
      subject: `GVMC Streetlight Monthly Report — ${data.monthName} ${data.year}`,
      html,
    });

    if(result.ok){
      logger.info('Monthly report sent successfully', { recipients });
    }
    return result;
  } catch(err){
    logger.error('Monthly report failed', { error: err.message });
    return { ok: false, error: err.message };
  }
}

// ─── MANUAL TRIGGER (for testing) ────────────────────────────────────────────
async function generateReportPreview(){
  const data = await buildMonthlyReportData();
  return buildReportHTML(data);
}

module.exports = { sendMonthlyReport, generateReportPreview, buildMonthlyReportData };