/**
 * The update notice.
 *
 * Renders nothing at all until the backend has confirmed a newer *signed*
 * release exists, so the common case costs one IPC call on startup and no
 * layout. Install is a button the user presses — there is no timer, no
 * "installing in 5s", and no way to reach `update_install` from here without a
 * click.
 *
 * It sits bottom-left so it cannot collide with the toast viewport
 * (bottom-right), and it stays on screen while the download runs because the
 * progress bar is the only feedback the user gets before the app relaunches.
 */
import { useEffect } from 'react';

import { formatBytes } from '../lib/format';
import { useT } from '../lib/i18n';
import { useUpdateStore } from '../store/updateStore';
import { Badge, Button, Icon, IconButton, InlineError, ProgressBar } from './ui';

export function UpdateBanner() {
  const { t } = useT();

  const available = useUpdateStore((state) => state.available);
  const dismissed = useUpdateStore((state) => state.dismissed);
  const installing = useUpdateStore((state) => state.installing);
  const progress = useUpdateStore((state) => state.progress);
  const error = useUpdateStore((state) => state.error);
  const check = useUpdateStore((state) => state.check);
  const subscribe = useUpdateStore((state) => state.subscribe);
  const install = useUpdateStore((state) => state.install);
  const dismiss = useUpdateStore((state) => state.dismiss);
  const ratio = useUpdateStore((state) => state.ratio);

  // One check per run, on start. `check()` swallows its own failure: an
  // unreachable update server must not put an error in front of someone who
  // only wanted to open an FTP connection.
  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | null = null;

    void subscribe().then(
      (unlisten) => {
        if (cancelled) unlisten();
        else detach = unlisten;
      },
      () => {
        /* No event channel means no progress bar, not a broken app. */
      },
    );
    void check();

    return () => {
      cancelled = true;
      detach?.();
    };
  }, [check, subscribe]);

  if (!available || dismissed) return null;

  const fraction = ratio();
  const downloaded = progress ? formatBytes(progress.downloaded) : null;
  const total = progress && progress.total !== null ? formatBytes(progress.total) : null;

  return (
    <section
      role="status"
      aria-label={t('update.title')}
      className="fixed bottom-2 left-2 z-50 flex w-96 max-w-[92vw] flex-col gap-2 rounded border border-accent bg-surface p-3 shadow-lg"
    >
      <header className="flex items-start gap-2">
        <Icon name="download" size={16} className="mt-0.5 flex-none text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-text">{t('update.title')}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-text-2">
            <Badge tone="accent" mono>
              {available.version}
            </Badge>
            <span className="truncate">
              {t('update.fromVersion', { current: available.currentVersion })}
            </span>
          </p>
        </div>
        <IconButton
          icon={<Icon name="x" />}
          label={t('update.dismiss')}
          size="sm"
          onClick={dismiss}
          disabled={installing}
        />
      </header>

      {available.pubDate ? (
        <p className="text-xs text-text-3">{t('update.published', { date: available.pubDate })}</p>
      ) : null}

      {available.notes ? (
        <div>
          <h3 className="text-xs uppercase tracking-wide text-text-3">{t('update.notes')}</h3>
          {/* Plain text from the manifest — never rendered as markup. */}
          <p className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm text-text-2">
            {available.notes}
          </p>
        </div>
      ) : null}

      {installing ? (
        <div className="flex flex-col gap-1">
          <ProgressBar
            value={fraction}
            label={t('update.progressLabel')}
            height={6}
            tone="accent"
          />
          <p className="tnum text-xs text-text-3">
            {downloaded && total
              ? t('update.progressOf', { done: downloaded, total })
              : downloaded
                ? t('update.progressUnknownTotal', { done: downloaded })
                : t('update.starting')}
          </p>
        </div>
      ) : null}

      {error ? <InlineError error={error} /> : null}

      <p className="text-xs text-text-3">{t('update.signedOnly')}</p>

      <footer className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={dismiss} disabled={installing}>
          {t('update.later')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={installing}
          icon={<Icon name="download" />}
          onClick={() => {
            // The rejection is already recorded in the store and rendered
            // above; swallow it so it does not surface as unhandled.
            void install().catch(() => {});
          }}
        >
          {installing ? t('update.installing') : t('update.install')}
        </Button>
      </footer>
    </section>
  );
}
