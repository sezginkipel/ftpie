/**
 * Bookmarks.
 *
 * Two deliberate deletions from the old store:
 *
 * 1. **The empty-master-password path is gone.** It used to send
 *    `master_password: args.password ? (args.masterPassword ?? "") : null`, so
 *    every stored credential was encrypted with a key derived from `""` — the
 *    worst security bug in the app. Saving a password now simply requires an
 *    unlocked vault; if it is locked the backend rejects with `vault_locked` and
 *    the UI prompts to unlock. There is no fallback.
 * 2. **Editing is no longer delete-then-create.** That lost the bookmark
 *    outright whenever the create half failed. `update_bookmark` updates in
 *    place, and it does not accept a ciphertext blob from the frontend.
 */
import { create } from 'zustand';

import { call } from '../lib/ipc';
import type {
  Bookmark,
  BookmarkInput,
  BookmarkUpdate,
  ImportReport,
  VaultStatus,
} from '../lib/types';

interface BookmarkState {
  bookmarks: Bookmark[];
  loading: boolean;
  /** Set when `list_bookmarks` failed; render an ErrorState, not an empty list. */
  error: unknown;

  // ── Reads ──
  byId: (id: string) => Bookmark | null;
  /** Bookmarks grouped by tag, with untagged entries under `''`. */
  byTag: () => { tag: string; bookmarks: Bookmark[] }[];
  /** Case-insensitive match on name, host, username and tags. */
  search: (query: string) => Bookmark[];

  // ── Mutations ──
  load: () => Promise<void>;
  /**
   * Create a bookmark. Include `password` only when the vault is unlocked —
   * otherwise the call rejects with `vault_locked` and nothing is written.
   */
  create: (input: BookmarkInput) => Promise<Bookmark>;
  /** Update in place. Omit `password` to leave the stored secret untouched. */
  update: (update: BookmarkUpdate) => Promise<Bookmark>;
  remove: (id: string) => Promise<void>;
  /** Copy an existing bookmark. The stored password is deliberately not copied. */
  duplicate: (id: string, name: string) => Promise<Bookmark>;

  /** Returns the encrypted archive text; the passphrase is separate from the vault's. */
  exportAll: (passphrase: string) => Promise<string>;
  importArchive: (archive: string, passphrase: string) => Promise<ImportReport>;
}

/** True when this bookmark's password can be stored right now. */
export function canStorePassword(vault: VaultStatus | null): boolean {
  return Boolean(vault?.initialized && vault?.unlocked);
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: [],
  loading: false,
  error: null,

  byId(id) {
    return get().bookmarks.find((bookmark) => bookmark.id === id) ?? null;
  },

  byTag() {
    const groups = new Map<string, Bookmark[]>();
    for (const bookmark of get().bookmarks) {
      const tags = bookmark.tags.length > 0 ? bookmark.tags : [''];
      for (const tag of tags) {
        const list = groups.get(tag);
        if (list) list.push(bookmark);
        else groups.set(tag, [bookmark]);
      }
    }
    return [...groups.entries()]
      .sort(([a], [b]) => {
        // Untagged last, everything else alphabetical.
        if (a === '') return 1;
        if (b === '') return -1;
        return a.localeCompare(b);
      })
      .map(([tag, bookmarks]) => ({
        tag,
        bookmarks: [...bookmarks].sort((x, y) => x.name.localeCompare(y.name)),
      }));
  },

  search(query) {
    const needle = query.trim().toLowerCase();
    if (needle === '') return get().bookmarks;
    return get().bookmarks.filter((bookmark) =>
      [bookmark.name, bookmark.host, bookmark.username, ...bookmark.tags]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  },

  async load() {
    set({ loading: true });
    try {
      const bookmarks = await call<Bookmark[]>('list_bookmarks');
      set({ bookmarks, loading: false, error: null });
    } catch (error) {
      // Keep whatever we already had rather than blanking the sidebar, but
      // record the error so the UI can say the list may be stale.
      set({ loading: false, error });
      throw error;
    }
  },

  async create(input) {
    const created = await call<Bookmark>('create_bookmark', { input });
    set((state) => ({ bookmarks: [...state.bookmarks, created], error: null }));
    return created;
  },

  async update(update) {
    const updated = await call<Bookmark>('update_bookmark', { update });
    set((state) => ({
      bookmarks: state.bookmarks.map((bookmark) =>
        bookmark.id === updated.id ? updated : bookmark,
      ),
      error: null,
    }));
    return updated;
  },

  async remove(id) {
    await call<void>('delete_bookmark', { id });
    set((state) => ({
      bookmarks: state.bookmarks.filter((bookmark) => bookmark.id !== id),
    }));
  },

  async duplicate(id, name) {
    const source = get().byId(id);
    if (!source) {
      throw { code: 'not_found', path: id, message: `bookmark ${id} not found` };
    }
    // No password: the plaintext is not available to us, and copying the blob
    // is exactly what the frontend is no longer allowed to do.
    return get().create({
      name,
      host: source.host,
      port: source.port,
      username: source.username,
      protocol: source.protocol,
      remotePath: source.remotePath,
      localPath: source.localPath,
      privateKeyPath: source.privateKeyPath,
      passiveMode: source.passiveMode,
      tags: source.tags,
    });
  },

  async exportAll(passphrase) {
    return call<string>('export_bookmarks', { passphrase });
  },

  async importArchive(archive, passphrase) {
    const report = await call<ImportReport>('import_bookmarks', { archive, passphrase });
    // The store's own list is now stale by `report.added` entries.
    await get().load();
    return report;
  },
}));
