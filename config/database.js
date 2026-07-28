require('dotenv').config();
const pgp = require('pg-promise')({
  error(err, e) {
    if (e.cn) console.error('DB Connection error:', err.message || err);
    if (e.query) console.error('Query that failed:', e.query);
  },
});

// SSL required for Neon and other cloud databases
// Force SSL if DB_SSL=true OR if host contains neon.tech or supabase
const host = process.env.DB_HOST || '';
const forceSSL = process.env.DB_SSL === 'true'
  || host.includes('neon.tech')
  || host.includes('supabase.co')
  || process.env.NODE_ENV === 'production';

const dbConfig = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'streetlight_vssp',
  user:     process.env.DB_USER     || 'streetlight_admin',
  password: process.env.DB_PASSWORD,
  max:      parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis:       parseInt(process.env.DB_POOL_IDLE_TIMEOUT)       || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT) || 10000,
  ssl: forceSSL ? { rejectUnauthorized: false } : false,
};

const db = pgp(dbConfig);
module.exports = db;