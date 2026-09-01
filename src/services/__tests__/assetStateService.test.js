'use strict';

jest.mock('../../../config/database', () => ({
  tx: jest.fn(),
  oneOrNone: jest.fn(),
}));

const db = require('../../../config/database');
const { VALID_STATES, transitionPoleState, applyTelemetryState } = require('../assetStateService');

describe('assetStateService', () => {
  beforeEach(() => jest.clearAllMocks());

  function mockTelemetryPole(pole) {
    db.oneOrNone.mockResolvedValue(pole);
  }

  function mockTransition(pole, none = jest.fn().mockResolvedValue(undefined)) {
    db.tx.mockImplementation(async callback => callback({
      oneOrNone: jest.fn().mockResolvedValue(pole),
      none,
    }));
    return none;
  }

  test('keeps the database status vocabulary aligned with the schema', () => {
    expect([...VALID_STATES]).toEqual(expect.arrayContaining([
      'OPERATIONAL', 'FAULTY', 'UNDER_REPAIR', 'DECOMMISSIONED', 'DAY_BURN', 'NO_SIGNAL'
    ]));
    expect(VALID_STATES.has('UNDER_MAINTENANCE')).toBe(false);
  });

  test('rejects an unsupported state before touching the database', async () => {
    await expect(transitionPoleState({
      poleNumber: 'P-001',
      nextState: 'UNDER_MAINTENANCE',
    })).rejects.toThrow('Unsupported pole state');
    expect(db.tx).not.toHaveBeenCalled();
  });

  test('does not let telemetry overwrite UNDER_REPAIR', async () => {
    mockTelemetryPole({
      pole_id: 1, pole_number: 'P-001', current_status: 'UNDER_REPAIR', has_active_work_order: false,
    });
    mockTransition({ pole_id: 1, pole_number: 'P-001', current_status: 'UNDER_REPAIR' });

    const result = await applyTelemetryState({ poleNumber: 'P-001', healthy: true, signalPresent: true });

    expect(result.reason).toBe('STATE_OWNED_BY_WORKFLOW');
    expect(db.tx).not.toHaveBeenCalled();
  });

  test('does not let telemetry overwrite DECOMMISSIONED', async () => {
    mockTelemetryPole({
      pole_id: 2, pole_number: 'P-002', current_status: 'DECOMMISSIONED', has_active_work_order: false,
    });
    mockTransition({ pole_id: 2, pole_number: 'P-002', current_status: 'DECOMMISSIONED' });

    const result = await applyTelemetryState({ poleNumber: 'P-002', healthy: false, signalPresent: true });

    expect(result.reason).toBe('STATE_OWNED_BY_WORKFLOW');
    expect(db.tx).not.toHaveBeenCalled();
  });

  test('does not restore OPERATIONAL while an active work order exists', async () => {
    mockTelemetryPole({
      pole_id: 7, pole_number: 'P-007', current_status: 'FAULTY', has_active_work_order: true,
    });

    const result = await applyTelemetryState({ poleNumber: 'P-007', healthy: true });

    expect(result.reason).toBe('RECOVERY_REQUIRES_WORKFLOW_VERIFICATION');
    expect(db.tx).not.toHaveBeenCalled();
  });

  test('maps healthy telemetry to OPERATIONAL', async () => {
    mockTelemetryPole({
      pole_id: 3, pole_number: 'P-003', current_status: 'FAULTY', has_active_work_order: false,
    });
    const none = mockTransition({
      pole_id: 3, pole_number: 'P-003', current_status: 'FAULTY',
    });

    const result = await applyTelemetryState({ poleNumber: 'P-003', healthy: true });

    expect(result).toMatchObject({
      changed: true,
      previousState: 'FAULTY',
      currentState: 'OPERATIONAL',
      reason: 'TELEMETRY_HEALTHY',
    });
    expect(none).toHaveBeenCalled();
  });

  test('maps unhealthy telemetry to FAULTY', async () => {
    mockTelemetryPole({
      pole_id: 4, pole_number: 'P-004', current_status: 'OPERATIONAL', has_active_work_order: false,
    });
    mockTransition({ pole_id: 4, pole_number: 'P-004', current_status: 'OPERATIONAL' });

    const result = await applyTelemetryState({ poleNumber: 'P-004', healthy: false });

    expect(result.currentState).toBe('FAULTY');
    expect(result.reason).toBe('TELEMETRY_FAULT');
  });

  test('maps missing signal to NO_SIGNAL', async () => {
    mockTelemetryPole({
      pole_id: 5, pole_number: 'P-005', current_status: 'OPERATIONAL', has_active_work_order: false,
    });
    mockTransition({ pole_id: 5, pole_number: 'P-005', current_status: 'OPERATIONAL' });

    const result = await applyTelemetryState({ poleNumber: 'P-005', healthy: true, signalPresent: false });

    expect(result).toMatchObject({
      changed: true,
      currentState: 'NO_SIGNAL',
      reason: 'TELEMETRY_STALE',
    });
  });

  test('does not issue an update when the state is unchanged', async () => {
    mockTelemetryPole({
      pole_id: 6, pole_number: 'P-006', current_status: 'OPERATIONAL', has_active_work_order: false,
    });
    const none = mockTransition({
      pole_id: 6, pole_number: 'P-006', current_status: 'OPERATIONAL',
    });

    const result = await applyTelemetryState({ poleNumber: 'P-006', healthy: true });

    expect(result.reason).toBe('NO_CHANGE');
    expect(none).not.toHaveBeenCalled();
  });
});
