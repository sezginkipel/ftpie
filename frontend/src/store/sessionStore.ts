import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface ActiveSession {
  id: string;
  host: string;
  protocol: string;
  username: string;
}

interface SessionState {
  sessions: ActiveSession[];
  activeSessionId: string | null;

  connect: (args: {
    host: string;
    port: number;
    username: string;
    password?: string;
    protocol: string;
  }) => Promise<string>;
  disconnect: (sessionId: string) => Promise<void>;
  setActive: (id: string) => void;
  getActive: () => ActiveSession | null;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,

  async connect(args) {
    const result = await invoke<{ session_id: string; server_welcome?: string }>(
      "connect",
      { args }
    );
    const session: ActiveSession = {
      id: result.session_id,
      host: args.host,
      protocol: args.protocol,
      username: args.username,
    };
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: result.session_id,
    }));
    return result.session_id;
  },

  async disconnect(sessionId) {
    await invoke("disconnect", { sessionId });
    set((s) => ({
      sessions: s.sessions.filter((s) => s.id !== sessionId),
      activeSessionId:
        s.activeSessionId === sessionId
          ? (s.sessions.find((ss) => ss.id !== sessionId)?.id ?? null)
          : s.activeSessionId,
    }));
  },

  setActive(id) {
    set({ activeSessionId: id });
  },

  getActive() {
    const { sessions, activeSessionId } = get();
    return sessions.find((s) => s.id === activeSessionId) ?? null;
  },
}));
