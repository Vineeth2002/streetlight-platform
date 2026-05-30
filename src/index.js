require('dotenv').config();
const http      = require('http');
const express   = require('express');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const logger               = require('./utils/logger');
const db                   = require('../config/database');
const wsServer             = require('./websocket/wsServer');
const { startBillingCron } = require('./services/slaBillingService');

const telemetryRoutes  = require('./routes/telemetry');
const workOrderRoutes  = require('./routes/workOrders');
const polesRoutes      = require('./routes/poles');
const attachmentRoutes = require('./routes/attachments');
const billingRoutes    = require('./routes/billing');

const app    = express();
const server = http.createServer(app);
const PORT   = parseInt(process.env.PORT) || 3000;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "'unsafe-hashes'", "cdn.jsdelivr.net", "unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "unpkg.com"],
      imgSrc:      ["'self'", "data:", "*.tile.openstreetmap.org", "*.openstreetmap.org", "tile.openstreetmap.org"],
      connectSrc:  ["'self'", "*.openstreetmap.org", "cdn.jsdelivr.net"],
      fontSrc:     ["'self'", "data:"],
    },
  },
}));

app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim(), { source:'http' }) } }));
app.use(express.json({ limit:'1mb' }));
app.use(express.urlencoded({ extended:false }));
app.use(express.static(path.join(__dirname, '../public')));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS)   || 60000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 500,
  message:  { ok:false, error:'Rate limit exceeded' },
});
app.use('/api/', limiter);

app.get('/health', async (req, res) => {
  try {
    await db.one('SELECT 1');
    res.json({
      ok: true, service: 'Streetlight Platform',
      city: 'Visakhapatnam', total_poles: 200000,
      db: 'connected', websocket: wsServer.getStats(),
      uptime_s: Math.floor(process.uptime()),
    });
  } catch { res.status(503).json({ ok:false, error:'Database unavailable' }); }
});

app.use('/api/v1/telemetry',   telemetryRoutes);
app.use('/api/v1/work-orders', workOrderRoutes);
app.use('/api/v1/poles',       polesRoutes);
app.use('/api/v1/attachments', attachmentRoutes);
app.use('/api/v1/billing',     billingRoutes);

app.get('/api/v1', (req, res) => {
  res.json({
    service: 'Unified Municipal Streetlight Audit & Governance Platform',
    version: '1.0.0', city: 'Visakhapatnam', poles: 200000,
    endpoints: {
      'POST /api/v1/telemetry/node':           'Ingest streetlight reading',
      'POST /api/v1/telemetry/attachment':     'Smart city sensor seed endpoint',
      'GET  /api/v1/work-orders':              'List work orders',
      'GET  /api/v1/work-orders/sla-breaches': 'Active SLA violations',
      'GET  /api/v1/poles':                    'List all poles',
      'GET  /api/v1/poles/zones':              'Zone glow rates',
      'GET  /api/v1/billing/simulate':         'Simulate penalty',
      'POST /api/v1/billing/audit/dry-run':    'Preview billing audit',
    },
  });
});

app.use((req, res) => res.status(404).json({ ok:false, error:`Not found: ${req.method} ${req.path}` }));
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error:err.message });
  res.status(500).json({ ok:false, error:'Internal server error' });
});

async function start() {
  try {
    await db.one('SELECT current_database() AS db');
    logger.info('Database connected');
  } catch(err) {
    logger.error('Database connection failed', { error:err.message });
    process.exit(1);
  }

  wsServer.initWsServer(server);
  startBillingCron();

  server.listen(PORT, () => {
    logger.info('═══════════════════════════════════════');
    logger.info(' Visakhapatnam Streetlight Platform');
    logger.info(` Poles: 2,00,000  |  Port: ${PORT}`);
    logger.info(` http://localhost:${PORT}/api/v1`);
    logger.info('═══════════════════════════════════════');
  });
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

start();