/**
 * Display formatting. Everything here is pure and locale-aware where it needs
 * to be; nothing here reads a store, so it is trivially testable.
 */
import type { DateFormat, Locale } from './types';

const BINARY_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
const STEP = 1024;

/** Placeholder for "not known", used everywhere instead of an empty cell. */
export const DASH = '\u2014';

/**
 * Binary-unit size, one decimal from KB up so columns line up under
 * `font-variant-numeric: tabular-nums`. Bytes stay integral.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return DASH;
  const neg = bytes < 0;
  let value = Math.abs(bytes);
  if (value < STEP) return `${neg ? '-' : ''}${Math.round(value)} B`;

  let unit = 0;
  while (value >= STEP && unit < BINARY_UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  return `${neg ? '-' : ''}${value.toFixed(1)} ${BINARY_UNITS[unit]}`;
}

/** Transfer rate, e.g. `1.2 MB/s`. */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (
    bytesPerSecond === null ||
    bytesPerSecond === undefined ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond < 0
  ) {
    return DASH;
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Remaining time, e.g. `45s`, `2m 14s`, `1h 05m`. Returns {@link DASH} when the
 * backend could not estimate one (`etaSecs: null`).
 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return DASH;
  }
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;

  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, '0')}h`;
}

/** Percentage for a progress bar; `total === 0` means "unknown size". */
export function formatPercent(done: number, total: number): string {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return DASH;
  return `${Math.min(100, Math.floor((done / total) * 100))}%`;
}

/** Fraction in [0, 1], or `null` when the total is unknown (indeterminate). */
export function progressRatio(done: number, total: number): number | null {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, done / total));
}

const INTL_LOCALE: Record<Locale, string> = { tr: 'tr-TR', en: 'en-US' };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Render a timestamp according to the user's `dateFormat` setting.
 *
 * - `iso`      — `2026-08-24 14:03` (sortable, unambiguous, tabular)
 * - `short`    — locale-formatted date and time
 * - `relative` — `3 minutes ago`, localized via `Intl.RelativeTimeFormat`
 *                so no translation keys are needed
 */
export function formatDate(
  value: string | number | Date | null | undefined,
  locale: Locale,
  style: DateFormat = 'short',
  now: Date = new Date(),
): string {
  const d = toDate(value);
  if (!d) return DASH;

  if (style === 'iso') {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
  }

  if (style === 'relative') {
    const rtf = new Intl.RelativeTimeFormat(INTL_LOCALE[locale], { numeric: 'auto' });
    const deltaSecs = (d.getTime() - now.getTime()) / 1000;
    const abs = Math.abs(deltaSecs);
    const table: [Intl.RelativeTimeFormatUnit, number][] = [
      ['second', 60],
      ['minute', 3600],
      ['hour', 86400],
      ['day', 2592000],
      ['month', 31536000],
    ];
    const divisors: Record<string, number> = {
      second: 1,
      minute: 60,
      hour: 3600,
      day: 86400,
      month: 2592000,
      year: 31536000,
    };
    for (const [unit, limit] of table) {
      if (abs < limit) {
        return rtf.format(Math.round(deltaSecs / divisors[unit]), unit);
      }
    }
    return rtf.format(Math.round(deltaSecs / divisors.year), 'year');
  }

  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}

// ── Unix permission modes ────────────────────────────────────────────────────

const RWX = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'] as const;

/** True for a full `rwxr-xr-x`-style string. */
function isSymbolicMode(s: string): boolean {
  return /^[-dlbcps]?[rwxsStT-]{9}$/.test(s);
}

/**
 * Numeric permission bits (not a full `st_mode`) for a symbolic string.
 * `setuid`/`setgid`/sticky bits encoded as `s`/`S`/`t`/`T` are preserved.
 * Returns `null` when the input is not a recognised mode.
 */
export function parseMode(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    return Number.isInteger(input) && input >= 0 ? input & 0o7777 : null;
  }

  const raw = input.trim();
  if (raw === '') return null;

  if (/^0?[0-7]{3,4}$/.test(raw)) return parseInt(raw, 8);

  if (!isSymbolicMode(raw)) return null;
  const perms = raw.length === 10 ? raw.slice(1) : raw;

  let mode = 0;
  let special = 0;
  for (let group = 0; group < 3; group += 1) {
    const [r, w, x] = [perms[group * 3], perms[group * 3 + 1], perms[group * 3 + 2]];
    let bits = 0;
    if (r === 'r') bits |= 4;
    if (w === 'w') bits |= 2;
    if (x === 'x' || x === 's' || x === 't') bits |= 1;
    if (x === 's' || x === 'S') special |= group === 0 ? 4 : 2;
    if (x === 't' || x === 'T') special |= 1;
    mode = mode * 8 + bits;
  }
  return special * 0o1000 + mode;
}

/** `493` (0o755) or `"755"` or `"rwxr-xr-x"` → `"755"`. */
export function modeToOctal(input: string | number | null | undefined): string {
  const mode = parseMode(input);
  if (mode === null) return DASH;
  const octal = (mode & 0o7777).toString(8);
  return octal.length > 3 && octal.startsWith('0') ? octal.slice(1) : octal;
}

/**
 * Permission mode in symbolic form, accepting either direction of input:
 * `755`, `"755"`, `"0755"` or an already-symbolic `"rwxr-xr-x"`.
 * Returns {@link DASH} for anything unrecognised — the file list must not show
 * a wrong mode, and the server genuinely does not always report one.
 */
export function formatMode(input: string | number | null | undefined): string {
  const mode = parseMode(input);
  if (mode === null) return DASH;

  const special = (mode >> 9) & 0o7;
  const owner = (mode >> 6) & 0o7;
  const group = (mode >> 3) & 0o7;
  const other = mode & 0o7;
  const chars = [RWX[owner], RWX[group], RWX[other]].join('').split('');

  if (special & 4) chars[2] = chars[2] === 'x' ? 's' : 'S';
  if (special & 2) chars[5] = chars[5] === 'x' ? 's' : 'S';
  if (special & 1) chars[8] = chars[8] === 'x' ? 't' : 'T';
  return chars.join('');
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** `\\server\share` (no further component) — a UNC root has no parent. */
const UNC_ROOT = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/;
/** `C:` / `C:\` / `C:/` — a Windows drive root has no parent. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;

/**
 * The containing directory, or `null` when already at a root.
 *
 * Handles POSIX remote paths, POSIX local paths, Windows drive roots (`C:\`)
 * and UNC paths (`\\server\share\dir`). The old implementation tested
 * `length > 3`, so `C:\` produced `C:` and `\\srv\share` walked into nonsense.
 */
export function parentPath(path: string, isRemote: boolean): string | null {
  if (typeof path !== 'string') return null;
  const raw = path.trim();
  if (raw === '') return null;

  if (isRemote) {
    // Remote paths are always POSIX, whatever the server's OS.
    const normalized = raw.replace(/\/+/g, '/').replace(/\/$/, '');
    if (normalized === '' || normalized === '/') return null;
    const cut = normalized.lastIndexOf('/');
    if (cut < 0) return '/';
    return cut === 0 ? '/' : normalized.slice(0, cut);
  }

  // ── Local ──
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    // UNC: \\server\share\a\b
    const unc = raw.replace(/\//g, '\\');
    if (UNC_ROOT.test(unc)) return null;
    const trimmed = unc.replace(/\\+$/, '');
    const cut = trimmed.lastIndexOf('\\');
    const parent = trimmed.slice(0, cut);
    return UNC_ROOT.test(`${parent}\\`) || UNC_ROOT.test(parent) ? parent : parent;
  }

  if (DRIVE_ROOT.test(raw)) return null;

  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    // Windows absolute: C:\Users\me
    const win = raw.replace(/\//g, '\\').replace(/\\+$/, '');
    if (DRIVE_ROOT.test(win)) return null;
    const cut = win.lastIndexOf('\\');
    // C:\Users -> C:\  (keep the separator; "C:" alone is the *current* dir)
    return cut === 2 ? `${win.slice(0, 2)}\\` : win.slice(0, cut);
  }

  // POSIX local
  const normalized = raw.replace(/\/+/g, '/').replace(/\/$/, '');
  if (normalized === '' || normalized === '/') return null;
  const cut = normalized.lastIndexOf('/');
  if (cut < 0) return null;
  return cut === 0 ? '/' : normalized.slice(0, cut);
}

/** Join a parent and a child, mirroring `RemoteFile::join_path` for remotes. */
export function joinPath(parent: string, name: string, isRemote: boolean): string {
  if (isRemote) {
    if (parent === '' ) return `/${name}`;
    return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`;
  }
  const sep = parent.includes('\\') || /^[A-Za-z]:/.test(parent) ? '\\' : '/';
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

