'use strict';

jest.mock('../../../config/database', () => ({
  tx: jest.fn(),
}));

const db = require('../../../config/database');
const { VALID_STATES, transitionPoleState, applyTelemetryState } = require('../assetStateService');

describe('assetStateService', () => {
  beforeEach(() => jest.clearAllMocks());

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
    db.tx.mockImplementation(async callback => callback({
      oneOrNone: jest.fn().mockResolvedValue({
        pole_id: 1,
        pole_number: 'P-001',
        current_status: 'UNDER_REPAIR',
      }),
      none: jest.fn(),
    }));

    const result = await applyTelemetryState({
      poleNumber: 'P-001',
      healthy: true,
      signalPresent: true,
    });

    expect(result.reason).toBe('STATE_OWNED_BY_WORKFLOW');
  });

  test('does not let telemetry overwrite DECOMMISSIONED', async () => {
    db.tx.mockImplementation(async callback => callback({
      oneOrNone: jest.fn().mockResolvedValue({
        pole_id: 2,
        pole_number: 'P-002',
        current_status: 'DECOMMISSIONED',
      }),
      none: jest.fn(),
    }));

    const result = await applyTelemetryState({
      poleNumber: 'P-002',
      healthy: false,
      signalPresent: true,
    });

    expect(result.reason).toBe('STATE_OWNED_BY_WORKFLOW');
  });

  test('maps healthy telemetry to OPERATIONAL', async () => {
    const none = jest.fn().mockResolvedValue(undefined);
    db.tx.mockImplementation(async callback => callback({
      oneOrNone: jest.fn().mockResolvedValue({
        pole_id: 3,
        pole_number: 'P-003',
        current_status: 'FAULTY',
      }),
      none,
    }));

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
    db.tx.mockImplementation(async callback => callback({
      oneOrNone: jest.fn().mockResolvedValue({
        pole_id: 4,
        pole_number: 'P-004',
        current_status: 'OPERATIONAL',
      }),
      none: jest.fn().mockResolvedValue(undefined),
    }));

    const result = await applyTelemetryState({ poleNumber: 'P-004', healthy: false });

    expect(result.currentState).toBe('FAULTY');
    expect(result.reason).toBe('TELEMETRY_FAULT');
  });

  test('maps missing signal to NO_SIGNAL', async () => {
    db.tx.mockImplementation(async callback => callback({
      oneOrNone: jest.fn().mockResolvedValue({
        pole_id: 5,
        pole_number: 'P-005',
        current_status: 'OPERATIONAL',
      }),
      none: jest.fn().mockResolvedValue(undefined),
    }));

    const result = await applyTelemetryState({
      poleNumber: 'P-005',
      healthy: true,
      signalPresent: false,
    });

    expect(result).toMatchObject({
      changed: true,
      currentState: 'NO_SIGNAL',
      reason: 'TELEMETRY_STALE',
    });
  });

  test('does not issue an update when the state is unchanged', async () => {
    const none = jest.fn();
    db.tx.mockImplementation(async callback => callback({
      oneOrNone: jest.fn().mockResolvedValue({
        pole_id: 6,
        pole_number: 'P-006',
        current_status: 'OPERATIONAL',
      }),
      none,
    }));

    const result = await applyTelemetryState({ poleNumber: 'P-006', healthy: true });

    expect(result.reason).toBe('NO_CHANGE');
    expect(none).not.toHaveBeenCalled();
  });
});
