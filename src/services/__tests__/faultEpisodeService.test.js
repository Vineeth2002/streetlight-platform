'use strict';

jest.mock('../../../config/database', () => ({
  tx: jest.fn(),
  oneOrNone: jest.fn(),
}));

const db = require('../../../config/database');
const { openOrRefreshEpisode, markRecovered } = require('../faultEpisodeService');

describe('faultEpisodeService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates one episode for a new pole/fault', async () => {
    const inserted = {
      episode_id: 'ep-1', pole_id: 10, fault_category: 'DRIVER_FAULT', status: 'OPEN'
    };
    const tx = {
      oneOrNone: jest.fn().mockResolvedValue(null),
      one: jest.fn().mockResolvedValue(inserted),
    };
    db.tx.mockImplementation(async fn => fn(tx));

    const result = await openOrRefreshEpisode({
      poleId: 10,
      faultCategory: 'DRIVER_FAULT',
      observedAt: '2026-09-01T10:00:00Z',
    });

    expect(result).toEqual({ created: true, episode: inserted });
    expect(tx.one).toHaveBeenCalledTimes(1);
  });

  test('refreshes the existing open episode instead of creating another', async () => {
    const existing = {
      episode_id: 'ep-1', pole_id: 10, fault_category: 'DRIVER_FAULT', status: 'OPEN'
    };
    const refreshed = { ...existing, last_observed_at: '2026-09-01T10:05:00Z' };
    const tx = {
      oneOrNone: jest.fn().mockResolvedValue(existing),
      one: jest.fn().mockResolvedValue(refreshed),
    };
    db.tx.mockImplementation(async fn => fn(tx));

    const result = await openOrRefreshEpisode({
      poleId: 10,
      faultCategory: 'DRIVER_FAULT',
      observedAt: '2026-09-01T10:05:00Z',
    });

    expect(result.created).toBe(false);
    expect(result.episode.episode_id).toBe('ep-1');
    expect(tx.one).toHaveBeenCalledTimes(1);
  });

  test('recovery closes only the matching open episode into RECOVERED state', async () => {
    const recovered = {
      episode_id: 'ep-1', pole_id: 10, fault_category: 'DRIVER_FAULT', status: 'RECOVERED'
    };
    db.oneOrNone.mockResolvedValue(recovered);

    const result = await markRecovered({
      poleId: 10,
      faultCategory: 'DRIVER_FAULT',
      recoveredAt: '2026-09-01T11:00:00Z',
    });

    expect(result).toEqual(recovered);
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
  });

  test('returns null when there is no open matching episode to recover', async () => {
    db.oneOrNone.mockResolvedValue(null);

    const result = await markRecovered({
      poleId: 99,
      faultCategory: 'CABLE_FAULT',
      recoveredAt: '2026-09-01T11:00:00Z',
    });

    expect(result).toBeNull();
  });
});
