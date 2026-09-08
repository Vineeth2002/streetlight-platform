/**
 * Crisis Detection Tier Logic Tests
 *
 * These tests exercise the REAL crisis-detection SQL views against
 * the REAL database, using isolated test fixtures created and
 * cleaned up per test.
 *
 * Requires a real DB connection (uses the same config as production,
 * loaded via dotenv/config in the npm test script).
 *
 * IMPORTANT:
 * - The database pool is closed ONCE at the end of this test file.
 * - Each test cleans up only its own fixtures.
 * - Database connectivity failures are NOT swallowed or converted
 *   into passing/skipped tests.
 */

const db = require('../config/database');

const TEST_PREFIX = 'CRISIS-TEST-JEST';

let testCabinetIds = [];
let testPoleIds = [];
let testWorkOrderIds = [];

async function cleanup() {
  try {
    if (testWorkOrderIds.length) {
      await db.none('DELETE FROM work_orders WHERE work_order_id = ANY($1)', [testWorkOrderIds]);
    }
    if (testPoleIds.length) {
      await db.none('DELETE FROM poles WHERE pole_id = ANY($1)', [testPoleIds]);
    }
    if (testCabinetIds.length) {
      await db.none('DELETE FROM junction_boxes WHERE cabinet_id = ANY($1)', [testCabinetIds]);
    }
  } finally {
    // Always reset tracking arrays, even if a delete above failed —
    // otherwise a failure in one test contaminates every test after it
    // with stale IDs that keep failing the same way.
    testWorkOrderIds = [];
    testPoleIds = [];
    testCabinetIds = [];
  }
}

async function createCabinet(wardId, heartbeatMinutesAgo) {
  let heartbeat = 'NULL';
  if (heartbeatMinutesAgo !== undefined && heartbeatMinutesAgo !== null) {
    heartbeat = "NOW() - INTERVAL '" + Number(heartbeatMinutesAgo) + " minutes'";
  }

  const serial = TEST_PREFIX + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  const row = await db.one(
    'INSERT INTO junction_boxes (ward_id, cabinet_serial_no, nominal_voltage, installation_location, last_heartbeat) ' +
    'VALUES ($1, $2, 230, ST_SetSRID(ST_MakePoint(83.29, 17.76), 4326), ' + heartbeat + ') ' +
    'RETURNING cabinet_id',
    [wardId, serial]
  );

  testCabinetIds.push(row.cabinet_id);
  return row.cabinet_id;
}

async function createPole(cabinetId, poleNumSuffix) {
  const poleNumber = TEST_PREFIX + '-' + poleNumSuffix;

  const row = await db.one(
    'INSERT INTO poles (pole_number, cabinet_id, wiring_type, luminaire_wattage, geolocation, current_status) ' +
    "VALUES ($1, $2, 'OVERHEAD', 70, ST_SetSRID(ST_MakePoint(83.29, 17.76), 4326), 'OPERATIONAL') " +
    'RETURNING pole_id',
    [poleNumber, cabinetId]
  );

  testPoleIds.push(row.pole_id);
  return row.pole_id;
}

async function createFault(poleId, options) {
  const opts = options || {};
  const severityHint = opts.severityHint || 'MEDIUM';
  const faultCategory = opts.faultCategory || 'DRIVER_FAULT';
  const contractorId = opts.contractorId || 1;

  const row = await db.one(
    'INSERT INTO work_orders (pole_id, contractor_id, fault_category, fault_description, reported_by, ticket_status, severity_hint, recommended_fault, confidence_pct) ' +
    "VALUES ($1, $2, $3, 'Jest test fault', 'JEST_TEST', 'PENDING', $4, $3, 70) " +
    'RETURNING work_order_id',
    [poleId, contractorId, faultCategory, severityHint]
  );

  testWorkOrderIds.push(row.work_order_id);
  return row.work_order_id;
}

// Safety net: if a previous run crashed mid-test (timeout, uncaught
// error) it may have left orphaned fixtures behind, which would
// silently pollute this run's zone-percentage calculations. Wipe
// anything matching our test prefix before starting, regardless of
// what this run's own tracking arrays know about.
beforeAll(async () => {
  await db.none(
    "DELETE FROM work_orders WHERE pole_id IN (SELECT pole_id FROM poles WHERE pole_number LIKE $1)",
    [TEST_PREFIX + '-%']
  );
  await db.none(
    "DELETE FROM poles WHERE pole_number LIKE $1",
    [TEST_PREFIX + '-%']
  );
  await db.none(
    "DELETE FROM junction_boxes WHERE cabinet_serial_no LIKE $1",
    [TEST_PREFIX + '-%']
  );
});

afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await db.$pool.end();
  }
});

