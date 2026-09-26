import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import type { AccountMapping } from '../storage/config';
import { syncHoldingsAccount, toSnapshotInput } from './snapshots';

const mapping: AccountMapping = {
  sfAccountId: 'ACT-2',
  wfAccountId: 'WF-2',
  mode: 'HOLDINGS',
  sfAccountName: 'Brokerage',
  orgName: 'Test Broker',
};

const account = (holdings: unknown[], balance = '500.00') => ({
  id: 'ACT-2',
  name: 'Brokerage',
  currency: 'USD',
  balance,
  balanceDate: 1754524800,
  orgName: 'Test Broker',
  transactions: [],
  holdings,
});

const holding = (over = {}) => ({
  symbol: 'AAPL',
  shares: '10',
  currency: 'USD',
  costBasis: '1500.00',
  purchasePrice: '150.00',
  marketValue: '2000.00',
  ...over,
});

describe('toSnapshotInput', () => {
  it('maps holdings to positions dated by the balance date', () => {
    const snapshot = toSnapshotInput(account([holding()]) as never);
    expect(snapshot.date).toBe('2025-08-07');
    expect(snapshot.positions).toEqual([
      { symbol: 'AAPL', quantity: '10', avgCost: '150.00', currency: 'USD' },
    ]);
  });

  it('derives cash by subtracting holdings from the account balance', () => {
    const snapshot = toSnapshotInput(account([holding()], '2500.00') as never);
    expect(snapshot.cashBalances).toEqual({ USD: '500.00' });
  });

  it('omits cash when a holding has no market value', () => {
    const snapshot = toSnapshotInput(account([holding({ marketValue: null })], '2000.00') as never);
    expect(snapshot.cashBalances).toEqual({});
  });

  it('drops holdings with no symbol, which cannot be resolved to an asset', () => {
    const snapshot = toSnapshotInput(account([holding({ symbol: '' })]) as never);
    expect(snapshot.positions).toEqual([]);
  });

  it('drops holdings with no share count', () => {
    const snapshot = toSnapshotInput(account([holding({ shares: null })]) as never);
    expect(snapshot.positions).toEqual([]);
  });
});

describe('syncHoldingsAccount', () => {
  it('skips a snapshot whose date already exists', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: ['2025-08-07'],
      symbols: [],
      validationErrors: [],
    }));
    host.api.snapshots.importSnapshots = vi.fn();

    const result = await syncHoldingsAccount(host.api, mapping, account([holding()]) as never);

    expect(host.api.snapshots.importSnapshots).not.toHaveBeenCalled();
    expect(result).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
  });

  it('imports a snapshot for a new date', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: [],
      symbols: [],
      validationErrors: [],
    }));
    host.api.snapshots.importSnapshots = vi.fn(async () => ({
      snapshotsImported: 1,
      snapshotsFailed: 0,
      errors: [],
    }));

    const result = await syncHoldingsAccount(host.api, mapping, account([holding()]) as never);

    expect(host.api.snapshots.importSnapshots).toHaveBeenCalledWith('WF-2', expect.any(Array));
    expect(result).toEqual({ imported: 1, skipped: 0, unresolvedSymbols: [] });
  });

  it('throws when checkImport reports validation errors', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: [],
      symbols: [],
      validationErrors: ['unknown symbol ZZZZ'],
    }));

    await expect(
      syncHoldingsAccount(host.api, mapping, account([holding()]) as never),
    ).rejects.toThrow(/unknown symbol ZZZZ/);
  });

  it('does nothing for an account with no holdings', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn();

    const result = await syncHoldingsAccount(host.api, mapping, account([]) as never);

    expect(host.api.snapshots.checkImport).not.toHaveBeenCalled();
    expect(result).toEqual({ imported: 0, skipped: 0, unresolvedSymbols: [] });
  });

  it('treats an ISO-instant existingDates entry as the same day, not a new snapshot', async () => {
    // The host types existingDates as string[] without pinning the format and
    // returns full ISO instants for activity dates elsewhere. Comparing raw
    // would re-import the same snapshot on every run.
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: ['2025-08-07T00:00:00.000Z'],
      symbols: [],
      validationErrors: [],
    }));

    const result = await syncHoldingsAccount(host.api, mapping, account([holding()]) as never);

    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(host.api.snapshots.importSnapshots).not.toHaveBeenCalled();
  });

  it('reports symbols Wealthfolio could not resolve, and imports them anyway', async () => {
    // Dropping them would silently shrink the account's holdings; importing
    // them silently would hide a mispriced position (a crypto BTC valued as an
    // unrelated NASDAQ listing). Import, but surface it.
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: [],
      symbols: [
        { symbol: 'BTC', found: false },
        { symbol: 'VOO', found: true },
      ],
      validationErrors: [],
    }));
    host.api.snapshots.importSnapshots = vi.fn(async () => ({
      snapshotsImported: 1,
      snapshotsFailed: 0,
      errors: [],
    }));

    const result = await syncHoldingsAccount(host.api, mapping, account([holding()]) as never);

    expect(result.unresolvedSymbols).toEqual(['BTC']);
    expect(host.api.snapshots.importSnapshots).toHaveBeenCalled();
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('BTC'));
  });

  it('reports no unresolved symbols when the host placed every one', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: [],
      symbols: [{ symbol: 'VOO', found: true }],
      validationErrors: [],
    }));
    host.api.snapshots.importSnapshots = vi.fn(async () => ({
      snapshotsImported: 1,
      snapshotsFailed: 0,
      errors: [],
    }));

    const result = await syncHoldingsAccount(host.api, mapping, account([holding()]) as never);

    expect(result.unresolvedSymbols).toEqual([]);
    expect(host.api.logger.error).not.toHaveBeenCalled();
  });
});
