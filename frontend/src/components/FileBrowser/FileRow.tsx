/**
 * One row of a file pane.
 *
 * A real `role="row"` inside the pane's `role="grid"`, with `aria-selected` and
 * a stable `id` so the grid can point `aria-activedescendant` at it. The old
 * rows were clickable `<div>`s with no role, no focus and no keyboard handling.
 */
import { memo, type CSSProperties, type DragEvent, type MouseEvent } from 'react';

import { cn } from '../../lib/cn';
import { DASH, formatBytes, formatDate, formatMode, truncateMiddle } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { DateFormat, Locale } from '../../lib/types';
import { Icon, type IconName } from '../ui';
import type { PaneEntry } from './logic';

export interface FileRowProps {
  entry: PaneEntry;
  /** DOM id, referenced by the grid's `aria-activedescendant`. */
  id: string;
  selected: boolean;
  /** The keyboard cursor sits on this row. */
  active: boolean;
  locale: Locale;
  dateFormat: DateFormat;
  /** Remote listings report permissions; local ones do not. */
  showPermissions: boolean;
  /** Absolute positioning supplied by the virtualizer. */
  style: CSSProperties;
  onSelect: (entry: PaneEntry, mods: { toggle: boolean; range: boolean }) => void;
  onOpen: (entry: PaneEntry) => void;
  onDragStart: (entry: PaneEntry, event: DragEvent<HTMLDivElement>) => void;
  /** Dropping onto a folder row targets that folder rather than the pane. */
  onDropOnFolder: (entry: PaneEntry, event: DragEvent<HTMLDivElement>) => void;
}

function iconFor(entry: PaneEntry): IconName {
  if (entry.isSymlink) return 'symlink';
  if (entry.isDir) return 'folder';
  return 'file';
}

export const FileRow = memo(function FileRow({
  entry,
  id,
  selected,
  active,
  locale,
  dateFormat,
  showPermissions,
  style,
  onSelect,
  onOpen,
  onDragStart,
  onDropOnFolder,
}: FileRowProps) {
  const { t } = useT();

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    // Right-click selects before the context menu opens, so the menu always
    // acts on what the user just pointed at.
    if (event.button === 2) {
      if (!selected) onSelect(entry, { toggle: false, range: false });
      return;
    }
    if (event.button !== 0) return;
    onSelect(entry, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
  };

  const typeLabel = entry.isSymlink
    ? entry.symlinkTarget
      ? t('file.symlinkTo', { target: entry.symlinkTarget })
      : t('file.symlink')
    : entry.isDir
      ? t('file.folder')
      : t('file.file');

  return (
    <div
      id={id}
      role="row"
      aria-selected={selected}
      data-active={active ? '' : undefined}
      draggable
      style={style}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => onOpen(entry)}
      onDragStart={(event) => onDragStart(entry, event)}
      onDragOver={(event) => {
        if (!entry.isDir) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        if (!entry.isDir) return;
        event.stopPropagation();
        onDropOnFolder(entry, event);
      }}
      className={cn(
        'row absolute left-0 top-0 w-full cursor-default gap-2 px-2 transition-quick',
        selected ? 'bg-accent-weak text-text' : 'hover:bg-surface-2',
        active && 'outline outline-2 -outline-offset-2 outline-accent',
      )}
    >
      <span
        role="gridcell"
        className="flex min-w-0 flex-1 items-center gap-1.5"
        title={entry.symlinkTarget ? typeLabel : undefined}
      >
        <Icon
          name={iconFor(entry)}
          className={entry.isDir ? 'text-accent' : 'text-text-3'}
        />
        <span className="cell-truncate" title={entry.name}>
          {truncateMiddle(entry.name, 64)}
        </span>
        {entry.isSymlink ? (
          <span className="shrink-0 text-2xs uppercase tracking-wide text-text-3">
            {t('file.symlink')}
          </span>
        ) : null}
        {entry.readonly ? (
          <Icon name="lock" className="shrink-0 text-text-3" title={t('editor.readOnly')} />
        ) : null}
      </span>

      <span role="gridcell" className="w-20 shrink-0 text-right tnum text-text-2">
        {entry.isDir ? DASH : formatBytes(entry.size)}
      </span>

      <span role="gridcell" className="w-36 shrink-0 text-right tnum text-text-2">
        {formatDate(entry.modified, locale, dateFormat)}
      </span>

      {showPermissions ? (
        <span role="gridcell" className="w-24 shrink-0 font-mono text-xs text-text-3">
          {entry.permissions ? formatMode(entry.permissions) : DASH}
        </span>
      ) : null}
    </div>
  );
});
