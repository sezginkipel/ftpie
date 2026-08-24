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
    how: 'Over SSH. Password, or a private key with a passphrase.',
    encrypted: true
  },
  {
    name: 'FTPS',
    port: '21',
    how: 'Starts plain, upgrades with AUTH TLS.',
    encrypted: true
  },
  {
    name: 'FTPS implicit',
    port: '990',
    how: 'TLS from the first byte. A separate path, not the upgrade reused.',
    encrypted: true
  },
  {
    name: 'FTP',
    port: '21',
    how: 'No encryption. Here because some servers still only speak this.',
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
    title: "Saving won't quietly overwrite someone",
    body: "Open a remote file, edit it, save it. Before writing, ftpie compares what's on the server against what you opened. If it changed, you get the diff and a choice instead of a silent overwrite. The editor is bundled in, so none of this needs a connection to work."
  },
  {
    icon: 'git',
    title: 'Deploy a commit, then take it back',
    body: "Pick a branch or tag. ftpie works out what changed since your last deploy and shows you the list — including the files it will delete, which is the part most tools skip. Nothing moves until you say so, and every deploy is recorded so you can go back to an earlier one."
  }
];

export const FEATURES: Feature[] = [
  {
    icon: 'queue',
    title: 'Transfers you can stop',
    body: 'Files stream through in chunks, so a 4 GB upload does not depend on your RAM. Real progress, real speed, and cancel actually cancels.'
  },
  {
    icon: 'shield',
    title: 'Passwords stay locked',
    body: 'Saved credentials sit behind a master password. The key exists only while the vault is unlocked, and is wiped when you lock it.'
  },
  {
    icon: 'script',
    title: 'Scripting, fenced in',
    body: 'Automate repetitive jobs in a small embedded language. It cannot read your environment, cannot load code off disk, and a runaway loop is cancellable.'
  },
  {
    icon: 'ai',
    title: 'An optional assistant',
    body: 'Off until you add a key. It can suggest renames, moves and permission changes on the server you are already on. It cannot run anything on its own.'
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
      'They were on the list once, but they fell through to a plaintext FTP handshake, which meant your credentials went to whatever answered the port. Removed instead of patched.'
  },
  {
    name: 'Live collaboration',
    reason:
      'It never actually worked across a network. Doing it properly needs a server in the middle, which does not exist yet.'
  },
  {
    name: 'A built-in terminal',
    reason: 'It leaked an SSH connection every time you opened one. Your terminal is better at this.'
  },
  {
    name: 'Cloud sync for saved sites',
    reason:
      'Your bookmarks are encrypted on your machine. Export is a file you protect yourself. Nothing gets uploaded.'
  },
  { name: 'Analytics of any kind', reason: 'The app makes no request you did not ask for.' },
  {
    name: 'Auto-update',
    reason:
      'Off on purpose. An update channel nobody signs is just a way to run code on your machine.'
  }
];

export interface SecurityPoint {
  label: string;
  body: string;
}

export const SECURITY: SecurityPoint[] = [
  {
    label: 'The listing is not trusted either',
    body: 'A folder listing comes from the server, so ftpie treats it as untrusted input. A file called "..\\..\\startup.exe" cannot walk out of the folder you chose, and it will not follow a symlink in circles.'
  },
  {
    label: 'Plaintext is never quiet about it',
    body: 'Pick plain FTP and you get a warning when you connect, plus a broken padlock in the status bar for as long as the session is open.'
  },
  {
    label: 'Errors say what went wrong',
    body: 'An unknown host, a locked vault and a timeout are three different messages, not one generic failure that teaches you to click retry.'
  }
];
