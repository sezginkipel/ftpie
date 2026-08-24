/**
 * The pane's context menu.
 *
 * One Radix menu wraps the whole grid rather than one per row: with 10k
 * virtualized rows, per-row menus would mean 10k portals. Right-clicking a row
 * selects it first (see `FileRow`), so the menu always describes the current
 * selection — and the labels say how many items it will act on.
 */
import type { ReactNode } from 'react';

import { useT } from '../../lib/i18n';
import type { PaneSide } from '../../lib/types';
import { ContextMenu, Icon, type MenuItem } from '../ui';
import type { PaneEntry } from './logic';

export interface FileContextMenuProps {
  side: PaneSide;
  /** The entries the menu acts on — the current selection. */
  targets: PaneEntry[];
  /** False for a remote pane with nothing connected. */
  enabled: boolean;
  /** True when a Ctrl+C selection is waiting to be pasted into this pane. */
  canPaste: boolean;
  onOpen: () => void;
  onOpenInEditor: () => void;
  onTransfer: () => void;
  onPaste: () => void;
  onCopyPath: () => void;
  onRename: () => void;
  onDelete: () => void;
  onNewFolder: () => void;
  onChangePermissions: () => void;
  onRefresh: () => void;
  children: ReactNode;
}

export function FileContextMenu({
  side,
  targets,
  enabled,
  canPaste,
  onOpen,
  onOpenInEditor,
  onTransfer,
  onPaste,
  onCopyPath,
  onRename,
  onDelete,
  onNewFolder,
  onChangePermissions,
  onRefresh,
  children,
}: FileContextMenuProps) {
  const { t } = useT();

  const count = targets.length;
  const single = count === 1 ? targets[0] : null;
  const editable = single !== null && !single.isDir && side === 'remote';

  const items: MenuItem[] = [
    {
      id: 'open',
      label: t('common.open'),
      icon: <Icon name="folder-open" />,
      disabled: single === null,
      onSelect: onOpen,
    },
    {
      id: 'editor',
      label: t('file.openInEditor'),
      icon: <Icon name="file-text" />,
      disabled: !editable,
      onSelect: onOpenInEditor,
    },
    { kind: 'separator', id: 'sep-transfer' },
    {
      id: 'transfer',
      label: side === 'local' ? t('file.upload') : t('file.download'),
      icon: <Icon name={side === 'local' ? 'upload' : 'download'} />,
      shortcut: 'Ctrl+↵',
      disabled: !enabled || count === 0,
      onSelect: onTransfer,
    },
    {
      id: 'paste',
      label: t('file.transferHere'),
      icon: <Icon name={side === 'local' ? 'download' : 'upload'} />,
      shortcut: 'Ctrl+V',
      disabled: !enabled || !canPaste,
      onSelect: onPaste,
    },
    { kind: 'separator', id: 'sep-edit' },
    {
      id: 'newFolder',
      label: t('file.newFolder'),
      icon: <Icon name="plus" />,
      shortcut: 'F7',
      disabled: !enabled,
      onSelect: onNewFolder,
    },
    {
      id: 'rename',
      label: t('common.rename'),
      icon: <Icon name="edit" />,
      shortcut: 'F2',
      disabled: !enabled || single === null,
      onSelect: onRename,
    },
    {
      id: 'copyPath',
      label: t('common.copyPath'),
      icon: <Icon name="copy" />,
      shortcut: 'Ctrl+C',
      disabled: count === 0,
      onSelect: onCopyPath,
    },
  ];

  if (side === 'remote') {
    items.push({
      id: 'chmod',
      label: t('file.permissionsTitle'),
      icon: <Icon name="key" />,
      disabled: !enabled || count === 0,
      onSelect: onChangePermissions,
    });
  }

  items.push(
    { kind: 'separator', id: 'sep-danger' },
    {
      id: 'refresh',
      label: t('common.refresh'),
      icon: <Icon name="refresh" />,
      shortcut: 'F5',
      disabled: !enabled,
      onSelect: onRefresh,
    },
    {
      id: 'delete',
      // The label states the count, so a menu click can never destroy more
      // than the user thinks it will.
      label:
        count === 1
          ? t('delete.confirmOne', { name: targets[0].name })
          : t('delete.confirmMany', { count }),
      icon: <Icon name="trash" />,
      shortcut: 'Del',
      danger: true,
      disabled: !enabled || count === 0,
      onSelect: onDelete,
    },
  );

  return (
    <ContextMenu
      items={items}
      label={t(side === 'local' ? 'file.local' : 'file.remote')}
      disabled={!enabled}
      /*
       * `flex flex-col` is required, not cosmetic. Radix renders the trigger as
       * its own element between this pane and the grid inside it; as a flex item
       * it is blockified, so `flex-1`/`min-h-0` size it correctly, but the grid's
       * own `flex-1` is ignored unless this element is itself a flex container.
       * Without it the listing grew to its content height and drew over the
       * pane's footer and the transfer queue below.
       */
      className="flex min-h-0 flex-1 flex-col"
    >
      {children}
    </ContextMenu>
  );
}
