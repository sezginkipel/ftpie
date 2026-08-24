/**
 * One tab per live session.
 *
 * Real tabs: `role="tablist"` with arrow-key navigation, a visible lock glyph
 * for encrypted sessions and a visible warning for plain FTP. Closing removes
 * the tab first and then tells the backend, so a dead socket cannot leave a
 * stuck tab behind (see `sessionStore.disconnect`).
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
    const delta =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
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
      className="flex min-w-0 items-stretch overflow-x-auto"
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
              'group flex min-w-0 max-w-[220px] items-center gap-1 border-r border-border px-2',
              isActive ? 'bg-surface text-text' : 'bg-surface-2 text-text-2',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className="flex min-w-0 items-center gap-1.5 py-1 text-left"
            >
              <Tooltip content={secure ? t('session.secure') : t('session.insecure')}>
                <span className={secure ? 'text-ok' : 'text-danger'}>
                  <Icon name={secure ? 'lock' : 'unlock'} />
                </span>
              </Tooltip>
              <span className="cell-truncate text-sm">
                {session.username}@{session.host}
              </span>
              {!secure ? (
                <span className="shrink-0 text-2xs uppercase tracking-wide text-danger">
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
            />
          </div>
        );
      })}
    </div>
  );
}
