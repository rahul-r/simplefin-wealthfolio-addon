import type { AccountType, HostAPI } from '@wealthfolio/addon-sdk';
import { fetchAccounts } from '../simplefin/client';
import type { SfAccount, SfTransaction } from '../simplefin/parse';
import { cashAccountIdsFrom, type AccountMapping, type SyncConfig } from '../storage/config';
import { appendRun, type AccountRunResult, type SyncRun } from '../storage/history';
import { readStaging, writeStaging, type StagedCandidate } from '../storage/staging';
import { readWatermark, writeWatermark } from '../storage/watermark';
import { activityEpoch, syncCashAccount } from './activities';
import { compareBalances, type BalanceCheck } from './balance';
import { buildOpeningBalanceActivity, sumDecimal } from './openingBalance';
import { runReconciliation } from './reconciliation';
import { syncHoldingsAccount } from './snapshots';

/**
 * Re-fetch overlap. The Bridge can post a transaction days after its posted
 * date, so each run asks for a window before the watermark and relies on the
 * recent-id set to discard what we already pushed.
 */
const OVERLAP_DAYS = 7;
const SECONDS_PER_DAY = 86_400;

/**
 * The Bridge advises against requesting more than 45 days of history in one
 * call (older requests come back with an advisory error). A first sync has
 * no need to push right up against that limit anyway — the opening-balance
 * plug below covers whatever real history this can't reach.
 */
const FULL_HISTORY_DAYS = 40;

/**
 * Full-history pull for a CASH mapping's first-ever sync. The shared batch
 * fetch in runSync is deliberately windowed (lookbackDays), so a fresh
 * mapping never gets more than one statement cycle from it — this is the
 * separate, per-account counterpart that asks for as much of that as the
 * Bridge allows, so the opening-balance plug below has as little gap as
 * possible left to cover.
 */
async function fetchFullHistory(
  api: HostAPI,
  baseUrl: string,
  sfAccountId: string,
): Promise<SfAccount | undefined> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { accounts } = await fetchAccounts(api.network, baseUrl, {
    accountIds: [sfAccountId],
    startDate: nowSeconds - FULL_HISTORY_DAYS * SECONDS_PER_DAY,
  });
  return accounts.find((a) => a.id === sfAccountId);
}

/**
 * Plugs the gap between SimpleFIN's current balance and whatever the
 * full-history pull actually landed in Wealthfolio, as one synthetic
 * DEPOSIT/WITHDRAWAL activity. No-op on a credit-card account — see
 * `buildOpeningBalanceActivity`.
 *
 * The post-import Wealthfolio balance is computed here, not read back from
 * the host: `portfolio.recalculate()` resolving is not a reliable signal
 * that `portfolio.getLatestValuations()` reflects the activities just
 * imported — confirmed against a live host, where a `recalculate()` +
 * `getLatestValuations()` read immediately after import came back against
 * the pre-import (empty) balance, silently doubling the plug by the whole
 * real-history total. `preSyncBalance` (read once, before this run touched
 * anything) plus the signed sum of what actually got imported this run can't
 * race with anything, since both are already-known values.
 */
async function pushOpeningBalance(
  api: HostAPI,
  mapping: AccountMapping,
  sfAccount: SfAccount,
  preSyncBalance: string | null,
  importedTxns: SfTransaction[],
  destinationAccountType: AccountType,
  currency: string,
): Promise<number> {
  const wfBalance = sumDecimal([preSyncBalance ?? '0', ...importedTxns.map((t) => t.amount)]);

  // Anchored on the same instant that dates the activities themselves
  // (`activityEpoch`), not on `posted` — otherwise a transaction dated by its
  // earlier `transacted_at` would sit before the opening entry meant to
  // precede it.
  const posted = sfAccount.transactions.filter((t) => !t.pending);
  const earliestPosted =
    posted.length > 0 ? Math.min(...posted.map((t) => activityEpoch(t))) : null;

  const plug = buildOpeningBalanceActivity(
    {
      sfBalance: sfAccount.balance,
      wfBalance,
      earliestPosted,
      balanceDate: sfAccount.balanceDate,
    },
    mapping,
    currency,
    destinationAccountType,
  );
  if (!plug) return 0;

  const [checked] = await api.activities.checkImport([plug]);
  if (!checked.isValid || checked.duplicateOfId) return 0;

  await api.activities.import([checked]);
  return 1;
}

