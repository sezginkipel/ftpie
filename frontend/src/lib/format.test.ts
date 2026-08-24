import { describe, expect, it } from 'vitest';

import {
  DASH,
  baseName,
  chunkFingerprint,
  formatBytes,
  formatDate,
  formatEta,
  formatMode,
  formatPercent,
  formatSpeed,
  joinPath,
  modeToOctal,
  parentPath,
  parseMode,
  progressRatio,
  truncateMiddle,
} from './format';

describe('formatBytes', () => {
  it('keeps byte counts integral and switches to one decimal from KB up', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('uses binary steps of 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12.3 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('caps at the largest unit rather than producing nonsense', () => {
    expect(formatBytes(1024 ** 6)).toBe('1024.0 PB');
  });

  it('returns a dash for absent or non-finite input rather than "0 B"', () => {
    expect(formatBytes(null)).toBe(DASH);
    expect(formatBytes(undefined)).toBe(DASH);
    expect(formatBytes(Number.NaN)).toBe(DASH);
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe(DASH);
  });
});

describe('formatSpeed', () => {
  it('appends a per-second suffix to a binary size', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(1024)).toBe('1.0 KB/s');
    expect(formatSpeed(1.2 * 1024 * 1024)).toBe('1.2 MB/s');
  });

  it('rejects negative and absent rates', () => {
    expect(formatSpeed(null)).toBe(DASH);
    expect(formatSpeed(-1)).toBe(DASH);
  });
});

describe('formatEta', () => {
  it('renders seconds, minutes, hours and days', () => {
    expect(formatEta(0)).toBe('0s');
    expect(formatEta(45)).toBe('45s');
    expect(formatEta(134)).toBe('2m 14s');
    expect(formatEta(3900)).toBe('1h 05m');
    expect(formatEta(90000)).toBe('1d 01h');
  });

  it('shows a dash when the backend could not estimate one', () => {
    // `etaSecs` is genuinely null while speed is 0 — never show "0s" there.
    expect(formatEta(null)).toBe(DASH);
    expect(formatEta(undefined)).toBe(DASH);
    expect(formatEta(-5)).toBe(DASH);
  });
});

describe('formatPercent and progressRatio', () => {
  it('treats a zero total as unknown rather than as complete', () => {
    expect(formatPercent(0, 0)).toBe(DASH);
    expect(progressRatio(0, 0)).toBeNull();
  });

  it('floors the percentage and clamps to 100', () => {
    expect(formatPercent(1, 3)).toBe('33%');
    expect(formatPercent(5, 4)).toBe('100%');
    expect(progressRatio(5, 4)).toBe(1);
  });
});

describe('formatMode', () => {
  it('converts numeric bits to symbolic form', () => {
    expect(formatMode(0o755)).toBe('rwxr-xr-x');
    expect(formatMode(0o644)).toBe('rw-r--r--');
    expect(formatMode(0o000)).toBe('---------');
    expect(formatMode(0o777)).toBe('rwxrwxrwx');
  });

  it('converts octal strings to symbolic form', () => {
    expect(formatMode('755')).toBe('rwxr-xr-x');
    expect(formatMode('0644')).toBe('rw-r--r--');
  });

  it('passes an already-symbolic string through unchanged', () => {
    expect(formatMode('rwxr-xr-x')).toBe('rwxr-xr-x');
    expect(formatMode('drwxr-xr-x')).toBe('rwxr-xr-x');
  });

  it('round-trips setuid, setgid and sticky bits', () => {
    expect(formatMode(0o4755)).toBe('rwsr-xr-x');
    expect(formatMode(0o2755)).toBe('rwxr-sr-x');
    expect(formatMode(0o1777)).toBe('rwxrwxrwt');
    expect(formatMode(0o4655)).toBe('rwSr-xr-x');
  });

  it('shows a dash instead of guessing at unrecognised input', () => {
    expect(formatMode(null)).toBe(DASH);
    expect(formatMode('')).toBe(DASH);
    expect(formatMode('not-a-mode')).toBe(DASH);
    expect(formatMode('999')).toBe(DASH);
  });
});

describe('parseMode and modeToOctal — the other direction', () => {
  it('parses symbolic form back to numeric bits', () => {
    expect(parseMode('rwxr-xr-x')).toBe(0o755);
    expect(parseMode('rw-r--r--')).toBe(0o644);
    expect(parseMode('rwsr-xr-x')).toBe(0o4755);
    expect(parseMode('rwxrwxrwt')).toBe(0o1777);
  });

  it('parses octal strings and passes numbers through', () => {
    expect(parseMode('755')).toBe(0o755);
    expect(parseMode('0755')).toBe(0o755);
    expect(parseMode(0o755)).toBe(0o755);
  });

  it('renders octal for chmod dialogs', () => {
    expect(modeToOctal('rwxr-xr-x')).toBe('755');
    expect(modeToOctal(0o644)).toBe('644');
    expect(modeToOctal(0o4755)).toBe('4755');
    expect(modeToOctal('garbage')).toBe(DASH);
  });

  it('survives a full round trip in both directions', () => {
    for (const octal of ['755', '644', '600', '777', '400', '4755', '1777']) {
      expect(modeToOctal(formatMode(octal))).toBe(octal);
    }
  });
});

