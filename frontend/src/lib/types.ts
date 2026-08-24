/**
 * Wire types mirroring the Rust backend exactly.
 *
 * Every backend struct is serialized with `#[serde(rename_all = "camelCase")]`
 * and every enum with `rename_all = "lowercase"` or `"snake_case"` — the casing
 * below is therefore load-bearing. Source of truth: `src-tauri/src/**`.
 *
 * Types marked "follows CONTRACT.md" mirror a backend module whose command
 * layer is still being rewritten; the lead reconciles those.
 */

// ── Errors (src-tauri/src/error.rs) ──────────────────────────────────────────

export type AppErrorCode =
  | 'untrusted_host'
  | 'vault_locked'
  | 'auth'
  | 'network'
  | 'timeout'
  | 'not_found'
  | 'permission'
  | 'conflict'
  | 'protocol'
  | 'io'
  | 'config'
  | 'cancelled'
  | 'internal';

/** Which kind of host identity failed verification. */
export type TrustKind = 'tls_certificate' | 'ssh_host_key';

/**
 * `AppError` is serialized as an internally tagged enum: `{ code, ...fields }`.
 * Discriminate on `code` to reach the variant-specific fields.
 */
export type AppError =
  | {
      code: 'untrusted_host';
      host: string;
      port: number;
      kind: TrustKind;
      algorithm: string;
      fingerprint: string;
      /** Present when a previously pinned fingerprint changed — possible MITM. */
      previousFingerprint: string | null;
      message: string;
    }
  | { code: 'vault_locked'; message: string }
  | { code: 'auth'; message: string }
  | { code: 'network'; message: string }
  | { code: 'timeout'; message: string }
  | { code: 'not_found'; path: string; message: string }
  | { code: 'permission'; message: string }
  | { code: 'conflict'; message: string; remoteHash: string | null }
  | { code: 'protocol'; message: string }
  | { code: 'io'; message: string }
  | { code: 'config'; message: string }
  | { code: 'cancelled'; message: string }
  | { code: 'internal'; message: string };

// ── Connection (src-tauri/src/ftp/mod.rs, commands/connection.rs) ────────────

export type Protocol = 'ftp' | 'ftps' | 'ftps_implicit' | 'sftp';

export const PROTOCOLS: readonly Protocol[] = ['ftp', 'ftps', 'ftps_implicit', 'sftp'];

/** Mirrors `Protocol::default_port`. */
export function defaultPort(protocol: Protocol): number {
  switch (protocol) {
    case 'ftps_implicit':
      return 990;
    case 'sftp':
      return 22;
    case 'ftp':
    case 'ftps':
      return 21;
  }
}

/** Mirrors `Protocol::is_secure` — only plain FTP is unencrypted. */
export function isSecureProtocol(protocol: Protocol): boolean {
  return protocol !== 'ftp';
}

/** Arguments of the `connect` command (`ConnectArgs`). */
export interface ConnectArgs {
  host: string;
  port?: number | null;
  username: string;
  password?: string | null;
  protocol: Protocol;
  passiveMode?: boolean | null;
  privateKeyPath?: string | null;
  keyPassphrase?: string | null;
  connectTimeoutSecs?: number | null;
  ioTimeoutSecs?: number | null;
}

/** `SessionMeta` — cached session identity. */
export interface SessionMeta {
  id: string;
  host: string;
  port: number;
  username: string;
  protocol: Protocol;
}

export interface ConnectResult {
  session: SessionMeta;
  /** True when traffic is encrypted; the UI warns when it is not. */
  secure: boolean;
}

// ── Files (src-tauri/src/ftp/types.rs, commands/files.rs) ────────────────────

export interface RemoteFile {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  isSymlink: boolean;
  symlinkTarget: string | null;
  /** Human form, e.g. "rwxr-xr-x" or "755". */
  permissions: string | null;
  /** Numeric mode when the server reports one, so chmod can round-trip. */
  mode: number | null;
  /** RFC 3339 timestamp, or null when the server did not report one. */
  modified: string | null;
  owner: string | null;
  group: string | null;
}

export interface LocalFile {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  isSymlink: boolean;
  isHidden: boolean;
  readonly: boolean;
  modified: string | null;
}