describe('Crisis Detection - v_zone_severity tiering', () => {
  afterEach(async () => {
    await cleanup();
  });

  test('zone with 0% faulted poles reports NORMAL tier', async () => {
    const cabinetId = await createCabinet(1);

    for (let i = 0; i < 5; i++) {
      await createPole(cabinetId, 'NORMAL-' + i);
    }

    const zone = await db.oneOrNone(
      'SELECT severity_tier, pct_zone_affected_1hr FROM v_zone_severity WHERE zone_id = 1'
    );

    expect(zone).not.toBeNull();
    expect(zone.severity_tier).toBe('NORMAL');
    expect(parseFloat(zone.pct_zone_affected_1hr)).toBe(0);
  });

  test('zone crossing 5% faulted poles reports SEVERE tier', async () => {
    const cabinetId = await createCabinet(1);
    const poles = [];

    for (let i = 0; i < 20; i++) {
      poles.push(await createPole(cabinetId, 'SEVERE-' + i));
    }

    await createFault(poles[0], { severityHint: 'MEDIUM' });
    await createFault(poles[1], { severityHint: 'MEDIUM' });

    const zone = await db.oneOrNone(
      'SELECT severity_tier, pct_zone_affected_1hr FROM v_zone_severity WHERE zone_id = 1'
    );

    expect(zone).not.toBeNull();
    expect(zone.severity_tier).toBe('SEVERE');
    expect(parseFloat(zone.pct_zone_affected_1hr)).toBeCloseTo(10, 1);
  });

  test('zone between 2-5% faulted poles reports ELEVATED tier', async () => {
    const cabinetId = await createCabinet(1);

    // Bulk-insert 50 poles in one statement instead of 50 sequential
    // awaited INSERTs — avoids the slow-loop timeout issue entirely.
    const insertedPoles = await db.many(
      "INSERT INTO poles (pole_number, cabinet_id, wiring_type, luminaire_wattage, geolocation, current_status) " +
      "SELECT $1 || '-' || gs, $2, 'OVERHEAD', 70, ST_SetSRID(ST_MakePoint(83.29, 17.76), 4326), 'OPERATIONAL' " +
      "FROM generate_series(1, 50) AS gs " +
      "RETURNING pole_id",
      [TEST_PREFIX + '-ELEV', cabinetId]
    );
    const poleIds = insertedPoles.map((p) => p.pole_id);
    testPoleIds.push(...poleIds);

    // 1/50 = 2% — right at the ELEVATED boundary, still within 2-5%
    await createFault(poleIds[0]);

    const zone = await db.oneOrNone(
      'SELECT severity_tier, pct_zone_affected_1hr FROM v_zone_severity WHERE zone_id = 1'
    );

    expect(zone).not.toBeNull();
    expect(zone.severity_tier).toBe('ELEVATED');
  }, 15000); // 15s timeout — safety margin, though bulk insert should be fast
});

describe('Crisis Detection - life safety hazard (independent trigger)', () => {
  afterEach(async () => {
    await cleanup();
  });

  test('a single CRITICAL LINE_FAULT appears in v_life_safety_hazards even with no other faults', async () => {
    const cabinetId = await createCabinet(1);
    const poleId = await createPole(cabinetId, 'SAFETY-1');

    await createFault(poleId, { severityHint: 'CRITICAL', faultCategory: 'LINE_FAULT' });

    const hazards = await db.manyOrNone(
      'SELECT * FROM v_life_safety_hazards WHERE pole_number = $1',
      [TEST_PREFIX + '-SAFETY-1']
    );

    expect(hazards.length).toBe(1);
  });

  test('a MEDIUM severity fault does NOT appear in v_life_safety_hazards', async () => {
    const cabinetId = await createCabinet(1);
    const poleId = await createPole(cabinetId, 'SAFETY-2');

    await createFault(poleId, { severityHint: 'MEDIUM', faultCategory: 'DRIVER_FAULT' });

    const hazards = await db.manyOrNone(
      'SELECT * FROM v_life_safety_hazards WHERE pole_number = $1',
      [TEST_PREFIX + '-SAFETY-2']
    );

    expect(hazards.length).toBe(0);
  });
});

describe('Crisis Detection - communication blackout cluster rule', () => {
  afterEach(async () => {
    await cleanup();
  });

  test('a single silent box does NOT trigger a blackout (cluster rule requires 3+)', async () => {
    await createCabinet(1, 45);

    const blackout = await db.manyOrNone(
      'SELECT * FROM v_communication_blackout WHERE zone_id = 1'
    );

    expect(blackout.length).toBe(0);
  });

  test('3+ boxes silent together in the same ward DOES trigger a blackout', async () => {
    await createCabinet(1, 45);
    await createCabinet(1, 45);
    await createCabinet(1, 45);

    const blackout = await db.manyOrNone(
      'SELECT * FROM v_communication_blackout WHERE zone_id = 1'
    );

    expect(blackout.length).toBeGreaterThanOrEqual(1);
    expect(parseInt(blackout[0].silent_box_count, 10)).toBeGreaterThanOrEqual(3);
  });

  test('a box silent for only 5 minutes does NOT count as blacked out (too recent)', async () => {
    await createCabinet(1, 5);
    await createCabinet(1, 5);
    await createCabinet(1, 5);

    const blackout = await db.manyOrNone(
      'SELECT * FROM v_communication_blackout WHERE zone_id = 1'
    );

    expect(blackout.length).toBe(0);
  });
});