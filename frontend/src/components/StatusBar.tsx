/**
 * The 26px status bar: what you are connected to, how many items are in view,
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
import { cn } from '../lib/cn';
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
  const ui = useSessionStore((state) => (state.activeId ? state.ui[state.activeId] : undefined));
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
      // Quieter than everything above it: 11.5px, secondary text, no elevation.
      // It is the last thing the eye should land on.
      className="flex h-statusbar shrink-0 items-center gap-2.5 border-t border-border bg-surface-2 px-2.5 text-xs text-text-3"
    >
      {session ? (
        <span className="flex min-w-0 items-center gap-1.5">
          {/*
            Encryption is the one thing in this bar that must read instantly, so
            it is a tinted chip rather than coloured text — legible before the
            words next to it are, and not carried by colour alone.
          */}
          <span
            className={cn(
              'flex items-center gap-1 rounded-sm px-1 text-2xs font-semibold uppercase tracking-wider',
              secure ? 'bg-ok-weak text-ok' : 'bg-danger-weak text-danger',
            )}
          >
            <Icon name={secure ? 'lock' : 'unlock'} />
            {secure ? session.protocol : t('status.notEncrypted')}
          </span>
          <span className="cell-truncate font-mono text-text-2">
            {t('status.connectedAs', {
              username: session.username,
              host: session.host,
            })}
          </span>
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <Icon name="server" />
          {t('status.notConnected')}
        </span>
      )}

      <Divider />

      <span className="tnum">
        {t('status.transfers', { active: aggregates.active })}
        {aggregates.queued > 0 ? ` · ${aggregates.queued}` : ''}
      </span>
      <span className={cn('tnum', aggregates.speedBps > 0 && 'text-text-2')}>
        {aggregates.speedBps > 0 ? formatSpeed(aggregates.speedBps) : DASH}
      </span>

      <div className="flex-1" />

      {quarantined.length > 0 ? (
        <Tooltip content={t('vault.quarantinedBody')}>
          <button
            type="button"
            onClick={() => openDialog({ kind: 'settings', tab: 'security' })}
            className="press flex items-center gap-1 rounded-sm bg-warn-weak px-1.5 font-medium text-warn transition-quick hover:brightness-105"
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
        className="press flex items-center gap-1 rounded-sm px-1.5 transition-quick hover:bg-surface hover:text-text-2"
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

      <Divider />

      <span className="tnum font-mono">
        {appInfo.data
          ? `${appInfo.data.name} ${appInfo.data.version}`
          : appInfo.isError
            ? DASH
            : t('common.loading')}
      </span>
    </footer>
  );
}

/** A hairline tick between groups — quieter than the old "|" glyph. */
function Divider() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border" />;
}