describe('parentPath — POSIX remote paths', () => {
  it('walks up and stops at the root', () => {
    expect(parentPath('/var/www/html', true)).toBe('/var/www');
    expect(parentPath('/var/www', true)).toBe('/var');
    expect(parentPath('/var', true)).toBe('/');
    expect(parentPath('/', true)).toBeNull();
  });

  it('normalizes trailing and duplicated separators', () => {
    expect(parentPath('/var/www/', true)).toBe('/var');
    expect(parentPath('//var//www', true)).toBe('/var');
  });

  it('treats a bare name as living at the root', () => {
    expect(parentPath('www', true)).toBe('/');
  });

  it('rejects empty input', () => {
    expect(parentPath('', true)).toBeNull();
    expect(parentPath('   ', true)).toBeNull();
  });
});

describe('parentPath — Windows drive roots', () => {
  it('reports no parent for a drive root, in every spelling', () => {
    // The old code tested `length > 3`, so "C:\" became "C:" — a relative path
    // that silently resolved to the process working directory.
    expect(parentPath('C:\\', false)).toBeNull();
    expect(parentPath('C:/', false)).toBeNull();
    expect(parentPath('C:', false)).toBeNull();
    expect(parentPath('d:\\', false)).toBeNull();
  });

  it('keeps the separator when the parent IS the drive root', () => {
    expect(parentPath('C:\\Users', false)).toBe('C:\\');
    expect(parentPath('C:\\Users\\', false)).toBe('C:\\');
  });

  it('walks deeper paths normally', () => {
    expect(parentPath('C:\\Users\\CWD\\Documents', false)).toBe('C:\\Users\\CWD');
    expect(parentPath('C:\\Users\\CWD', false)).toBe('C:\\Users');
    expect(parentPath('C:/Users/CWD', false)).toBe('C:\\Users');
  });
});

describe('parentPath — UNC paths', () => {
  it('reports no parent for a share root', () => {
    expect(parentPath('\\\\server\\share', false)).toBeNull();
    expect(parentPath('\\\\server\\share\\', false)).toBeNull();
  });

  it('walks inside a share and stops at its root', () => {
    expect(parentPath('\\\\server\\share\\dir', false)).toBe('\\\\server\\share');
    expect(parentPath('\\\\server\\share\\dir\\sub', false)).toBe('\\\\server\\share\\dir');
  });
});

describe('parentPath — POSIX local paths', () => {
  it('behaves like the remote case', () => {
    expect(parentPath('/home/user/docs', false)).toBe('/home/user');
    expect(parentPath('/home', false)).toBe('/');
    expect(parentPath('/', false)).toBeNull();
  });
});

describe('joinPath and baseName', () => {
  it('joins remote paths POSIX-style, mirroring RemoteFile::join_path', () => {
    expect(joinPath('/var/www', 'a.txt', true)).toBe('/var/www/a.txt');
    expect(joinPath('/var/www/', 'a.txt', true)).toBe('/var/www/a.txt');
    expect(joinPath('/', 'a.txt', true)).toBe('/a.txt');
    expect(joinPath('', 'a.txt', true)).toBe('/a.txt');
  });

  it('joins local paths with the separator already in use', () => {
    expect(joinPath('C:\\Users', 'a.txt', false)).toBe('C:\\Users\\a.txt');
    expect(joinPath('C:\\', 'a.txt', false)).toBe('C:\\a.txt');
    expect(joinPath('/home/user', 'a.txt', false)).toBe('/home/user/a.txt');
  });

  it('extracts the last component for either separator', () => {
    expect(baseName('/var/www/a.txt')).toBe('a.txt');
    expect(baseName('C:\\Users\\a.txt')).toBe('a.txt');
    expect(baseName('/var/www/')).toBe('www');
    expect(baseName('a.txt')).toBe('a.txt');
  });
});

describe('formatDate', () => {
  const when = new Date('2026-08-24T14:03:00Z');

  it('renders an unambiguous sortable form for the iso style', () => {
    // Local-time based, so assert the shape rather than a fixed offset.
    expect(formatDate(when, 'tr', 'iso')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('renders relative time in the active locale', () => {
    const now = new Date('2026-08-24T14:06:00Z');
    expect(formatDate(when, 'en', 'relative', now)).toContain('minute');
    expect(formatDate(when, 'tr', 'relative', now)).toMatch(/dakika/);
  });

  it('shows a dash rather than "Invalid Date"', () => {
    expect(formatDate(null, 'tr', 'short')).toBe(DASH);
    expect(formatDate('', 'tr', 'short')).toBe(DASH);
    expect(formatDate('not a date', 'tr', 'short')).toBe(DASH);
  });
});

describe('truncateMiddle and chunkFingerprint', () => {
  it('keeps both ends of a long name readable', () => {
    const long = 'a-very-long-archive-name-indeed.tar.gz';
    const short = truncateMiddle(long, 20);
    expect(short.length).toBeLessThanOrEqual(20);
    expect(short.startsWith('a-very')).toBe(true);
    expect(short.endsWith('tar.gz')).toBe(true);
  });

  it('leaves a short name untouched', () => {
    expect(truncateMiddle('a.txt', 20)).toBe('a.txt');
  });

  it('groups a fingerprint into readable chunks and keeps the prefix', () => {
    const chunked = chunkFingerprint('SHA256:abcdefghijklmnop', 8);
    expect(chunked).toBe('SHA256:abcdefgh ijklmnop');
  });

  it('leaves a fingerprint with no prefix alone', () => {
    expect(chunkFingerprint('abcdef')).toBe('abcdef');
  });
});
