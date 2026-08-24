/**
 * The file browser: two virtualized, keyboard-driven panes plus the dialogs
 * that mutate them.
 *
 * `logic.ts` and `keyboard.ts` hold every rule worth testing — sorting,
 * selection algebra, conflict detection, enqueue construction and the key map —
 * so the components stay thin.
 */
export { Panes } from './Panes';
export { FilePane, type FilePaneProps } from './FilePane';
export { FileRow, type FileRowProps } from './FileRow';
export { PathBar, type PathBarProps } from './PathBar';
export { FileContextMenu, type FileContextMenuProps } from './FileContextMenu';
export { NewFolderDialog } from './NewFolderDialog';
export { RenameDialog } from './RenameDialog';

export type { PaneEntry } from './logic';
export {
  buildEnqueueItems,
  compareEntries,
  countEntries,
  filterEntries,
  findConflicts,
  fromLocalFile,
  fromRemoteFile,
  listingQueryKey,
  policyForMode,
  sortEntries,
  toRemoteFile,
} from './logic';
export { mapGlobalKey, mapPaneKey, type GlobalAction, type PaneAction } from './keyboard';
