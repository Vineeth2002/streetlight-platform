require('dotenv').config();
const pgp = require('pg-promise')({
  error(err, e) {
    if (e.cn) console.error('DB Connection error:', err.message);
    if (e.query) console.error('Query that failed:', e.query);
  },
});

const dbConfig = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'streetlight_vssp',
  user:     process.env.DB_USER     || 'streetlight_admin',
  password: process.env.DB_PASSWORD,
  max:      parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis:       parseInt(process.env.DB_POOL_IDLE_TIMEOUT)       || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT) || 2000,
};

const db = pgp(dbConfig);
module.exports = db;