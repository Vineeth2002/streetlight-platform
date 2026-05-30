require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logFile   = fs.createWriteStream(path.join(logsDir, 'platform.log'),  { flags: 'a' });
const errorFile = fs.createWriteStream(path.join(logsDir, 'error.log'), { flags: 'a' });

function formatMsg(level, message, meta) {
  const ts   = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level.toUpperCase()}] ${message}${metaStr}`;
}

const COLOURS = { info:'\x1b[36m', warn:'\x1b[33m', error:'\x1b[31m', debug:'\x1b[90m' };
const RESET   = '\x1b[0m';

function write(level, message, meta) {
  const line = formatMsg(level, message, meta);
  const colour = COLOURS[level] || '';
  console.log(`${colour}${line}${RESET}`);
  logFile.write(line + '\n');
  if (level === 'error') errorFile.write(line + '\n');
}

const logger = {
  info:  (msg, meta) => write('info',  msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),
};

module.exports = logger;
