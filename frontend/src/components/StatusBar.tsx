/**
 * The 24px status bar: what you are connected to, how many items are in view,
 * what the queue is doing, whether the vault is open, and the real version.
 *
 * The old status bar hard-coded "ftpie v0.1.0" and showed nothing else. The
 * version now comes from `app_version`, which also reports whether any config
 * store had to be quarantined — surfaced here as a warning badge, because a
 * silently empty bookmark list is indistinguishable from data loss.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { DASH, formatSpeed } from '../lib/format';
import { useT } from '../lib/i18n';
import { call } from '../lib/ipc';
import type { AppInfo } from '../lib/types';
import { useSessionStore } from '../store/sessionStore';
import { useTransferStore } from '../store/transferStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import { Icon, Tooltip } from './ui';

/**
 * Health of the on-disk config stores. `false` means that store's file could
 * not be parsed, was quarantined as `<name>.corrupt-<timestamp>`, and loaded
 * empty **and read-only** so a later save cannot destroy recoverable data.
 */
export interface StoreHealth {
  bookmarksOk: boolean;
  scriptsOk: boolean;
  trustedHostsOk: boolean;
}

/**
 * `app_version`'s real payload. `AppInfo` in `lib/types.ts` predates the
 * `stores` field; this is the shape the command actually returns.
 */
export type AppInfoFull = AppInfo & { stores: StoreHealth };

/** Shared so the sidebar and the status bar hit one cache entry. */
export const APP_INFO_QUERY_KEY = ['app_version'] as const;

export function StatusBar() {
  const { t } = useT();

  const session = useSessionStore((state) =>
    state.activeId ? state.sessions[state.activeId] : null,
  );
  const ui = useSessionStore((state) =>
    state.activeId ? state.ui[state.activeId] : undefined,
  );
  /**
   * The store's `aggregates()` builds a fresh object, so it must not be the
   * selector itself — an uncached snapshot re-renders on every store read.
   * The bar needs three numbers, so they are derived from the item map here and
   * memoised on its identity.
   */
  const transferItems = useTransferStore((state) => state.items);
  const aggregates = useMemo(() => {
    let active = 0;
    let queued = 0;
    let speedBps = 0;
    for (const item of Object.values(transferItems)) {
      if (item.status === 'active') {
        active += 1;
        speedBps += item.speedBps;
      } else if (item.status === 'queued') {
        queued += 1;
      }
    }
    return { active, queued, speedBps };
  }, [transferItems]);
  const vault = useVaultStore((state) => state.status);
  const openDialog = useUiStore((state) => state.openDialog);

  const appInfo = useQuery<AppInfoFull, unknown>({
    queryKey: APP_INFO_QUERY_KEY,
    queryFn: () => call<AppInfoFull>('app_version'),
    retry: false,
    staleTime: Infinity,
  });

  const secure = ui?.secure ?? (session ? session.protocol !== 'ftp' : false);
  const stores = appInfo.data?.stores;
  const quarantined = stores
    ? [
        !stores.bookmarksOk && t('bookmark.title'),
        !stores.scriptsOk && t('script.title'),
        !stores.trustedHostsOk && t('trust.listTitle'),
      ].filter((value): value is string => typeof value === 'string')
    : [];

  return (
    <footer
      aria-label={t('common.status')}
      className="flex h-statusbar shrink-0 items-center gap-3 border-t border-border bg-surface-2 px-2 text-xs text-text-2"
    >
      {session ? (
        <span className="flex items-center gap-1">
          <span className={secure ? 'text-ok' : 'text-danger'}>
            <Icon name={secure ? 'lock' : 'unlock'} />
          </span>
          <span className="font-mono">
            {t('status.connectedAs', {
              username: session.username,
              host: session.host,
            })}
          </span>
          <span className="text-text-3">{session.protocol.toUpperCase()}</span>
          {!secure ? (
            <span className="font-semibold text-danger">{t('status.notEncrypted')}</span>
          ) : null}
        </span>
      ) : (
        <span className="text-text-3">{t('status.notConnected')}</span>
      )}

      <span className="text-border-strong">|</span>

      <span className="tnum">
        {t('status.transfers', { active: aggregates.active })}
        {aggregates.queued > 0 ? ` · ${aggregates.queued}` : ''}
      </span>
      <span className="tnum">
        {aggregates.speedBps > 0 ? formatSpeed(aggregates.speedBps) : DASH}
      </span>

      <div className="flex-1" />

      {quarantined.length > 0 ? (
        <Tooltip content={t('vault.quarantinedBody')}>
          <button
            type="button"
            onClick={() => openDialog({ kind: 'settings', tab: 'security' })}
            className="flex items-center gap-1 rounded border border-[var(--warn)] px-1 text-warn"
          >
            <Icon name="alert-triangle" />
            {quarantined.join(', ')}
          </button>
        </Tooltip>
      ) : null}

      <button
        type="button"
        onClick={() =>
          openDialog(
            vault?.unlocked
              ? // Already open: the useful action is managing it, not unlocking.
                { kind: 'settings', tab: 'security' }
              : { kind: 'vault', mode: vault?.initialized ? 'unlock' : 'initialize' },
          )
        }
        className="flex items-center gap-1 rounded px-1 transition-quick hover:bg-surface"
      >
        <span className={vault?.unlocked ? 'text-ok' : 'text-text-3'}>
          <Icon name={vault?.unlocked ? 'unlock' : 'lock'} />
        </span>
        {vault === null
          ? t('common.loading')
          : !vault.initialized
            ? t('vault.notInitialized')
            : vault.unlocked
              ? t('status.vaultUnlocked')
              : t('status.vaultLocked')}
      </button>

      <span className="font-mono text-text-3">
        {appInfo.data
          ? `${appInfo.data.name} ${appInfo.data.version}`
          : appInfo.isError
            ? DASH
            : t('common.loading')}
      </span>
    </footer>
  );
}
