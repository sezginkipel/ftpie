/**
 * The single IPC boundary. **No other module may import `invoke`.**
 *
 * The backend always rejects with a serialized `AppError`, but a plugin fault,
 * a serialization failure or a thrown JS error can produce a bare string or an
 * arbitrary object. `call` normalizes every rejection into a well-formed
 * `AppError` so a component can always read `e.code` and `e.message`.
 */
import { invoke } from '@tauri-apps/api/core';

import type { AppError, AppErrorCode } from './types';

const CODES: readonly AppErrorCode[] = [
  'untrusted_host',
  'vault_locked',
  'auth',
  'network',
  'timeout',
  'not_found',
  'permission',
  'conflict',
  'protocol',
  'io',
  'config',
  'cancelled',
  'internal',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** True when `e` is a structured backend error with a known `code`. */
export function isAppError(e: unknown): e is AppError {
  if (!isRecord(e)) return false;
  const code = e.code;
  return (
    typeof code === 'string' &&
    CODES.includes(code as AppErrorCode) &&
    typeof e.message === 'string'
  );
}

/** The error code, or `null` when `e` is not a structured backend error. */
export function errorCode(e: unknown): AppErrorCode | null {
  return isAppError(e) ? e.code : null;
}

/** Best-effort human detail for something that is not an `AppError`. */
function describeUnknown(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (isRecord(e)) {
    if (typeof e.message === 'string') {
      // An unrecognised `code` alongside a message usually means a frontend /
      // backend version mismatch. Keep it in the detail so that is diagnosable
      // instead of silently reading as a generic internal error.
      return typeof e.code === 'string' ? `${e.code}: ${e.message}` : e.message;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return Object.prototype.toString.call(e);
    }
  }
  if (e === undefined) return 'the command rejected without a reason';
  return String(e);
}

/**
 * Coerce anything a rejection can carry into an `AppError`.
 *
 * A rejection that already looks like an `AppError` is returned untouched so
 * variant fields (`fingerprint`, `remoteHash`, …) survive. Anything else
 * becomes `internal`, which the UI renders as an unexpected failure with the
 * raw detail available behind a disclosure.
 */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return { code: 'internal', message: describeUnknown(e) };
}

/** Debug logging, opt-in so a production console stays quiet. */
const DEBUG =
  typeof localStorage !== 'undefined' && localStorage.getItem('ftpie-debug-ipc') === '1';

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  console.warn('[ipc]', ...args);
}

/**
 * Invoke a Tauri command.
 *
 * @throws {AppError} always — never a bare string, never an `Error`.
 */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    const result = await invoke<T>(cmd, args);
    debug('ok', cmd);
    return result;
  } catch (raw) {
    const err = toAppError(raw);
    debug('fail', cmd, err.code, err.message, raw);
    throw err;
  }
}

/** Namespace form, so callers can write `ipc.call(...)`. */
export const ipc = { call, isAppError, errorCode, toAppError };
