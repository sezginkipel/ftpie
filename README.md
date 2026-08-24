# ftpie

A desktop file-transfer client for developers, built with [Tauri 2](https://tauri.app),
Rust, and React 19.

ftpie is what you reach for when a plain FTP client is not enough: it connects over
FTP, FTPS (explicit and implicit), and SFTP, keeps credentials in an encrypted
vault, lets you edit remote files in a real editor, and can deploy a git branch to
a remote host with history and one-click rollback.

> **Status: pre-1.0.** The 0.1.0 release is a security and packaging hardening
> pass. Interfaces may still change.

**Website:** <https://ftpie.sadelabs.site> — source in [`web/`](web/).

---

## Screenshots

<!-- TODO: replace these placeholders with real captures before the first tagged release. -->

| Dual-pane browser | Remote editor | Deploy |
| --- | --- | --- |
| _`docs/screenshots/browser.png` — placeholder_ | _`docs/screenshots/editor.png` — placeholder_ | _`docs/screenshots/deploy.png` — placeholder_ |

---

## Features

**Protocols**

- **FTP** — plain, unencrypted. Supported, but see [Security](#security).
- **FTPS (explicit)** — `AUTH TLS` on port 21, with real certificate verification.
- **FTPS (implicit)** — TLS from the first byte, port 990.
- **SFTP** — over SSH, with password *or* public-key authentication
  (encrypted private keys and passphrases supported).
- Real host verification for both TLS certificates and SSH host keys, using a
  trust-on-first-use store. Server listings are parsed from `MLSD` where
  available, falling back to Unix `ls -l` and DOS/IIS formats.

**Transfers**

- Queue with per-item progress, speed, and ETA; pause, resume, and cancel.
- Streaming 64 KiB chunked transfers — no file is ever buffered whole in memory.
- Downloads land in a `.part` file and are renamed only on success.
- Recursive directory transfers with a symlink guard and a depth limit.
- Configurable concurrency, connect timeouts, and per-socket IO timeouts.

**Editing**

- Remote file editing in a locally bundled **Monaco** editor (no CDN).
- Content-hash conflict detection: if the remote file changed under you, the save
  is refused and you are offered a real LCS-based line diff.
- Binary-safe: binary payloads round-trip as base64.

**Bookmarks & secrets**

- Encrypted **bookmark vault**: AES-256-GCM with an Argon2id-derived key, unlocked
  by a master password. Key material is zeroized on lock.
- Import/export of bookmarks.
- AI provider API keys live in the same vault, never in a config file or an
  environment variable.

**Git-aware deploy**

- Deploy a branch or tag from a local git repository to a remote path.
- Deploys from a committed tree by default; including uncommitted changes is
  opt-in.
- Propagates deletions and renames; excludes use real glob patterns.
- Deploy history with **rollback**, and live `deploy:progress` events.

**Automation**

- **Rhai** scripting with a sandboxed engine: operation/recursion/allocation
  limits, no environment access, filesystem access confined to a workspace root,
  and cooperative cancellation.
- Script-visible operations bind to the active session: list, upload, download,
  mkdir, delete, log.

**AI assistant**

- Optional assistant backed by Anthropic, OpenAI, Ollama, or a validated custom
  HTTPS endpoint.
- Suggested actions are **inert until you confirm them** and state exactly what
  they will do. There is no "run arbitrary script" action.

### Explicitly *not* supported

These were removed during hardening and will not come back without a redesign:

- **Real-time collaboration** / shared sessions — removed.
- **WebDAV** — removed (it silently fell through to plaintext FTP).
- **S3** — removed (same problem).
- **Built-in SSH terminal** — removed.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Rust** stable (1.77+) | via [rustup](https://rustup.rs) |
| **Node.js** 20+ and npm 10+ | for the frontend |
| **Windows:** Visual Studio Build Tools with the *Desktop development with C++* workload | provides the MSVC toolchain — the recommended target |
| **Windows:** WebView2 runtime | preinstalled on Windows 11 |
| **macOS:** Xcode command line tools | `xcode-select --install` |
| **Linux:** WebKitGTK + friends | see below |

Linux system packages (Debian/Ubuntu):

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
  patchelf libssl-dev libgtk-3-dev build-essential curl wget file pkg-config
```

---

## Development setup

```bash
git clone https://github.com/sezginkipel/ftpie
cd ftpie

# Frontend dependencies
npm ci --prefix frontend

# Local build configuration (see the gotcha below)
cp .cargo/config.toml.example .cargo/config.toml

# Optional: logging etc.
cp .env.example .env

# Run the app (starts vite, then the Tauri shell)
cd src-tauri && cargo tauri dev
# or: npx --yes @tauri-apps/cli@latest dev
```

### ⚠️ Gotcha: paths containing a space

If your checkout path contains a space — for example `D:\Backup-4 2026\ftpie` —
a **MinGW build will fail to link**. GCC's `collect2` passes object-file paths to
the linker without quoting them, so the space splits one path into two arguments
and you get baffling "cannot find *fragment*" errors. It is not a missing
library and not a stack-size problem.

The fix is a build directory whose full path contains **no spaces**:

```bash
# bash / MSYS2
export CARGO_TARGET_DIR="C:/ftpie-target"
```

```powershell
# PowerShell
$env:CARGO_TARGET_DIR = "C:/ftpie-target"
```

`.cargo/config.toml.example` sets this persistently via `build.target-dir`.

Note that a `CARGO_TARGET_DIR` entry inside a cargo `[env]` block does **not**
work — cargo resolves its target directory before applying `[env]`. Use
`build.target-dir` or a real environment variable.

### Windows: MSVC (recommended)

MSVC is the production target. It is the only Windows target Tauri can bundle to
MSI (WiX) and NSIS, and Authenticode code signing expects MSVC-produced
binaries. CI builds MSVC.

```powershell
rustup target add x86_64-pc-windows-msvc
cd src-tauri
cargo tauri build --target x86_64-pc-windows-msvc
```

### Windows: MinGW (fallback)

Use this only if you cannot install the MSVC build tools. It cannot produce
signed MSI installers.

```bash
# MSYS2
pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-lld mingw-w64-x86_64-pkg-config
rustup target add x86_64-pc-windows-gnu

export PATH="/c/msys64/mingw64/bin:$PATH"
export CARGO_TARGET_DIR="C:/ftpie-target"      # space-free, see above
cd "src-tauri" && cargo build --target x86_64-pc-windows-gnu
```

Keep any MinGW `CC`/`CXX`/`AR` overrides **scoped to the GNU target**. A global
`[env]` block forcing gcc will break an MSVC build in the same checkout.

---

## Tests

```bash
# Rust — on Windows this MUST run under the MSVC toolchain (see below)
cargo test --workspace

# Frontend
npm test --prefix frontend          # vitest
npx tsc --noEmit --project frontend # type check
npm run lint --prefix frontend
```

Current state: **227 Rust tests** and **142 frontend tests**, all passing.
`cargo clippy --workspace --all-targets -- -D warnings` is clean.

### ⚠️ Windows: `cargo test` requires the MSVC toolchain

Tauri's window layer imports comctl32 **version 6** symbols (`TaskDialogIndirect`,
`SetWindowSubclass`, `RemoveWindowSubclass`, `DefSubclassProc`). The application
binary gets a side-by-side manifest from `tauri-build` requesting v6, but
`cargo test` binaries get **no** manifest, so Windows loads the legacy comctl32
5.82 from WinSxS, cannot resolve those imports, and the test executable dies at
startup with `STATUS_ENTRYPOINT_NOT_FOUND` (`0xC0000139`) — before a single test
runs, on both MSVC and MinGW.

The committed `.cargo/config.toml` fixes this for MSVC by declaring the
dependency for every binary the crate produces:

```toml
[target.x86_64-pc-windows-msvc]
rustflags = ["-Clink-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"]
```

The GNU linker has no `/MANIFESTDEPENDENCY` equivalent, so **test binaries built
for `x86_64-pc-windows-gnu` still cannot launch**. `cargo check` and `cargo build`
work fine on MinGW; run the suite under MSVC:

```bash
cargo +stable-x86_64-pc-windows-msvc test --workspace
```

MSVC also needs its environment, so run that from a *Developer Command Prompt*,
or `call` `vcvars64.bat` first:

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
```

Without it `link.exe` fails with `LNK1104` because the MSVC and Windows SDK
library paths are not set.

---

## Build and bundle

The Tauri CLI ships as a pinned devDependency (`@tauri-apps/cli`), so `npm ci`
in `frontend/` is all the setup it needs — nothing has to be installed globally.

```bash
# Frontend only
npm run build --prefix frontend

# Full app + installers for the host platform.
# Run from the repository root; `tauri build` invokes the frontend build itself
# via `beforeBuildCommand`.
npx --prefix frontend tauri build
```

**Windows: force the MSVC toolchain if it is not your rustup default.** MSI (WiX)
and NSIS bundling only work on `x86_64-pc-windows-msvc`, and MSVC needs its
environment for linking:

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc
npx --prefix frontend tauri build
```

Check your default with `rustup show`. If it reports `windows-gnu`, the bundling
step will fail without that override. `rustup override set stable-x86_64-pc-windows-msvc`
makes it stick for this checkout.

Artifacts land in `<target-dir>/release/bundle/`:

| Platform | Bundles |
| --- | --- |
| Windows | `msi/` (WiX), `nsis/` (setup .exe) |
| macOS | `dmg/`, `macos/*.app` |
| Linux | `deb/`, `rpm/`, `appimage/` |

Releases are produced by `.github/workflows/release.yml` on `v*` tags via
`tauri-apps/tauri-action`. That workflow contains commented-out blocks marking
exactly where Windows code-signing, macOS notarization, and updater-signing
secrets plug in.

### Auto-updater (currently disabled)

The updater is intentionally **off**: there is no `plugins.updater` block in
`src-tauri/tauri.conf.json` and no release endpoint exists yet. Enabling it
requires all of:

1. `npx tauri signer generate -w ~/.tauri/ftpie.key` to create a keypair.
2. The **public** key in `tauri.conf.json` under `plugins.updater.pubkey`, plus
   `plugins.updater.endpoints` pointing at a JSON manifest you host.
3. The `tauri-plugin-updater` crate dependency and its JS counterpart.
4. `"updater:default"` added to `src-tauri/capabilities/default.json`.
5. `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as
   repository secrets, and the corresponding lines in `release.yml` uncommented.

Do not ship an updater without signing — an unsigned update channel is a remote
code execution channel.

---

## Security

Read this before pointing ftpie at anything you care about.

**Plain FTP is plaintext.** `ftp://` sends your username, password, and every
byte of every file in the clear. Anyone on the path can read and modify them.
Use `ftps`, `ftps-implicit`, or `sftp` unless you are on a trusted local network
and understand the exposure.

**Host trust is trust-on-first-use (TOFU).** The first time you connect to a
host, ftpie shows you the server's SSH host-key or TLS certificate fingerprint
(`SHA256:…`) and asks you to accept it. The decision is recorded in
`known_hosts.json`. On later connections:

- a matching fingerprint connects silently;
- an **unknown** fingerprint prompts again;
- a **changed** fingerprint is a loud warning and the connection is refused.
  That means either the server was legitimately re-keyed, or someone is
  intercepting your traffic. Verify out-of-band before accepting.

ftpie never blanket-accepts invalid certificates. Self-signed certificates are
supported only by pinning the exact certificate you explicitly trusted.

**The vault protects credentials at rest, not in use.** Passwords, SSH key
passphrases, and AI API keys are encrypted with AES-256-GCM under a key derived
from your master password with Argon2id. Consequences:

- There is no empty-master-password mode and no recovery path. **Forget the
  master password and the stored secrets are gone.**
- Saving a credential while the vault is locked is an error, not a silent
  plaintext fallback.
- While unlocked, the derived key is in process memory. It is zeroized on lock,
  but anything with debugger access to the process can read it. Lock the vault
  when you step away.

**Scripting is sandboxed but not a security boundary.** Rhai scripts run with
operation, recursion, and allocation limits, no environment access, and
filesystem access confined to the scripts workspace. Treat them as your own
code, not as untrusted input — do not run scripts you did not read.

**The AI assistant never acts on its own.** Suggested actions are inert until you
confirm them, and there is no action that executes arbitrary scripts. Still,
remote file contents fed into a prompt are untrusted input: review any action
before confirming.

**Webview hardening.** `tauri.conf.json` ships a restrictive CSP
(`default-src 'self'`, `object-src 'none'`, no remote scripts), `withGlobalTauri`
is off, the shell plugin's `open` is regex-restricted to `^https?://`, and
`src-tauri/capabilities/default.json` grants only the IPC surface the app
actually uses — no `plugin-fs` and no `plugin-shell` JS permissions.

To report a vulnerability, see [SECURITY.md](SECURITY.md). Please do not open a
public issue.

---

## Configuration file locations

All state lives in a single `ftpie` directory under the platform config dir:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\ftpie\` |
| macOS | `~/Library/Application Support/ftpie/` |
| Linux | `~/.config/ftpie/` |

| File | Contents |
| --- | --- |
| `vault.json` | Argon2id salt + verifier blob. **No plaintext secrets.** |
| `bookmarks.json` | Saved connections; passwords stored as encrypted blobs. |
| `known_hosts.json` | Accepted SSH host keys and TLS certificate fingerprints. |
| `scripts.json` | Saved Rhai automation scripts. |
| `deploy_history.json` | Deploy records used for rollback. |
| `scripts-workspace/` | Filesystem root scripts are confined to. |

Every one of these is written atomically (temp file, fsync, rename). If one fails
to parse, ftpie backs it up as `<name>.corrupt-<timestamp>`, starts empty, and
marks the store read-only so a later save cannot clobber your data.

Repository-level configuration you may care about:

| File | Purpose |
| --- | --- |
| `.cargo/config.toml.example` | Template for the gitignored local cargo config. |
| `.env.example` | Documented environment variables (`RUST_LOG`, …). |
| `src-tauri/tauri.conf.json` | Window, CSP, bundle, and plugin-scope configuration. |
| `src-tauri/capabilities/default.json` | Tauri v2 IPC permissions. |
| `rustfmt.toml`, `clippy.toml` | Rust formatting and lint configuration. |
| `frontend/eslint.config.js`, `frontend/.prettierrc` | Frontend lint/format. |

`src-tauri/gen/schemas/` is **generated build output** — never hand-edit it.

---

## Contributing

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

npm run lint --prefix frontend
npx tsc --noEmit --prefix frontend
```

CI (`.github/workflows/ci.yml`) runs all of the above on windows-latest (MSVC)
and ubuntu-latest, and additionally validates that `tauri.conf.json` and the
capability files parse and that every declared bundle icon exists.

**Run `rustup update` before trusting a green local clippy.** CI tracks stable,
so a toolchain even a few releases behind will miss lints that CI treats as
errors — a stale local clippy passed this repo while CI failed on
`unnecessary_sort_by` and `question_mark`.

Line endings are LF everywhere, enforced by `.gitattributes` (`eol=lf`) because
`rustfmt.toml` pins `newline_style = "Unix"`. Do not "fix" a diff by converting
a file to CRLF; `cargo fmt --check` will reject it on every platform.

Backend conventions: every `#[tauri::command]` returns `AppResult<T>`, errors
carry a machine-readable `code` plus an English `message`, and all code comments
are in English. Never call `.lock().unwrap()` — use the poison-tolerant helpers
in `state.rs`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this work shall be licensed as above, without any additional
terms or conditions.
