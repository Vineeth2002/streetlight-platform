require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const migrations = [
  '001_schema.sql',
  '002_triggers.sql',
  '003_seed.sql',
];

async function runMigrations() {
  const client = new Client({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await client.connect();
    console.log(`Connected to: ${process.env.DB_NAME}`);

    for (const file of migrations) {
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      console.log(`Running: ${file}`);
      await client.query(sql);
      console.log(`Done: ${file}`);
    }

    console.log('\nAll migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();