async function syncOne(
  api: HostAPI,
  baseUrl: string,
  mapping: AccountMapping,
  sfAccount: SfAccount | undefined,
  wfBalances: Map<string, string>,
  wfAccountTypes: Map<string, AccountType>,
  wfAccountCurrencies: Map<string, string>,
  paymentKeywords: string[],
  transferKeywords: string[],
): Promise<{ accountResult: AccountRunResult; candidates: StagedCandidate[] }> {
  const base: AccountRunResult = {
    sfAccountId: mapping.sfAccountId,
    sfAccountName: mapping.sfAccountName,
    orgName: mapping.orgName,
    wfAccountId: mapping.wfAccountId,
    mode: mapping.mode,
    imported: null,
    skipped: null,
    duplicates: null,
    error: null,
    balanceMismatch: null,
    balanceUnchecked: null,
    warning: null,
  };

  if (!sfAccount) {
    return {
      accountResult: {
        ...base,
        error:
          `SimpleFIN account ${mapping.sfAccountId} was not returned by the Bridge. ` +
          'It may have been disconnected — re-check the mapping.',
      },
      candidates: [],
    };
  }

  try {
    if (mapping.mode === 'HOLDINGS') {
      const destinationCurrency =
        wfAccountCurrencies.get(mapping.wfAccountId) ?? sfAccount.currency;
      const { imported, skipped, unresolvedSymbols } = await syncHoldingsAccount(
        api,
        mapping,
        sfAccount,
        destinationCurrency,
      );
      const balance = compareBalances(
        sfAccount.balance,
        wfBalances.get(mapping.wfAccountId) ?? null,
      );
      return {
        accountResult: {
          ...base,
          imported,
          skipped,
          duplicates: 0,
          balanceMismatch: balance.mismatch,
          balanceUnchecked: balance.unchecked,
          warning:
            unresolvedSymbols.length > 0
              ? `Wealthfolio could not resolve ${unresolvedSymbols.join(', ')} — ` +
                'those holdings may be priced against the wrong security'
              : null,
        },
        candidates: [],
      };
    }

    const watermark = await readWatermark(api, mapping.wfAccountId);
    const isFirstSync = watermark.lastPosted === 0;

    // A fresh mapping never has enough in the shared, lookbackDays-windowed
    // batch fetch to seed an accurate opening balance — pull this one
    // account's full history separately before pushing anything.
    const syncSfAccount = isFirstSync
      ? ((await fetchFullHistory(api, baseUrl, mapping.sfAccountId)) ?? sfAccount)
      : sfAccount;

    const destinationAccountType = wfAccountTypes.get(mapping.wfAccountId) ?? 'CASH';
    // Activities register in the Wealthfolio account's own currency, not
    // whatever the Bridge reports for the source account — this addon does no
    // FX conversion, so the two must agree. Falls back to the Bridge's
    // currency only if the account lookup above came back empty (e.g. the
    // diagnostic `accounts.getAll()` read failed).
    const destinationCurrency = wfAccountCurrencies.get(mapping.wfAccountId) ?? syncSfAccount.currency;
    const {
      result,
      watermark: next,
      candidates,
      importedTxns,
    } = await syncCashAccount(
      api,
      mapping,
      syncSfAccount,
      watermark,
      destinationAccountType,
      destinationCurrency,
      paymentKeywords,
      transferKeywords,
    );
    await writeWatermark(api, mapping.wfAccountId, next);

    const plugImported = isFirstSync
      ? await pushOpeningBalance(
          api,
          mapping,
          syncSfAccount,
          wfBalances.get(mapping.wfAccountId) ?? null,
          importedTxns,
          destinationAccountType,
          destinationCurrency,
        )
      : 0;

    // A first-sync account's balance was just brought into agreement by the
    // plug above (or never disagreed); comparing against the pre-run snapshot
    // in wfBalances would flag a stale, misleading mismatch.
    const balance: BalanceCheck = isFirstSync
      ? {
          mismatch: null,
          unchecked:
            'first sync, where the opening-balance entry has just brought the two ' +
            'into agreement',
        }
      : compareBalances(sfAccount.balance, wfBalances.get(mapping.wfAccountId) ?? null);

    return {
      accountResult: {
        ...base,
        imported: result.imported + plugImported,
        skipped: result.skipped,
        duplicates: result.duplicates,
        balanceMismatch: balance.mismatch,
        balanceUnchecked: balance.unchecked,
      },
      candidates,
    };
  } catch (error) {
    // Per-institution isolation is a hard invariant: record and continue.
    const message = error instanceof Error ? error.message : String(error);
    api.logger.error(`[simplefin] account ${mapping.sfAccountName} failed: ${message}`);
    return { accountResult: { ...base, error: message }, candidates: [] };
  }
}

