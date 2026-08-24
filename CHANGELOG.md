# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Signed auto-updater.** ftpie now checks
  `releases/latest/download/latest.json` once at startup and, when a newer
  release exists, shows a notice with the version, the release notes, a download
  progress bar, and Install / Later actions. Two commands back it:
  `update_check` (returns `null` when already up to date) and `update_install`
  (downloads, verifies, installs, relaunches). Download progress is emitted as
  `update:progress` with `{ downloaded, total }`.
- Updater bundles are signed: `bundle.createUpdaterArtifacts` is enabled and
  `.github/workflows/release.yml` signs every artifact with
  `TAURI_SIGNING_PRIVATE_KEY` and publishes the merged `latest.json` manifest,
  with a `verify-manifest` job that fails the release if either is missing.
- `rust-toolchain.toml` pins the Rust toolchain (`1.98.0`, with `rustfmt` and
  `clippy`) so a local build and CI cannot resolve different compilers. A
  toolchain five releases behind had been passing lints that CI rejected.
  Bumping the pin is a deliberate PR; see the README's contributing section.
- `.github/dependabot.yml` covering all four ecosystems in the repository —
  cargo (workspace root, where `Cargo.lock` lives), npm in `frontend`, npm in
  `web`, and GitHub Actions. Weekly, with minor and patch updates grouped per
  ecosystem and open-PR limits, so it is one reviewable PR rather than a stream.

### Changed

- `list_bookmarks`, `create_bookmark` and `update_bookmark` now return a
  `BookmarkView` instead of a `Bookmark`. The wire shape drops
  `encryptedPassword` and gains a derived `hasPassword: boolean`;
  `Bookmark.encryptedPassword` still exists and still serializes to
  `bookmarks.json`, so the on-disk format and the encrypted export/import
  archives are unchanged. Frontend consumers use `hasStoredPassword(bookmark)`
  exactly as before.

### Fixed

- **An interrupted master-password change can no longer strand the stored
  secrets.** `Vault::change_password` now rolls *forward*: it publishes the new
  key as `vault.json`'s primary verifier — retaining the previous one as a
  `fallback` entry — *before* re-encrypting anything, and drops the fallback only
  after the re-key succeeded. The invariant is that the file always verifies
  every key any secret could currently be under, so no single failure can make a
  secret unreadable. Previously a failed verifier write followed by a failed
  rollback re-key left the secrets under a key that existed nowhere on disk, and
  the error told the user to "re-enter the new password to recover" — which
  `derive_and_verify` could not honour, because it only ever checked the old
  on-disk verifier. Every error message on these paths now names the password
  that actually works. A `vault.json` from an earlier version loads unchanged,
  and one written by a clean change carries no `fallback` field.

### Security

- **Credential ciphertext no longer crosses the IPC boundary.** `list_bookmarks`
  used to hand the webview each stored password's ciphertext, salt and nonce,
  and revealed which bookmarks held a secret even while the vault was locked.
  The renderer only ever needed the boolean, so it now receives only
  `hasPassword`.
- **The script workspace refuses to traverse symlinks.** `Workspace::resolve`
  canonicalized the deepest *existing* ancestor, but `Path::exists()` follows
  links, so a **dangling** symlink planted inside the workspace counted as
  non-existent, survived into the unresolved tail, and `write_file` then created
  its target outside the root. Every component is now checked with
  `symlink_metadata` and any symlink is refused outright — a link's target can
  be swapped between the check and the write, so there is nothing about it worth
  trusting, and a script sandbox has no need to follow one. Planting the link
  requires another process, so this was defence in depth.
- The updater verifies each downloaded artifact's minisign signature against the
  public key pinned in `tauri.conf.json` before installing; verification
  failures are surfaced as errors rather than ignored. **Nothing is ever
  installed automatically** — checking may happen on startup, installing is
  always an explicit user action.
- The new capabilities are the narrowest that work: `updater:default` plus
  `process:allow-restart`. `process:allow-exit` is deliberately not granted.

## [0.1.0] — 2026-08-24

First tagged release. This is a security, correctness, and packaging hardening
pass over the initial prototype: several features that could not be made safe
were removed rather than patched.

### Added

- **Trust-on-first-use host verification** for both SSH host keys and TLS
  certificates, persisted in `known_hosts.json`. A changed fingerprint is
  surfaced as an explicit MITM warning and refuses the connection.
- **Encrypted credential vault** (AES-256-GCM, Argon2id KDF, key zeroized on
  lock) with master-password initialize/unlock/lock/change. AI provider API keys
  moved into the vault.
- **Implicit FTPS** (port 990) as a first-class protocol, using a dedicated TLS
  path rather than reusing explicit `AUTH TLS`.
- **SFTP public-key authentication**, honouring an encrypted private key and
  passphrase, with a clear error naming which auth method failed.