export interface LocalListing {
  /** Canonical form of the directory that was actually read. */
  path: string;
  parent: string | null;
  entries: LocalFile[];
}

export interface DriveInfo {
  path: string;
  label: string;
}

/** Arguments of `delete_remote` (`DeleteRemoteArgs`). */
export interface DeleteRemoteArgs {
  sessionId: string;
  path: string;
  isDir?: boolean;
  /** Required to remove a non-empty directory; the UI must confirm first. */
  recursive?: boolean;
}

/** Arguments of `delete_local` (`DeleteLocalArgs`). */
export interface DeleteLocalArgs {
  path: string;
  recursive?: boolean;
}

// ── Transfers (src-tauri/src/transfer/mod.rs) ────────────────────────────────

export type TransferDirection = 'upload' | 'download';

export type TransferStatus =
  | 'queued'
  | 'active'
  | 'paused'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'skipped';

export const TERMINAL_TRANSFER_STATUSES: readonly TransferStatus[] = [
  'done',
  'error',
  'cancelled',
  'skipped',
];

export function isTerminalStatus(s: TransferStatus): boolean {
  return TERMINAL_TRANSFER_STATUSES.includes(s);
}

/**
 * What to do when the destination exists. Deliberately has no `ask`: the
 * frontend resolves prompts before enqueueing so the backend never blocks a
 * worker on the UI.
 */
export type ConflictPolicy = 'overwrite' | 'skip' | 'rename';

export interface TransferItem {
  id: string;
  sessionId: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  fileName: string;
  bytesDone: number;
  /** 0 means the size was not known up front. */
  bytesTotal: number;
  speedBps: number;
  etaSecs: number | null;
  status: TransferStatus;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * The throttled progress payload the backend emits on `transfer:update` while
 * bytes are moving. It is a strict subset of `TransferItem` and must be merged
 * into the existing row, never used to replace it.
 */
export interface TransferProgressPatch {
  id: string;
  bytesDone: number;
  bytesTotal: number;
  speedBps: number;
  etaSecs: number | null;
  status: 'active';
  partial: true;
}

/** Either a full item or a throttled patch — whatever `transfer:update` carries. */
export type TransferUpdatePayload = TransferItem | TransferProgressPatch;

export function isProgressPatch(p: TransferUpdatePayload): p is TransferProgressPatch {
  return (p as TransferProgressPatch).partial === true;
}

export interface EnqueueItem {
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  /** Directories are expanded backend-side with symlink and depth guards. */
  isDir: boolean;
  onConflict: ConflictPolicy;
}

export interface EnqueueRequest {
  sessionId: string;
  items: EnqueueItem[];
  maxConcurrent?: number | null;
}

/** Payload of the `transfer:removed` event. */
export interface TransferRemovedEvent {
  id: string;
}

// ── Editor (src-tauri/src/commands/editor.rs) ────────────────────────────────

export interface OpenedFile {
  /** UTF-8 text, or base64 when `isBinary` is set. */
  content: string;
  isBinary: boolean;
  /** SHA-256 hex of the raw bytes, used for optimistic concurrency on save. */
  hash: string;
  size: number;
  encoding: string;
}

export interface SaveResult {
  hash: string;
  bytes: number;
}

/** Arguments of `editor_save_file` (`SaveArgs`). */
export interface SaveArgs {
  sessionId: string;
  remotePath: string;
  content: string;
  isBinary?: boolean;
  /** When present, the save is refused if the remote copy changed. */
  expectedHash?: string | null;
}

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  op: DiffOp;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  insertions: number;
  deletions: number;
}

// ── Trust (src-tauri/src/trust/mod.rs) ───────────────────────────────────────

export interface TrustEntry {
  host: string;
  port: number;
  kind: TrustKind;
  /** e.g. "ssh-ed25519", or the certificate subject for TLS. */
  algorithm: string;
  /** Canonical "SHA256:<base64-unpadded>" form. */
  fingerprint: string;
  addedAt: string;
}

// ── Vault (src-tauri/src/vault/mod.rs) ───────────────────────────────────────

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
}

