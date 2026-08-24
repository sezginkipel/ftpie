/**
 * One tab per live session.
 *
 * Real tabs: `role="tablist"` with arrow-key navigation, a visible lock glyph
 * for encrypted sessions and a visible warning for plain FTP. Closing removes
 * the tab first and then tells the backend, so a dead socket cannot leave a
 * stuck tab behind (see `sessionStore.disconnect`).
 *
 * The active tab is told apart three ways at once — it steps up to `surface`,
 * gains a 2px accent underline that lands on the title bar's own hairline, and
 * its label goes to full-strength text. The close button is always in the DOM
 * (so nothing reflows) and only becomes visible on hover, on focus, or on the
 * active tab.
 */
import { useRef, type KeyboardEvent } from 'react';

import { cn } from '../lib/cn';
import { useT } from '../lib/i18n';
import { useSessionStore } from '../store/sessionStore';
import { Icon, IconButton, Tooltip } from './ui';

export function SessionTabBar() {
  const sessions = useSessionStore((state) => state.sessions);
  const order = useSessionStore((state) => state.order);
  const activeId = useSessionStore((state) => state.activeId);
  const ui = useSessionStore((state) => state.ui);
  const closing = useSessionStore((state) => state.closing);
  const setActive = useSessionStore((state) => state.setActive);
  const disconnect = useSessionStore((state) => state.disconnect);
  const { t } = useT();

  const listRef = useRef<HTMLDivElement>(null);

  if (order.length === 0) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + order.length) % order.length;
    setActive(order[next]);
    const tabs = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs?.[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t('session.tabs')}
      className="flex min-w-0 items-stretch gap-1 overflow-x-auto px-1 pt-1"
    >
      {order.map((id, index) => {
        const session = sessions[id];
        if (!session) return null;
        const secure = ui[id]?.secure ?? session.protocol !== 'ftp';
        const isActive = id === activeId;
        const isClosing = closing.includes(id);

        return (
          <div
            key={id}
            className={cn(
              'group relative flex min-w-0 max-w-[240px] items-center gap-1 rounded-t pl-2 pr-1',
              'transition-quick',
              isActive
                ? 'bg-surface text-text shadow-e1'
                : 'bg-transparent text-text-2 hover:bg-surface-2 hover:text-text',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
            >
              {/* Protocol and encryption in one glyph: a tinted chip, so state is
                  never carried by colour alone. */}
              <Tooltip content={secure ? t('session.secure') : t('session.insecure')}>
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm',
                    secure ? 'bg-ok-weak text-ok' : 'bg-danger-weak text-danger',
                  )}
                >
                  <Icon name={secure ? 'lock' : 'unlock'} />
                </span>
              </Tooltip>
              <span className="cell-truncate text-sm">
                {session.username}@{session.host}
              </span>
              <span className="shrink-0 text-2xs uppercase tracking-wider text-text-3">
                {session.protocol}
              </span>
              {!secure ? (
                <span className="shrink-0 rounded-sm bg-danger-weak px-1 text-2xs font-semibold uppercase tracking-wider text-danger">
                  {t('status.notEncrypted')}
                </span>
              ) : null}
            </button>

            <IconButton
              label={t('session.closeTab', { host: session.host })}
              icon={<Icon name="x" />}
              size="sm"
              variant="ghost"
              loading={isClosing}
              onClick={() => void disconnect(id)}
              className={cn(
                'transition-quick',
                isActive || isClosing
                  ? 'opacity-100'
                  : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
              )}
            />

            {/* The active underline overlaps the header hairline by 1px. */}
            {isActive ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
