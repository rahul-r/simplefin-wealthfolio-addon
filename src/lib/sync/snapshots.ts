import type { HostAPI, SnapshotInput } from '@wealthfolio/addon-sdk';
import type { SfAccount } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';
import { isoDate, toIsoDateOnly } from './activities';
import { subtractDecimal, sumDecimal } from './openingBalance';

/**
 * A snapshot's `date` stays a bare `YYYY-MM-DD` — unlike an activity's, which
 * must be a full instant (see `isoInstant`). A snapshot is a valuation *bucket*
 * for a calendar day, not a moment, and `checkImport` hands its idempotency
 * signal back as `existingDates`, keyed the same way.
 */
export function toSnapshotInput(sfAccount: SfAccount): SnapshotInput {
  const holdings = sfAccount.holdings.filter(
    // A position with no symbol or no share count cannot be resolved to a
    // Wealthfolio asset; sending it would fail validation for the whole batch.
    (h) => h.symbol !== '' && h.shares !== null,
  );

  const positions = holdings.map((h) => ({
    symbol: h.symbol,
    quantity: h.shares as string,
    avgCost: h.purchasePrice ?? undefined,
    currency: h.currency ?? sfAccount.currency,
  }));

  const marketValues = holdings.map((h) => h.marketValue);
  const cashBalance = marketValues.every((value): value is string => value !== null)
    ? subtractDecimal(sfAccount.balance, sumDecimal(marketValues))
    : null;

  return {
    date: isoDate(sfAccount.balanceDate),
    positions,
    cashBalances: cashBalance === null ? {} : { [sfAccount.currency]: cashBalance },
  };
}

export async function syncHoldingsAccount(
  api: HostAPI,
  mapping: AccountMapping,
  sfAccount: SfAccount,
): Promise<{ imported: number; skipped: number; unresolvedSymbols: string[] }> {
  if (sfAccount.holdings.length === 0) {
    return { imported: 0, skipped: 0, unresolvedSymbols: [] };
  }

  const snapshot = toSnapshotInput(sfAccount);
  const check = await api.snapshots.checkImport(mapping.wfAccountId, [snapshot]);

  if (check.validationErrors.length > 0) {
    throw new Error(`snapshot rejected: ${check.validationErrors.join('; ')}`);
  }

  // `checkImport` resolves every symbol against Wealthfolio's own security
  // lookup and reports which ones it couldn't place. An unresolved symbol is
  // still imported — dropping it would silently shrink the account's holdings
  // — but it gets priced against whatever instrument the bare ticker happens
  // to match, which is how a crypto BTC position ends up valued as an
  // unrelated NASDAQ listing. Surfacing it is the only way the user can tell
  // a mispriced holding from a real one, so the caller reports it.
  const unresolvedSymbols = check.symbols.filter((s) => !s.found).map((s) => s.symbol);
  if (unresolvedSymbols.length > 0) {
    api.logger.error(
      `[simplefin] Wealthfolio could not resolve ${unresolvedSymbols.length} symbol(s) for ` +
        `${mapping.sfAccountName}: ${unresolvedSymbols.join(', ')} — these holdings will be ` +
        'imported but may be priced against the wrong security',
    );
  }

  // `existingDates` is the host-side idempotency signal — holdings need no
  // local watermark because re-importing a known date is detectable here.
  // Normalised on both sides rather than compared raw: the host types this as
  // `string[]` without pinning the format, and it returns activity dates as
  // full ISO instants elsewhere. A raw `includes` would silently never match
  // if it did the same here, re-importing the same snapshot every run.
  if (check.existingDates.some((d) => toIsoDateOnly(d) === snapshot.date)) {
    return { imported: 0, skipped: 1, unresolvedSymbols };
  }

  const outcome = await api.snapshots.importSnapshots(mapping.wfAccountId, [snapshot]);

  if (outcome.errors.length > 0) {
    throw new Error(`snapshot import failed: ${outcome.errors.join('; ')}`);
  }

  return { imported: outcome.snapshotsImported, skipped: 0, unresolvedSymbols };
}
