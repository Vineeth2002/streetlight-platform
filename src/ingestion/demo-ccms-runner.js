'use strict';

const http = require('http');
const { createScenario } = require('./demo-ccms');

const host = process.env.DEMO_CCMS_HOST || '127.0.0.1';
const port = Number(process.env.DEMO_CCMS_PORT || 3000);
const intervalMs = Math.max(Number(process.env.DEMO_CCMS_INTERVAL_MS || 10000), 1000);
const apiKey = process.env.DEMO_CCMS_API_KEY || process.env.TELEMETRY_API_KEY;

if (!apiKey) {
  throw new Error('DEMO_CCMS_API_KEY or TELEMETRY_API_KEY is required');
}

function send(reading) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(reading);
    const req = http.request({
      host,
      port,
      path: '/api/v1/telemetry/node',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': apiKey
      }
    }, res => {
      let response = '';
      res.on('data', chunk => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: response }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  const scenarios = createScenario();
  const mode = process.env.DEMO_CCMS_SCENARIO || 'healthy';
  const scenario = scenarios[mode];
  if (!scenario) throw new Error(`Unknown DEMO_CCMS_SCENARIO: ${mode}`);

  const readings = scenario();
  const results = await Promise.all(readings.map(send));
  console.log(`[demo-ccms] ${mode}: sent ${results.length} readings`, results.map(r => r.status));
}

run().catch(err => {
  console.error('[demo-ccms] failed:', err.message);
  process.exitCode = 1;
});

if (process.env.DEMO_CCMS_ONCE !== 'true') {
  setInterval(() => run().catch(err => console.error('[demo-ccms] tick failed:', err.message)), intervalMs);
}