- **Transfer queue control**: pause, resume, cancel, configurable concurrency,
  per-item speed and ETA, and `transfer:update` / `transfer:removed` events.
- **Deploy history and rollback** (`list_deploy_history`, `rollback_deploy`) plus
  live `deploy:progress` events.
- **Save-conflict detection** in the remote editor: content hashes are compared
  and a real LCS-based line diff is offered when the remote file changed.
- Recursive remote `mkdir_all`, remote `SIZE` lookups for accurate progress
  totals, keepalive/NOOP, and graceful session shutdown.
- Structured errors: every command returns a typed error carrying a
  machine-readable `code` the frontend maps to localized messages.
- Complete multi-platform **icon set** (`32x32`, `128x128`, `128x128@2x`,
  `.icns`, `.ico`, Windows Store logos) generated from a new 1024×1024 source
  mark. macOS and Linux bundling previously could not complete.
- **`LICENSE`** with the full Apache-2.0 text. `Cargo.toml` declared Apache-2.0
  but the file was missing, leaving the grant legally incomplete.
- `README.md`, `SECURITY.md`, `CHANGELOG.md`, `.editorconfig`, `.env.example`.
- **CI** (`.github/workflows/ci.yml`): `cargo fmt --check`, `cargo clippy -D
  warnings`, `cargo test` on windows-latest (MSVC) and ubuntu-latest, plus
  frontend lint/typecheck/build, with cargo and npm caching and a config-sanity
  job that validates the Tauri JSON and every declared bundle icon.
- **Release workflow** (`.github/workflows/release.yml`) building per-OS bundles
  on `v*` tags via `tauri-apps/tauri-action`, with documented placeholders for
  Windows code-signing, macOS notarization, and updater-signing secrets.
- Lint/format configuration: `rustfmt.toml`, `clippy.toml`,
  `frontend/eslint.config.js` (ESLint 9 flat config for React 19 + TypeScript
  with react-hooks rules), `frontend/.prettierrc`. The `lint` script previously
  could not run — there was no config at all.
- `.cargo/config.toml.example` documenting the portable build recipe.

### Changed

- **Restrictive CSP** replaces `"csp": null` in `tauri.conf.json`:
  `default-src 'self'`, `object-src 'none'`, `form-action 'none'`, no remote
  script sources, `style-src` permitting Monaco's injected styles, `connect-src`
  limited to Tauri IPC plus HTTPS for AI providers.
- `withGlobalTauri` set to `false` — the frontend uses the npm API.
- **Minimum-privilege Tauri v2 capability** (`src-tauri/capabilities/default.json`):
  `core:default`, `core:event:default`, `dialog:allow-open`, `dialog:allow-save`,
  `notification:default`, scoped to the `main` window. No `plugin-fs` or
  `plugin-shell` JS permissions — all file IO goes through Rust commands.
- Shell plugin `open` narrowed from `true` to a `^https?://` regex validator.
- **Real TLS certificate verification** for FTPS. Self-signed servers are
  supported only by pinning the exact certificate the user explicitly trusted;
  invalid certificates are never blanket-accepted.
- **Streaming transfers** in both directions, 64 KiB chunks, with cancellation
  checked every chunk. Downloads write to `.part` and rename on success. No
  transfer path buffers a whole file in memory any more.
- **Atomic, non-destructive persistence** for every JSON store: temp file +
  fsync + rename. A store that fails to parse is backed up as
  `<name>.corrupt-<timestamp>` and marked read-only instead of being silently
  replaced with defaults.
- Directory listings now try `MLSD` first and fall back to a parser handling both
  Unix `ls -l` and DOS/IIS formats. Modification times, numeric modes, and
  symlink targets are actually parsed. An unrecognised format is reported rather
  than returning an empty listing.
- Socket read/write timeouts and connect timeouts are applied from the
  connection config; SFTP sets `inactivity_timeout` and `keepalive_interval` so
  dead connections are detected.
- **Rhai sandbox tightened**: operation, call-depth, string, array, and map
  limits; `env()` removed; `read_file`/`write_file` confined to a canonicalized
  workspace root; cooperative cancellation via `on_progress`.
- AI providers are a closed enum. A `custom` provider requires an explicit
  `base_url` that must be HTTPS (or HTTP only for loopback); an unknown provider
  string is no longer treated as a base URL. All provider calls have request and
  connect timeouts and check HTTP status before parsing.
- Deploy now uses real glob excludes, propagates deletions and renames, creates
  remote parent directories recursively, computes ahead/behind from the real git
  graph, and deploys from a committed tree unless uncommitted changes are opted
  in.
- `.cargo/config.toml` is no longer committed. The portable template lives in
  `.cargo/config.toml.example`; MinGW toolchain overrides are scoped to
  `x86_64-pc-windows-gnu` so they cannot break an MSVC build.