/**
 * Versioned AES-256-GCM blob. The frontend never constructs, reads or sends
 * one — it only ever observes `Bookmark.encryptedPassword` being present.
 */
export interface EncryptedBlob {
  v: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

// ── Bookmarks (src-tauri/src/bookmarks/mod.rs, commands/bookmarks.rs) ────────

export interface Bookmark {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: Protocol;
  remotePath: string;
  localPath: string | null;
  /** SFTP private key, when this bookmark authenticates with a key. */
  privateKeyPath: string | null;
  /** `null` means "use the default (passive)". */
  passiveMode: boolean | null;
  tags: string[];
  createdAt: string;
  /**
   * Vault-encrypted password, present only when a secret is stored. **Read-only
   * to the frontend** — never send it back; `create_bookmark`/`update_bookmark`
   * take a plaintext `password` and encrypt server-side.
   */
  encryptedPassword?: EncryptedBlob | null;
}

/** True when the bookmark has a stored password we would need the vault for. */
export function hasStoredPassword(b: Bookmark): boolean {
  return b.encryptedPassword !== null && b.encryptedPassword !== undefined;
}

/** `BookmarkInput` — the payload of `create_bookmark` (`{ input }`). */
export interface BookmarkInput {
  name: string;
  host: string;
  /** Omitted defaults to the protocol's port. */
  port?: number | null;
  username: string;
  /** Plaintext. Requires an unlocked vault; encrypted and never echoed back. */
  password?: string | null;
  protocol: Protocol;
  remotePath?: string | null;
  localPath?: string | null;
  privateKeyPath?: string | null;
  passiveMode?: boolean | null;
  tags?: string[];
}

/**
 * `BookmarkUpdate` — the payload of `update_bookmark` (`{ update }`). The input
 * fields are flattened alongside `id`, so send them at the top level.
 */
export interface BookmarkUpdate extends BookmarkInput {
  id: string;
  /**
   * `true` removes the stored password. Omitting both this and `password`
   * leaves the existing secret untouched.
   */
  clearPassword?: boolean;
}

/** `ImportReport` — outcome of `import_bookmarks`. */
export interface ImportReport {
  /** Entries appended to the store. */
  added: number;
  /** Entries recognised as already present and left alone. */
  skipped: number;
  /** How many added entries needed a fresh id because of a collision. */
  idsRegenerated: number;
}

// ── Git and deploy (src-tauri/src/git/mod.rs, commands/git.rs) ───────────────

export type GitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'typechange'
  | 'untracked';

export interface ChangedFile {
  path: string;
  status: GitFileStatus;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  /** RFC 3339, UTC. */
  timestamp: string;
}

export interface GitStatus {
  /** Branch shorthand, "HEAD" when detached, or null on an unborn HEAD. */
  branch: string | null;
  upstream: string | null;
  /** `null` means there is no upstream — render "no upstream", never `0`. */
  ahead: number | null;
  behind: number | null;
  changedFiles: ChangedFile[];
  isDirty: boolean;
  detached: boolean;
  lastCommit: CommitInfo | null;
}

/** Where an upload's bytes come from. `worktree` is not reproducible. */
export type UploadSource = 'tree' | 'worktree';

export interface PlannedUpload {
  /** Repo-relative path, forward slashes. */
  path: string;
  remotePath: string;
  source: UploadSource;
  /** Blob hash for tree-sourced uploads; null for worktree files. */
  blobSha: string | null;
  size: number;
  /** Why this file is in the plan. */
  reason: GitFileStatus;
}

export interface PlannedDelete {
  path: string;
  remotePath: string;
  /** `deleted` for a removed file, `renamed` for the old side of a rename. */
  reason: GitFileStatus;
}

export type SkipReason = 'excluded' | 'symlink' | 'submodule';

export interface SkippedEntry {
  path: string;
  reason: SkipReason;
}

/** A complete, side-effect-free description of a deploy. */
export interface DeployPlan {
  /** The revision as requested (branch/tag/commit-ish). */
  rev: string;
  branch: string;
  commitSha: string;
  commit: CommitInfo | null;
  /** Diff base, or null for a full-tree deploy. */
  baseCommitSha: string | null;
  remoteBasePath: string;
  includeUncommitted: boolean;
  uploads: PlannedUpload[];
  deletes: PlannedDelete[];
  skipped: SkippedEntry[];
  totalBytes: number;
}

export type DeployPhase = 'scanning' | 'uploading' | 'deleting' | 'finished';
export type DeployAction = 'upload' | 'delete';
export type OutcomeStatus = 'done' | 'failed' | 'skipped';

/** Payload of the `deploy:progress` event, emitted on the main window. */
export interface DeployProgress {
  deployId: string;
  phase: DeployPhase;
  /** 1-based index of the operation being reported; 0 while scanning. */
  current: number;
  /** Total planned operations (uploads + deletes); 0 while scanning. */
  total: number;
  path: string;
  remotePath: string;
  /** Bytes transferred so far across the whole deploy. */
  bytes: number;
}

export interface FileOutcome {
  path: string;
  remotePath: string;
  action: DeployAction;
  status: OutcomeStatus;
  bytes: number;
  error: string | null;
}

export interface DeployOutcome {
  deployId: string;
  dryRun: boolean;
  /** The full plan — for a dry run this *is* the result the UI shows. */
  plan: DeployPlan;
  uploaded: number;
  deleted: number;
  failed: number;
  skipped: number;
  bytes: number;
  durationMs: number;
  cancelled: boolean;
  success: boolean;
  files: FileOutcome[];
  /** Id of the deploy-history record; absent for dry runs. */
  recordId: string | null;
}

/** `DeployArgs` — the payload of `deploy_branch` (`{ args }`). */
export interface DeployArgs {
  sessionId: string;
  repoPath: string;
  remoteBasePath: string;
  /** Branch, tag, or commit-ish. Defaults to `HEAD`. */
  rev?: string | null;
  /** Explicit diff base; falls back to deploy history when `useHistoryBase`. */
  baseRev?: string | null;
  useHistoryBase?: boolean;
  /** Real glob patterns (globset); an invalid pattern is a `config` error. */
  excludePatterns?: string[];
  /** Off by default: deploys should be reproducible from a commit. */
  includeUncommitted?: boolean;
  /** Build and return the plan without contacting the server. */
  dryRun?: boolean;
  /** Caller-supplied id so `cancel_deploy` can target this run. */
  deployId?: string | null;
}

/** Arguments of `rollback_deploy` — flat, not wrapped. */
export interface RollbackArgs {
  recordId: string;
  sessionId?: string | null;
  repoPath?: string | null;
  excludePatterns?: string[] | null;
  /** Plan against the whole commit tree instead of the recorded diff. */
  fullTree?: boolean | null;
  /** Required to roll back a deploy that included uncommitted changes. */
  force?: boolean | null;
  dryRun?: boolean | null;
  deployId?: string | null;
}

export interface DeployRecord {
  id: string;
  timestamp: string;
  serverHost: string;
  serverUser: string;
  protocol: Protocol;
  repoPath: string;
  remoteBasePath: string;
  branch: string;
  commitSha: string;
  filesUploaded: string[];
  filesDeleted: string[];
  bytes: number;
  durationMs: number;
  success: boolean;
  error: string | null;
}

// ── Scripting (src-tauri/src/scripting/mod.rs, commands/scripting.rs) ────────

export interface Script {
  id: string;
  name: string;
  description: string;
  source: string;
  createdAt: string;
  lastRun: string | null;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface ScriptLog {
  timestamp: string;
  level: LogLevel;
  message: string;
}

/** Result of `run_script`. */
export interface ScriptRun {
  logs: ScriptLog[];
  /** Display form of the script's final expression. */
  result: string;
  durationMs: number;
}

/** `SaveScriptArgs` — the payload of `save_script` (`{ args }`). */
export interface SaveScriptArgs {
  /** Absent for a new script. */
  id?: string | null;
  name: string;
  description?: string;
  source: string;
}

/**
 * `RunScriptArgs` — the payload of `run_script` (`{ args }`). The frontend
 * generates `runId` so a run can be cancelled while it is still going.
 */
export interface RunScriptArgs {
  /** Session the script's remote calls act on; omit for workspace-only scripts. */
  sessionId?: string | null;
  /** Run a stored script by id, or... */
  scriptId?: string | null;
  /** ...run an unsaved buffer directly. */
  source?: string | null;
  runId: string;
}

/** Host functions available to a Rhai script, for the reference panel. */
export const SCRIPT_HOST_FUNCTIONS: readonly string[] = [
  'ftp_list(path)',
  'ftp_download(remote, local)',
  'ftp_upload(local, remote)',
  'ftp_mkdir(path)',
  'ftp_delete(path)',
  'log(message)',
  'read_file(path)',
  'write_file(path, content)',
];

// ── AI (src-tauri/src/ai/mod.rs, commands/ai.rs) ─────────────────────────────

export type AiProvider = 'anthropic' | 'openai' | 'ollama' | 'custom';

export const AI_PROVIDERS: readonly AiProvider[] = [
  'anthropic',
  'openai',
  'ollama',
  'custom',
];

/**
 * Externally tagged on `type`. There is no script-execution and no file-upload
 * action — never add UI implying arbitrary execution.
 */
export type AiAction =
  | { type: 'rename_file'; from: string; to: string; reason: string }
  | { type: 'move_file'; from: string; to: string; reason: string }
  | { type: 'delete_file'; path: string; reason: string }
  | { type: 'create_directory'; path: string; reason: string }
  | { type: 'change_permissions'; path: string; mode: string; reason: string };

export interface AiActionProposal {
  action: AiAction;
  /** Generated in Rust, never taken from the model. Render as plain text. */
  description: string;
  /** True for anything that loses data or widens access. */
  destructive: boolean;
}

export interface AiResponse {
  /** Untrusted model output. Render as plain text, never as HTML. */
  message: string;
  actions: AiActionProposal[];
  /** Proposals discarded as malformed or refused by this build. Warn about these. */
  rejectedActions: number;
}

/** Ambient context attached to a query. Every field is untrusted. */
export interface AiContextArgs {
  remotePath?: string | null;
  localPath?: string | null;
  selectedFiles?: string[];
  gitBranch?: string | null;
  fileListing?: string[] | null;
}

/**
 * `AiQueryArgs` — the payload of `ai_query` (`{ args }`). There is deliberately
 * **no `apiKey` field**: keys live in the vault via `ai_set_key`.
 */
export interface AiQueryArgs {
  prompt: string;
  provider: AiProvider;
  model?: string | null;
  /** Only meaningful for `custom` (or a relocated Ollama). Validated backend-side. */
  baseUrl?: string | null;
  context?: AiContextArgs | null;
}

/** One entry of `ai_list_providers`. Never carries key material. */
export interface AiProviderInfo {
  provider: AiProvider;
  /** Whether a key blob exists — not the key. */
  hasKey: boolean;
  requiresKey: boolean;
  acceptsKey: boolean;
  defaultModel: string;
  /** True when the caller must also supply a validated base URL. */
  needsBaseUrl: boolean;
}

// ── App (src-tauri/src/commands/app.rs) ──────────────────────────────────────

export interface AppInfo {
  name: string;
  version: string;
  /** Where bookmarks, the vault verifier and known_hosts live. */
  configDir: string;
}

// ── UI-level types (not wire types, but shared widely) ───────────────────────

/** Interface language. Default `tr`. */
export type Locale = 'tr' | 'en';

export type ThemePreference = 'system' | 'light' | 'dark';

/** How timestamps are rendered in file lists and history. */
export type DateFormat = 'relative' | 'short' | 'iso';

/**
 * Overwrite behaviour chosen in Settings. `ask` exists only here: the frontend
 * resolves it into a concrete {@link ConflictPolicy} before enqueueing.
 */
export type OverwriteMode = 'ask' | ConflictPolicy;

/** What double-clicking (or pressing Enter on) a file does. */
export type DoubleClickAction = 'open' | 'download';

/** Which pane a file list belongs to. */
export type PaneSide = 'local' | 'remote';

/** Sortable file-list columns. */
export type SortKey = 'name' | 'size' | 'modified' | 'permissions';

export interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}