/** The last component of a path, for either separator. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

/** Breadcrumb segments with their cumulative paths, for a PathBar. */
export function pathSegments(
  path: string,
  isRemote: boolean,
): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  let current: string | null = path;
  const guard = 256;
  for (let i = 0; current && i < guard; i += 1) {
    out.unshift({ label: baseName(current) || current, path: current });
    const next: string | null = parentPath(current, isRemote);
    if (next === null) break;
    current = next;
  }
  return out;
}

/**
 * Truncate the middle of a long name so both the prefix and the extension stay
 * readable: `a-very-long-filename.tar.gz` → `a-very-lo…tar.gz`.
 */
export function truncateMiddle(text: string, max = 48): string {
  if (text.length <= max) return text;
  const keepEnd = Math.max(6, Math.floor(max / 3));
  const keepStart = max - keepEnd - 1;
  return `${text.slice(0, keepStart)}\u2026${text.slice(-keepEnd)}`;
}

/** Group a `SHA256:…` fingerprint into readable chunks. */
export function chunkFingerprint(fingerprint: string, size = 8): string {
  const [prefix, ...rest] = fingerprint.split(':');
  const body = rest.join(':');
  if (!body) return fingerprint;
  const chunks = body.match(new RegExp(`.{1,${size}}`, 'g')) ?? [body];
  return `${prefix}:${chunks.join(' ')}`;
}