- `x86_64-pc-windows-msvc` documented as the recommended production target
  (required for MSI/NSIS bundling and code signing); MinGW is a fallback.
- Bundle metadata added (publisher, descriptions, category, license file).

### Project

- Added `web/`, the product site at <https://ftpie.sadelabs.site>.
- Removed `docs/development-report.md`. It was a Turkish-language design document
  that predated the implementation and promised WebDAV, S3, live collaboration, a
  plugin system and cloud sync — none of which exist. Everything in it that is
  actually true now lives in this changelog and the README, so keeping a
  superseded document around only invited people to believe it.
- The interface now starts in English, with Turkish available in Settings. It
  previously defaulted to Turkish, which made no sense for a public project.

### Removed

- **Real-time collaboration**: the `collaboration` module, its commands, and all
  associated state. The `tokio-tungstenite` dependency goes with it.
- **Built-in SSH terminal** (`open_ssh_terminal`) and its handle registry,
  including a `mem::forget` that leaked the session.
- **WebDAV and S3 protocol variants** — both silently fell through to plaintext
  FTP, so a user selecting "WebDAV" got an unencrypted FTP connection.
- The AI `RunScript` action, a prompt-injection-to-RCE path.
- The empty-master-password code path in the vault. There is no unauthenticated
  encryption mode.
- `.lock().unwrap()` throughout, replaced by poison-tolerant helpers.
- `load_or_default()` helpers that masked corrupt-state-file errors.
- `[profile.dev] overflow-checks = false` from the root `Cargo.toml`. It existed
  only to paper over a stack-size workaround; overflow checks are a correctness
  net, not a build knob.
- `frontend/node_modules`, `frontend/dist`, `src-tauri/gen/schemas`, and
  `.claude/settings.local.json` untracked from git (~6,985 files). The
  `.gitignore` now covers build output, dependencies, `.env*`, logs, OS junk, and
  local target directories.

### Fixed

- **MinGW link failure** root cause identified: the checkout path contains a
  space, which GCC's `collect2` fails to quote when passing object paths to the
  linker. The fix is a space-free `CARGO_TARGET_DIR` / `build.target-dir`, now
  documented in the README and the cargo config example. Previous workarounds
  (raising the PE stack reservation, disabling overflow checks) addressed the
  wrong problem.
- `CARGO_TARGET_DIR` declared in a cargo `[env]` block had no effect — cargo
  resolves its target directory before applying `[env]`. Replaced with
  `build.target-dir`.
- `update_bookmark` no longer accepts an `encrypted_password` blob from the
  frontend; it takes plaintext and re-encrypts server-side, or leaves the stored
  blob untouched.
- Session identity no longer reports a hardcoded protocol string; deploy history
  records the real host and user.
- `ahead`/`behind` git counts were hardcoded to `0`.
- **The test suite could not run at all on Windows.** Test binaries died at
  startup with `STATUS_ENTRYPOINT_NOT_FOUND` (`0xC0000139`) on both MSVC and
  MinGW, before a single test executed: Tauri's window layer imports comctl32
  **v6** symbols, the app binary gets a v6 manifest from `tauri-build`, but
  `cargo test` binaries get none and so load the legacy comctl32 5.82. Fixed for
  MSVC by declaring `/MANIFESTDEPENDENCY` for Common-Controls 6.0.0.0 in the now
  **committed** `.cargo/config.toml`. 227 Rust tests now run and pass. The GNU
  linker has no equivalent, so the suite must be run under MSVC on Windows —
  documented in the README.
- **SFTP `chmod` silently truncated files to zero bytes.** It built the request
  from `FileAttributes::default()`, which carries `size: Some(0)`, so the SETSTAT
  also set the file length. Now uses `FileAttributes::empty()` with only the
  permission bits.
- Sessions were never closed gracefully — neither on disconnect nor on quit. FTP
  `QUIT` and SSH disconnect are now sent, and all sessions are closed on exit.

#### Found by an adversarial review of the hardening itself

- **Arbitrary local file write from a hostile remote listing.** Directory-entry
  names went straight from a `LIST`/`readdir` response into
  `Path::join(local_dir, name)` during a recursive download. On Windows an
  absolute name *discards the base path entirely*, so a server could return an
  entry named `C:\Users\<you>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.exe`
  and place attacker-chosen content in the victim's startup folder; `..` segments
  escaped the target directory the same way, over both FTP and SFTP. Entry names
  are now validated in the protocol layer (`ftp::types::is_safe_entry_name`:
  exactly one normal path component — no separators, drive or UNC prefixes,
  `.`/`..`, NUL or control characters), and the transfer walker re-checks that
  every produced path stays under the directory the user chose.
