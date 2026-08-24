/**
 * The toolbar above a file pane: up, breadcrumbs, an editable path, the filter
 * and the per-pane actions.
 *
 * Breadcrumbs come from `pathSegments`, which knows about Windows drive roots
 * and UNC shares, so clicking "C:\" navigates to the drive rather than to the
 * nonsense `C:` the old code produced.
 *
 * Two things make it read as a real breadcrumb rather than a label:
 *
 * - **Middle truncation.** A deep path keeps its root and its last few
 *   components and collapses the middle behind a "…" button that expands in
 *   place, instead of scrolling the interesting end out of view.
 * - **An editable state that is discoverable.** The edit button is still there,
 *   but double-clicking anywhere in the trail also opens the input — which is
 *   what every file manager does.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '../../lib/cn';
import { pathSegments } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { PaneSide } from '../../lib/types';
import { Icon, IconButton, Input, Spinner } from '../ui';

export interface PathBarProps {
  side: PaneSide;
  path: string;
  /** Null when the pane is already at a root. */
  parent: string | null;
  loading: boolean;
  filter: string;
  onFilterChange: (value: string) => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  /** Disabled for a remote pane with no session. */
  disabled?: boolean;
}

/** Above this many components the middle of the trail collapses. */
const MAX_VISIBLE_SEGMENTS = 5;
/** How many trailing components stay visible when it does. */
const TAIL_SEGMENTS = 3;

export function PathBar({
  side,
  path,
  parent,
  loading,
  filter,
  onFilterChange,
  onNavigate,
  onRefresh,
  onNewFolder,
  disabled = false,
}: PathBarProps) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the draft whenever the pane navigates elsewhere, so opening the
  // editor never shows a stale path. A new path also re-collapses the trail.
  useEffect(() => {
    setDraft(path);
    setExpanded(false);
  }, [path]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next !== '' && next !== path) onNavigate(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(path);
      setEditing(false);
    }
  };

  const segments = pathSegments(path, side === 'remote');
  const collapse = !expanded && segments.length > MAX_VISIBLE_SEGMENTS;
  const visible = collapse
    ? [segments[0], ...segments.slice(segments.length - TAIL_SEGMENTS)]
    : segments;
  const hidden = collapse ? segments.slice(1, segments.length - TAIL_SEGMENTS) : [];

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface px-1.5">
      <IconButton
        label={t('file.goUp')}
        icon={<Icon name="arrow-up" />}
        variant="ghost"
        size="sm"
        disabled={disabled || parent === null}
        onClick={() => parent && onNavigate(parent)}
        className="press"
      />

      {editing ? (
        <Input
          ref={inputRef}
          mono
          aria-label={t('path.edit')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          className="h-6 min-w-0 flex-1"
        />
      ) : (
        <nav
          aria-label={t('path.breadcrumb')}
          onDoubleClick={() => {
            if (!disabled) setEditing(true);
          }}
          title={path}
          className="flex min-w-0 flex-1 items-center whitespace-nowrap"
        >
          {segments.length === 0 ? (
            <span className="px-1 font-mono text-xs text-text-3">{t('path.root')}</span>
          ) : null}
          {visible.map((segment, index) => {
            const last = index === visible.length - 1;
            // The gap the collapse hides sits after the root segment.
            const gapAfter = collapse && index === 0;
            return (
              <span key={segment.path} className="flex min-w-0 items-center">
                {index > 0 ? <Chevron /> : null}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onNavigate(segment.path)}
                  title={segment.path}
                  aria-current={last ? 'page' : undefined}
                  className={cn(
                    'cell-truncate press max-w-[14rem] rounded-sm px-1.5 py-0.5 font-mono text-xs',
                    'transition-quick disabled:cursor-not-allowed disabled:opacity-50',
                    last
                      ? 'font-semibold text-text hover:bg-surface-2'
                      : 'text-text-2 hover:bg-surface-2 hover:text-text',
                  )}
                >
                  {segment.label}
                </button>
                {gapAfter ? (
                  <>
                    <Chevron />
                    <button
                      type="button"
                      onClick={() => setExpanded(true)}
                      aria-label={t('path.expand')}
                      title={hidden.map((item) => item.label).join(' / ')}
                      className="press rounded-sm px-1.5 py-0.5 font-mono text-xs text-text-3 transition-quick hover:bg-surface-2 hover:text-text-2"
                    >
                      …
                    </button>
                  </>
                ) : null}
              </span>
            );
          })}
        </nav>
      )}

      {loading ? <Spinner label={t('common.loading')} /> : null}

      <label className="flex shrink-0 items-center gap-1 rounded-sm">
        <span className="sr-only">{t('common.filter')}</span>
        <Icon name="search" className="text-text-3" />
        <Input
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder={t('common.filter')}
          aria-label={t('common.filter')}
          className="h-6 w-28"
        />
      </label>

      <div className="flex shrink-0 items-center gap-0.5 pl-0.5">
        <IconButton
          label={t('path.edit')}
          icon={<Icon name="edit" />}
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => setEditing(true)}
          className="press"
        />
        <IconButton
          label={t('file.newFolder')}
          icon={<Icon name="plus" />}
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onNewFolder}
          className="press"
        />
        <IconButton
          label={t('common.refresh')}
          icon={<Icon name="refresh" />}
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onRefresh}
          className="press"
        />
      </div>
    </div>
  );
}

function Chevron() {
  return <Icon name="chevron-right" className="mx-px shrink-0 text-text-3" />;
}
