'use strict';
require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const http         = require('http');
const path         = require('path');

const logger       = require('./utils/logger');
const db           = require('../config/database');
const { initWsServer, getStats } = require('./websocket/wsServer');
const { startBillingCron } = require('./services/slaBillingService');
const { requireAuth, requireRole } = require('./middleware/auth');

// ─── Validate required environment variables ──────────────────────────────────
const REQUIRED_ENV = [
  'DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','JWT_SECRET'
];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`[FATAL] Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const PORT      = parseInt(process.env.PORT) || 3000;
const NODE_ENV  = process.env.NODE_ENV || 'development';
const CITY_NAME = process.env.CITY_NAME || 'Visakhapatnam';
const TOTAL_POLES = parseInt(process.env.TOTAL_POLES) || 200000;

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
// Trust Render's proxy
app.set('trust proxy', 1);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'cdn.jsdelivr.net'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
      imgSrc:      ["'self'", 'data:', '*.openstreetmap.org', '*.tile.openstreetmap.org'],
      connectSrc:  ["'self'", 'ws:', 'wss:'],
      fontSrc:     ["'self'", 'cdn.jsdelivr.net'],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = NODE_ENV === 'production'
  ? (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (NODE_ENV === 'development') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-API-Key'],
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ─── HTTP logging ─────────────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim(), { source: 'http' }) },
  skip:   (req) => req.path === '/health',
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Global rate limit
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 500,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'Too many requests. Please slow down.' },
}));

// Strict rate limit for auth endpoints
app.use('/api/v1/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      20,              // 20 login attempts per 15 min per IP
  message:  { ok: false, error: 'Too many login attempts. Try again later.' },
}));

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public'), {
  index: false, // Don't auto-serve index.html — we control routing
  etag:  true,
  maxAge: NODE_ENV === 'production' ? '1d' : 0,
}));

// ─── Serve login page at root if not authenticated ────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// Serve specific HTML pages
const HTML_PAGES = ['login','index','contractor','ee-dashboard','field'];
HTML_PAGES.forEach(page => {
  app.get(`/${page}.html`, (req, res) => {
    res.sendFile(path.join(__dirname, `../public/${page}.html`));
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbStatus = 'connected';
  try {
    await db.one('SELECT 1');
  } catch {
    dbStatus = 'disconnected';
  }
  res.json({
    ok:           true,
    service:      `${CITY_NAME} Streetlight Platform`,
    city:         CITY_NAME,
    total_poles:  TOTAL_POLES,
    environment:  NODE_ENV,
    db:           dbStatus,
    websocket:    getStats(),
    uptime_s:     Math.floor(process.uptime()),
    memory_mb:    Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    version:      '1.0.0',
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
const authRoutes        = require('./routes/auth');
const adminRoutes       = require('./routes/admin');
const polesRoutes       = require('./routes/poles');
const workOrderRoutes   = require('./routes/workOrders');
const telemetryRoutes   = require('./routes/telemetry');
const attachmentRoutes  = require('./routes/attachments');
const billingRoutes     = require('./routes/billing');

// Public routes
app.use('/api/v1/auth',        authRoutes);

// Admin routes (protected inside admin.js)
app.use('/api/v1/admin',       adminRoutes);

// Protected routes
app.use('/api/v1/poles',       polesRoutes);
app.use('/api/v1/work-orders', workOrderRoutes);
app.use('/api/v1/telemetry',   telemetryRoutes);
app.use('/api/v1/attachments', attachmentRoutes);
app.use('/api/v1/billing',     billingRoutes);

// ─── API info ─────────────────────────────────────────────────────────────────
app.get('/api/v1', (req, res) => {
  res.json({
    service:  'Municipal Infrastructure Asset Intelligence Platform',
    module:   'Streetlight',
    version:  '1.0.0',
    city:     CITY_NAME,
    poles:    TOTAL_POLES,
    endpoints: {
      auth: {
        'POST /api/v1/auth/login':           'Login',
        'POST /api/v1/auth/logout':          'Logout',
        'POST /api/v1/auth/refresh':         'Refresh token',
        'GET  /api/v1/auth/me':              'Current user',
        'POST /api/v1/auth/change-password': 'Change password',
        'POST /api/v1/auth/logout-all':      'Logout all devices',
      },
      poles: {
        'GET  /api/v1/poles':                'List poles',
        'GET  /api/v1/poles/zones':          'Zone glow rates',
        'GET  /api/v1/poles/:id':            'Pole details',
        'POST /api/v1/poles':                'Add pole',
        'PATCH /api/v1/poles/:id':           'Update pole',
        'DELETE /api/v1/poles/:id':          'Decommission pole',
        'GET  /api/v1/poles/search/:q':      'Search poles',
      },
      workOrders: {
        'GET  /api/v1/work-orders':          'List work orders',
        'GET  /api/v1/work-orders/sla-breaches': 'SLA violations',
        'GET  /api/v1/work-orders/:id':      'Work order details',
        'POST /api/v1/work-orders':          'Create work order',
        'PATCH /api/v1/work-orders/:id':     'Update work order',
      },
      telemetry: {
        'POST /api/v1/telemetry/node':        'Ingest node reading',
        'POST /api/v1/telemetry/attachment':  'Ingest sensor data',
        'GET  /api/v1/telemetry/node/:pole':  'Pole telemetry history',
        'GET  /api/v1/telemetry/stats':       '24hr stats',
      },
      billing: {
        'GET  /api/v1/billing/simulate':      'Simulate penalty',
        'GET  /api/v1/billing/summary':       'Contractor billing summary',
        'GET  /api/v1/billing/penalties':     'Active penalties',
        'POST /api/v1/billing/audit':         'Run billing audit',
        'POST /api/v1/billing/audit/dry-run': 'Preview billing audit',
        'GET  /api/v1/billing/report/preview':'Monthly report preview',
        'POST /api/v1/billing/report/send':   'Send monthly report',
      },
      admin: {
        'GET  /api/v1/admin/users':           'List users',
        'POST /api/v1/admin/users':           'Create user',
        'PATCH /api/v1/admin/users/:id':      'Update user',
        'DELETE /api/v1/admin/users/:id':     'Deactivate user',
        'POST /api/v1/admin/users/:id/reset-password': 'Reset password',
        'GET  /api/v1/admin/audit-log':       'Audit log',
      },
    },
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
  }
  // Non-API 404 — redirect to login
  res.redirect('/login.html');
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error:  err.message,
    stack:  NODE_ENV === 'development' ? err.stack : undefined,
    path:   req.path,
    method: req.method,
  });

  if (err.message?.includes('CORS')) {
    return res.status(403).json({ ok: false, error: 'CORS policy violation' });
  }

  res.status(500).json({
    ok:    false,
    error: NODE_ENV === 'development' ? err.message : 'Internal server error',
  });
});

// ─── Server startup ───────────────────────────────────────────────────────────
async function start() {
  try {
    // Test DB connection
    await db.one('SELECT NOW() AS now');
    logger.info('Database connected');

    // Create HTTP server
    const server = http.createServer(app);

    // Init WebSocket
    initWsServer(server);
    logger.info('WebSocket server initialised');

    // Start billing cron
    startBillingCron();

    // Start listening
    server.listen(PORT, () => {
      logger.info('═══════════════════════════════════════');
      logger.info(` Municipal Infrastructure Asset Intelligence Platform`);
      logger.info(` Module: Streetlight — ${CITY_NAME}`);
      logger.info(` Poles: ${TOTAL_POLES.toLocaleString('en-IN')}  |  Port: ${PORT}`);
      logger.info(` Dashboard: http://localhost:${PORT}`);
      logger.info(`    API:     http://localhost:${PORT}/api/v1`);
      logger.info(`    Health:  http://localhost:${PORT}/health`);
      logger.info(` Environment: ${NODE_ENV}`);
      logger.info('═══════════════════════════════════════');
    });

    // ─── Graceful shutdown ────────────────────────────────────────────────────
    const shutdown = async (signal) => {
      logger.info(`${signal} received — shutting down gracefully`);
      server.close(async () => {
        try {
          await db.$pool.end();
          logger.info('Database pool closed');
        } catch (err) {
          logger.error('DB pool close error', { error: err.message });
        }
        process.exit(0);
      });

      // Force exit after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', { error: err.message, stack: err.stack });
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason: String(reason) });
    });

  } catch (err) {
    logger.error('Server startup failed', { error: err.message });
    process.exit(1);
  }
}

start();