const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

// ─── CREATE TRANSPORTER ───────────────────────────────────────────────────────
function createTransporter(){
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth:{
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ─── SEND EMAIL ───────────────────────────────────────────────────────────────
async function sendEmail({ to, cc, subject, html, attachments = [] }){
  try {
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from: `"GVMC Streetlight Platform" <${process.env.SMTP_USER}>`,
      to:   Array.isArray(to) ? to.join(',') : to,
      cc:   cc ? (Array.isArray(cc) ? cc.join(',') : cc) : undefined,
      subject,
      html,
      attachments,
    });
    logger.info('Email sent', { messageId: info.messageId, to, subject });
    return { ok: true, messageId: info.messageId };
  } catch(err){
    logger.error('Email send failed', { error: err.message, to, subject });
    return { ok: false, error: err.message };
  }
}

// ─── TEST CONNECTION ──────────────────────────────────────────────────────────
async function testConnection(){
  try {
    const transporter = createTransporter();
    await transporter.verify();
    return { ok: true };
  } catch(err){
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail, testConnection };