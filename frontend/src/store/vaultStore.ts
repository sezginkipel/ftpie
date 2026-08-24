/**
 * Credential-vault status.
 *
 * Kept in its own store because three unrelated places need it: the status bar
 * (locked/unlocked indicator), the vault dialog (initialize vs unlock), and any
 * flow that wants to store a password. The master password itself is **never**
 * held here — it goes straight to the backend and is forgotten.
 */
import { create } from 'zustand';

import { call } from '../lib/ipc';
import type { VaultStatus } from '../lib/types';

interface VaultState {
  status: VaultStatus | null;
  /** True while an Argon2id operation is running (they are deliberately slow). */
  busy: boolean;
  error: unknown;

  /** True only when a secret can be encrypted right now. */
  canStoreSecrets: () => boolean;

  refresh: () => Promise<VaultStatus>;
  /** First-run setup. Rejects if the vault already exists. */
  initialize: (masterPassword: string) => Promise<VaultStatus>;
  unlock: (masterPassword: string) => Promise<VaultStatus>;
  lock: () => Promise<VaultStatus>;
  /** Re-keys every stored secret in one step. */
  changePassword: (oldPassword: string, newPassword: string) => Promise<VaultStatus>;
}

export const useVaultStore = create<VaultState>((set, get) => ({
  status: null,
  busy: false,
  error: null,

  canStoreSecrets() {
    const status = get().status;
    return Boolean(status?.initialized && status.unlocked);
  },

  async refresh() {
    const status = await call<VaultStatus>('vault_status');
    set({ status, error: null });
    return status;
  },

  async initialize(masterPassword) {
    return run(set, () => call<VaultStatus>('vault_initialize', { masterPassword }));
  },

  async unlock(masterPassword) {
    return run(set, () => call<VaultStatus>('vault_unlock', { masterPassword }));
  },

  async lock() {
    return run(set, () => call<VaultStatus>('vault_lock'));
  },

  async changePassword(oldPassword, newPassword) {
    return run(set, () =>
      call<VaultStatus>('vault_change_password', { oldPassword, newPassword }),
    );
  },
}));

type SetState = (partial: Partial<VaultState>) => void;

/** Run a vault command with the busy flag and error field maintained. */
async function run(
  set: SetState,
  action: () => Promise<VaultStatus>,
): Promise<VaultStatus> {
  set({ busy: true, error: null });
  try {
    const status = await action();
    set({ status, busy: false, error: null });
    return status;
  } catch (error) {
    set({ busy: false, error });
    throw error;
  }
}
