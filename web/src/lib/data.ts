/**
 * Every factual claim on the site lives here, so it can be checked in one place.
 *
 * The rule: if the shipped app does not do it, it does not go on the site.
 * ftpie's first design document promised WebDAV, S3, live collaboration, a plugin
 * system and cloud sync. None of it existed, and two of those (WebDAV, S3)
 * quietly fell back to a plaintext FTP handshake. That is why the "what it won't
 * do" section exists, and why nothing here is aspirational.
 */

export const VERSION = '0.1.0';
export const LICENSE = 'Apache-2.0';

export const REPO = 'https://github.com/sezginkipel/ftpie';

/**
 * No installers are published. Release signing is not set up, and handing out
 * unsigned installers is the exact problem this app exists to avoid.
 */
export const PUBLISHED_BINARIES = false;

export interface Protocol {
  name: string;
  port: string;
  how: string;
  encrypted: boolean;
}

export const PROTOCOLS: Protocol[] = [
  {
    name: 'SFTP',
    port: '22',
    how: 'Over SSH, with a password or a private key.',
    encrypted: true
  },
  {
    name: 'FTPS',
    port: '21',
    how: 'Starts plain, then upgrades with AUTH TLS.',
    encrypted: true
  },
  {
    name: 'FTPS implicit',
    port: '990',
    how: 'TLS from the first byte, on its own code path.',
    encrypted: true
  },
  {
    name: 'FTP',
    port: '21',
    how: 'No encryption. For hosts that offer nothing else.',
    encrypted: false
  }
];

export interface Feature {
  title: string;
  body: string;
  icon: 'edit' | 'git' | 'queue' | 'script' | 'ai' | 'shield';
}

/** The two that get a diagram of their own on the page. */
export const SPOTLIGHTS: Feature[] = [
  {
    icon: 'edit',
    title: 'Remote editing that checks for conflicts',
    body: 'Open a file on the server, edit it, save it. Before writing, ftpie compares what is on the server against the version you opened. If someone changed it in the meantime, you get a line diff and a choice instead of a silent overwrite. The editor ships inside the app, so nothing is loaded from a CDN.'
  },
  {
    icon: 'git',
    title: 'Deploy a commit, then take it back',
    body: 'Pick a branch or tag. ftpie works out what changed since your last deploy and shows you the list, including the files it will delete. Nothing moves until you confirm, and every deploy is recorded so you can roll back to an earlier one.'
  }
];

export const FEATURES: Feature[] = [
  {
    icon: 'queue',
    title: 'A queue you can pause and cancel',
    body: 'Files stream through in 64 KiB chunks, so a 4 GB upload does not depend on your RAM. Every item shows real progress, speed and ETA, and a download lands in a .part file that is renamed only once it finishes.'
  },
  {
    icon: 'shield',
    title: 'Saved passwords are encrypted',
    body: 'Credentials live in a vault encrypted with AES-256-GCM, under a key derived from your master password with Argon2id. The key exists only while the vault is unlocked, and is wiped when you lock it. There is no recovery path.'
  },
  {
    icon: 'script',
    title: 'Sandboxed scripting',
    body: 'Automate repetitive jobs in a small embedded language. Scripts cannot read your environment or load code off disk, file access stays inside one workspace folder, and a runaway loop can be cancelled.'
  },
  {
    icon: 'ai',
    title: 'An optional AI assistant',
    body: 'Off until you add your own API key. It can propose renames, moves and permission changes on the server you are connected to, but it cannot carry any of them out. You confirm each one.'
  }
];

export interface Excluded {
  name: string;
  reason: string;
}

export const NOT_INCLUDED: Excluded[] = [
  {
    name: 'WebDAV and S3',
    reason:
      'Both were on the list once, and both fell through to a plaintext FTP handshake, which sent your credentials to whatever answered the port. Removed instead of patched.'
  },
  {
    name: 'Live collaboration',
    reason:
      'It never actually worked across a network. Doing it properly needs a server in the middle, and there is not one.'
  },
  {
    name: 'A built-in terminal',
    reason: 'It leaked an SSH connection every time you opened one. Your own terminal does this better.'
  },
  {
    name: 'Cloud sync for saved sites',
    reason:
      'Your bookmarks are encrypted on your machine. Export is a file you look after yourself. Nothing is uploaded.'
  },
  {
    name: 'Analytics of any kind',
    reason: 'No telemetry and no usage reporting. The app makes no request you did not ask for.'
  },
  {
    name: 'Silent updates',
    reason:
      'ftpie can check for a new version and will only install one whose signature it can verify, but it never updates itself without asking. There are no published releases yet, so there is nothing to update from either.'
  }
];

export interface SecurityPoint {
  label: string;
  body: string;
}

export const SECURITY: SecurityPoint[] = [
  {
    label: 'Server listings are treated as untrusted input',
    body: 'A directory listing arrives from the server, so ftpie checks it before acting on it. A file called "..\..\startup.exe" cannot walk out of the folder you chose, and a recursive transfer will not follow a symlink in circles.'
  },
  {
    label: 'Plain FTP is labelled while you use it',
    body: 'Pick plain FTP and you get a warning when you connect, plus a broken padlock in the status bar for as long as the session is open.'
  },
  {
    label: 'Errors name the actual problem',
    body: 'An unknown host, a locked vault and a timeout are three different messages, so you can tell whether to retry or to go and look at something.'
  }
];
