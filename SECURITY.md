# Security Policy

## Supported versions

ftpie is pre-1.0. Only the latest release receives security fixes.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ (prototype, unreleased) |

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Report it privately through either channel:

1. **GitHub Security Advisories** — the *Security* tab → *Report a vulnerability*.
   This is preferred: it keeps the report, the discussion, and the fix together
   and privately.
2. **Email** — `security@ftpie.io`. If you want an encrypted channel, say so in a
   first plaintext message and we will exchange keys.

### What to include

- The version or commit you tested.
- Your platform (OS and version) and the protocol involved, if any.
- What an attacker can do, and what they need in order to do it (network
  position, local access, a malicious server, a crafted file, …).
- Reproduction steps or a proof of concept. A minimal server-side repro is
  especially valuable for protocol issues.
- Any suggested fix, if you have one.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement | within 3 working days |
| Initial assessment and severity | within 7 working days |
| Fix or documented mitigation | within 90 days, sooner for high severity |

We will keep you updated as the assessment progresses, credit you in the
changelog and advisory unless you prefer to stay anonymous, and coordinate
disclosure timing with you. We do not currently operate a paid bug-bounty
programme.

## Scope

ftpie is a desktop client. It has no server component and no backend service, so
the interesting attack surface is:

**In scope**

- Bypassing host verification: accepting an unknown, changed, or invalid SSH host
  key or TLS certificate; any path that reaches a blanket "accept invalid
  certificate".
- Vault weaknesses: recovering secrets without the master password, key material
  surviving a lock, weak KDF parameters, ciphertext reuse across contexts.
- Credentials or key material leaking to disk, logs, crash dumps, or the network.
- Escaping the Rhai script sandbox: filesystem access outside the workspace root,
  environment access, unbounded resource consumption, arbitrary code execution.
- Prompt injection in the AI assistant that results in an action taken without
  explicit user confirmation, or that exfiltrates vault contents or file data.
- Path traversal in remote-to-local or local-to-remote path handling, including
  via crafted server listings, symlinks, or filenames.
- Webview escapes: CSP bypass, Tauri IPC commands reachable beyond the granted
  capability set, privilege escalation through a plugin scope.
- Memory-safety issues or panics reachable from a malicious server's responses.
- Deploy or rollback writing outside the intended remote path.

**Out of scope**

- Plain FTP transmitting credentials and file contents in cleartext. This is how
  FTP works; it is documented in the README, and the protocol is offered
  deliberately. Reports that "FTP is unencrypted" will be closed as by-design.
- Consequences of a user explicitly accepting a host fingerprint they did not
  verify. TOFU requires the user to make that call.
- Recovering vault contents when the attacker already knows the master password,
  or has debugger/root access to a running process with the vault unlocked.
- Attacks requiring a compromised local machine, a malicious OS-level actor, or a
  physically present attacker with an unlocked session.
- Rhai scripts the user wrote or knowingly imported doing what they say they do.
  Scripts are treated as the user's own code.
- Missing hardening that has no demonstrated impact (e.g. "header X is absent").
- Vulnerabilities in third-party dependencies with no exploitable path in ftpie.
  Please report those upstream; tell us so we can bump the version.
- Denial of service against the user's own machine through obviously abusive
  input.

## Security design notes

The threat model, the trust-on-first-use host verification flow, the vault's
guarantees and its explicit limits, and the current webview hardening are all
described in the [Security section of the README](README.md#security). Read it
before filing a report — it may already answer the question.

Two deliberate decisions worth restating:

- **The auto-updater is disabled.** No endpoint and no signing key exist. An
  unsigned update channel is a remote code execution channel, so the updater will
  not be enabled until signing is in place.
- **AI-suggested actions are inert until confirmed.** There is no action that
  executes arbitrary scripts or shell commands.
