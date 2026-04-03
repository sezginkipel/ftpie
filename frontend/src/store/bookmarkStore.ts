import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface Bookmark {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: string;
  remote_path: string;
  local_path?: string;
  tags: string[];
  created_at: string;
}

interface BookmarkState {
  bookmarks: Bookmark[];
  loading: boolean;

  load: () => Promise<void>;
  create: (args: {
    name: string;
    host: string;
    port: number;
    username: string;
    password?: string;
    masterPassword?: string;
    protocol: string;
    remotePath?: string;
    localPath?: string;
    tags?: string[];
  }) => Promise<Bookmark>;
  update: (bookmark: Bookmark) => Promise<void>;
  delete: (id: string) => Promise<void>;
  connectBookmark: (id: string, masterPassword: string) => Promise<string>;
  exportEncrypted: (masterPassword: string) => Promise<string>;
  importEncrypted: (json: string, masterPassword: string) => Promise<number>;
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: [],
  loading: false,

  async load() {
    set({ loading: true });
    try {
      const bookmarks = await invoke<Bookmark[]>("list_bookmarks");
      set({ bookmarks });
    } finally {
      set({ loading: false });
    }
  },

  async create(args) {
    const bm = await invoke<Bookmark>("create_bookmark", {
      args: {
        name: args.name,
        host: args.host,
        port: args.port,
        username: args.username,
        password: args.password,
        master_password: args.masterPassword,
        protocol: args.protocol,
        remote_path: args.remotePath,
        local_path: args.localPath,
        tags: args.tags,
      },
    });
    set((s) => ({ bookmarks: [...s.bookmarks, bm] }));
    return bm;
  },

  async update(bookmark) {
    await invoke("update_bookmark", { bookmark });
    set((s) => ({
      bookmarks: s.bookmarks.map((b) => (b.id === bookmark.id ? bookmark : b)),
    }));
  },

  async delete(id) {
    await invoke("delete_bookmark", { id });
    set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
  },

  async connectBookmark(id, masterPassword) {
    return invoke<string>("connect_bookmark", { id, masterPassword });
  },

  async exportEncrypted(masterPassword) {
    return invoke<string>("export_bookmarks", { masterPassword });
  },

  async importEncrypted(json, masterPassword) {
    const count = await invoke<number>("import_bookmarks", {
      encryptedJson: json,
      masterPassword,
    });
    await get().load();
    return count;
  },
}));