- **The "pinned" FTPS certificate was not actually pinned.**
  `add_root_certificate` is *additive*, so the system trust store still applied;
  combined with the relaxed hostname check, the connector accepted any
  certificate chaining to any public CA, for any name. Because the pinning
  decision is made on a separate probe connection from the one that carries
  credentials, an on-path attacker could let the probe reach the real server and
  then present their own CA-issued certificate on the session connection.
  `disable_built_in_roots(true)` now makes the approved certificate the only
  acceptable trust anchor.
- **A master-password change silently destroyed every stored AI API key.** Only
  the bookmark store was re-keyed; `ai-keys.json` stayed encrypted under the
  discarded key. Re-keying now covers both stores through one composite, and the
  AI key re-key is idempotent so the vault's rollback path stays safe.
- Recursive remote delete had no depth limit (only symlinks were guarded), so a
  server reporting an endless chain of real subdirectories could drive unbounded
  recursion while issuing deletes. Capped at 64 levels.
- Folder transfers were bounded by depth but not by total work: a listing with two
  subdirectories at every level is exponential, so expansion could run until the
  process ran out of memory. Now also capped at 200,000 entries.
- `ConnectionConfig`/`ConnectArgs` derived `Debug` while holding a plaintext
  password and key passphrase; a single `tracing::debug!(?config)` would have
  logged them. `ConnectionConfig` now has a redacting `Debug`, and `ConnectArgs`
  has none.
- `save_json_atomic` set restrictive permissions *after* writing, leaving secrets
  briefly readable at the process umask, and never fsynced the parent directory,
  so a crash could lose the rename along with the just-saved content. Files are
  now created `0600` on Unix and the directory is synced after the rename.
- A host-key rejection that raced the connect timeout was reported as a network
  timeout, which trains users to retry precisely when the server's identity did
  not check out.
- `cancel_script` could not interrupt a transfer already in flight, so cancelling
  during a large `ftp_download` waited for the whole file. The script host now
  shares the engine's cancellation flag.

#### Found by actually running the app

Two defects that every static check passed — type-check, lint and 499 unit tests
were all green while the app was unusable:

- **The UI crashed on launch with "Maximum update depth exceeded".** A selector
  built a fresh array on every store read (`s.order.map((id) => s.sessions[id])`);
  zustand v5 compares snapshots by reference, so it re-rendered forever. It hit at
  startup rather than when the dialog opened, because the dialog host renders
  `ScriptManager` with `open={false}`. Fixed by selecting the two stable
  references and deriving the list in a `useMemo`. The error boundary did its job
  and showed a recovery screen instead of a white page.
- **The file list overflowed its pane and drew over the footer and the transfer
  queue.** Radix renders the context-menu trigger as its own element between the
  pane and its grid; as a flex item it sized correctly, but the grid's `flex-1`
  was ignored because that element was not itself a flex container, so the listing
  grew to its full content height. Fixed by making the trigger
  `flex min-h-0 flex-1 flex-col`, plus the same `min-h-0` on both pane columns.

### Changed (build)

- `git2` dropped to `default-features = false`. Nothing in ftpie fetches or
  pushes, so the default `ssh`/`https` transports and the vendored OpenSSL they
  pulled in were dead weight; this removes an entire TLS stack plus libssh2 from
  the build and its CVE surface. Combined with dropping the unused `shell` and
  `fs` Tauri plugins, the dependency tree is meaningfully smaller.
- Bundle identifier changed from `io.ftpie.app` to `io.ftpie.desktop`. Tauri warns
  about an identifier ending in `.app` because it collides with the macOS
  application-bundle extension, and `bundle.targets` is `"all"`. Changed now,
  before any release exists — afterwards it would break update continuity and
  per-app data paths.
- The Tauri CLI is now a pinned `@tauri-apps/cli` devDependency instead of an
  assumed global `cargo tauri`, so `npm ci` is the only setup step. Bundling
  additionally requires the MSVC toolchain on Windows (WiX and NSIS do not
  support `windows-gnu`); the README documents the `RUSTUP_TOOLCHAIN` override
  for machines whose rustup default is GNU.
- `dead_code` is allowed crate-wide via `[lints.rust]` in `src-tauri/Cargo.toml`,
  with a comment explaining why: several modules deliberately expose a complete,
  unit-tested API that no command wires up yet. Every other lint stays denied,
  and `clippy --all-targets -- -D warnings` is clean.

### Security

- See the Security section of the README for the TOFU trust model, vault
  guarantees and limits, and the warning that plain FTP transmits credentials and
  file contents in cleartext.
- The auto-updater is deliberately **not** enabled: no endpoint and no signing
  key exist yet. The README documents everything required to turn it on safely.

[Unreleased]: https://github.com/OWNER/ftpie/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/ftpie/releases/tag/v0.1.0