export async function runSync(api: HostAPI, config: SyncConfig): Promise<SyncRun> {
  if (!config.baseUrl) {
    throw new Error('Not connected to SimpleFIN — claim a setup token first.');
  }

  const startedAt = new Date().toISOString();

  // One fetch covers every account; the Bridge bills per call, and a single
  // response also lets one institution's error surface alongside healthy data.
  // The window starts at the oldest watermark so no account is short-changed.
  const watermarks = await Promise.all(
    config.mappings.map((m) => readWatermark(api, m.wfAccountId)),
  );
  const oldestWatermark = watermarks.reduce(
    (min, wm) => (wm.lastPosted > 0 && wm.lastPosted < min ? wm.lastPosted : min),
    Number.POSITIVE_INFINITY,
  );
  const watermarkFloor = oldestWatermark - OVERLAP_DAYS * SECONDS_PER_DAY;

  // A mapping added after its sibling accounts already have recent watermarks
  // would otherwise inherit their (much later) shared start date and never
  // get its own history. `lookbackDays` guarantees every sync reaches back at
  // least that far, regardless of what the other accounts' watermarks say.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lookbackFloor = nowSeconds - config.lookbackDays * SECONDS_PER_DAY;

  const startDate = Math.max(0, Math.min(watermarkFloor, lookbackFloor));

  const { accounts, errors } = await fetchAccounts(api.network, config.baseUrl, {
    startDate,
    accountIds: config.mappings.map((m) => m.sfAccountId),
  });

  const bySfId = new Map(accounts.map((a) => [a.id, a]));

  // Wealthfolio balances for the post-sync mismatch check. A failure here must
  // not fail the run — the check is diagnostic, so it degrades to "unavailable".
  // The balance comes from `portfolio.getLatestValuations` — confirmed against
  // a live host that `accounts.getAll()` doesn't carry a `balance` field at all.
  const wfBalances = new Map<string, string>();
  const wfAccountTypes = new Map<string, AccountType>();
  const wfAccountCurrencies = new Map<string, string>();
  try {
    for (const account of await api.accounts.getAll()) {
      wfAccountTypes.set(account.id, account.accountType);
      wfAccountCurrencies.set(account.id, account.currency);
    }
    await api.portfolio.recalculate();
    const valuations = await api.portfolio.getLatestValuations(
      config.mappings.map((m) => m.wfAccountId),
    );
    for (const valuation of valuations) {
      if (Number.isFinite(valuation.cashBalance)) {
        wfBalances.set(valuation.accountId, String(valuation.cashBalance));
      }
    }
  } catch (error) {
    api.logger.error(
      `[simplefin] could not read Wealthfolio balances for the mismatch check: ${String(error)}`,
    );
  }

  // Sequential on purpose: the host import APIs are shared state, and a serial
  // run keeps one slow institution from being blamed for another's timeout.
  const results: AccountRunResult[] = [];
  const detectedCandidates: StagedCandidate[] = [];
  for (const mapping of config.mappings) {
    const { accountResult, candidates } = await syncOne(
      api,
      config.baseUrl,
      mapping,
      bySfId.get(mapping.sfAccountId),
      wfBalances,
      wfAccountTypes,
      wfAccountCurrencies,
      config.paymentKeywords,
      config.transferKeywords,
    );
    results.push(accountResult);
    detectedCandidates.push(...candidates);
  }

  // Best-effort: refresh the host's own cached valuations to reflect what
  // this run just imported, for whatever reads them next. Nothing in this
  // run's own results depends on it, so a failure here is not fatal.
  try {
    await api.portfolio.recalculate();
  } catch (error) {
    api.logger.error(`[simplefin] post-sync portfolio.recalculate failed: ${String(error)}`);
  }

  const cashAccountIds = cashAccountIdsFrom(config.mappings, (id) => wfAccountTypes.get(id));
  try {
    const existingStaging = await readStaging(api);
    const { candidates: remainingCandidates } = await runReconciliation(
      api,
      [...existingStaging, ...detectedCandidates],
      cashAccountIds,
      nowSeconds,
    );
    await writeStaging(api, remainingCandidates);
  } catch (error) {
    // Reconciliation is a secondary pass over transactions that already
    // synced successfully — a failure here must not undo or block the run
    // that already happened.
    api.logger.error(`[simplefin] reconciliation pass failed: ${String(error)}`);
  }

  const run: SyncRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    accounts: results,
    bridgeErrors: errors,
  };

  await appendRun(api, run);
  return run;
}
