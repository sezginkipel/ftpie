/**
 * The 32px toolbar above a file pane: up, breadcrumbs, an editable path, and
 * the per-pane actions.
 *
 * Breadcrumbs come from `pathSegments`, which knows about Windows drive roots
 * and UNC shares, so clicking "C:\" navigates to the drive rather than to the
 * nonsense `C:` the old code produced.
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
  const [draft, setDraft] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the draft whenever the pane navigates elsewhere, so opening the
  // editor never shows a stale path.
  useEffect(() => {
    setDraft(path);
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

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface px-1">
      <IconButton
        label={t('file.goUp')}
        icon={<Icon name="arrow-up" />}
        variant="ghost"
        size="sm"
        disabled={disabled || parent === null}
        onClick={() => parent && onNavigate(parent)}
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
          className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap"
        >
          {segments.length === 0 ? (
            <span className="px-1 font-mono text-xs text-text-3">{t('path.root')}</span>
          ) : null}
          {segments.map((segment, index) => (
            <span key={segment.path} className="flex items-center">
              {index > 0 ? (
                <Icon name="chevron-right" className="mx-0.5 shrink-0 text-text-3" />
              ) : null}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onNavigate(segment.path)}
                title={segment.path}
                className={cn(
                  'rounded px-1 font-mono text-xs transition-quick hover:bg-surface-2',
                  index === segments.length - 1 ? 'text-text' : 'text-text-2',
                )}
              >
                {segment.label}
              </button>
            </span>
          ))}
        </nav>
      )}

      {loading ? <Spinner label={t('common.loading')} /> : null}

      <label className="flex items-center gap-1">
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

      <IconButton
        label={t('path.edit')}
        icon={<Icon name="edit" />}
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => setEditing(true)}
      />
      <IconButton
        label={t('file.newFolder')}
        icon={<Icon name="plus" />}
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onNewFolder}
      />
      <IconButton
        label={t('common.refresh')}
        icon={<Icon name="refresh" />}
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onRefresh}
      />
    </div>
  );
}
