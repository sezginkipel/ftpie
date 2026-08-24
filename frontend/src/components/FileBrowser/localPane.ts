/**
 * The local pane's fallback state, for when nothing is connected.
 *
 * Browsing your own disk needs no server, but `sessionStore` — correctly —
 * keeps per-session paths so switching tabs restores where you were. This tiny
 * store holds the local pane's state only while there is no session to own it,
 * and {@link navigateLocalPane} writes to whichever of the two is authoritative
 * so callers outside the pane (the sidebar's drive list, for instance) do not
 * have to know which.
 */
import { create } from 'zustand';

import type { SortState } from '../../lib/types';
import { useSessionStore } from '../../store/sessionStore';

interface LocalPaneState {
  path: string;
  selection: string[];
  sort: SortState;
  setPath: (path: string) => void;
  setSelection: (paths: string[]) => void;
  setSort: (sort: SortState) => void;
}

export const useLocalPaneStore = create<LocalPaneState>((set) => ({
  path: '',
  selection: [],
  sort: { key: 'name', direction: 'asc' },

  setPath(path) {
    // Navigation clears the selection, exactly as the session store does.
    set({ path, selection: [] });
  },
  setSelection(selection) {
    set({ selection });
  },
  setSort(sort) {
    set({ sort });
  },
}));

/** Point the local pane at `path`, wherever that pane's state currently lives. */
export function navigateLocalPane(path: string): void {
  const { activeId, setLocalPath } = useSessionStore.getState();
  if (activeId) setLocalPath(activeId, path);
  else useLocalPaneStore.getState().setPath(path);
}
