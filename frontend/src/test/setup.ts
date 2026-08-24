/**
 * Vitest setup.
 *
 * The Tauri bridges (`@tauri-apps/api/core`'s `invoke` and
 * `@tauri-apps/api/event`'s `listen`) only exist inside a Tauri window, so they
 * are mocked here and every store test runs headless. `@testing-library/jest-dom`
 * is not installed, so a small set of the matchers we actually use is registered
 * by hand rather than pulling in a dependency the lead did not approve.
 */
import { afterEach, expect, vi } from 'vitest';

// ── Tauri IPC ────────────────────────────────────────────────────────────────

/** Per-command handlers a test installs with {@link mockInvoke}. */
const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();

/** Every call made through the mocked bridge, in order. */
export const invokeCalls: { cmd: string; args?: Record<string, unknown> }[] = [];

export const invokeMock = vi.fn(
  async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    invokeCalls.push({ cmd, args });
    const handler = handlers.get(cmd);
    if (!handler) {
      // Mirror the real bridge: an unregistered command rejects with a string,
      // which is exactly the case `ipc.call` has to normalize.
      throw `Command ${cmd} not found`;
    }
    return handler(args ?? {});
  },
);

/**
 * Register a response (or a thrower) for one command. Return value may be a
 * value or a promise; throwing simulates a rejection.
 */
export function mockInvoke(
  cmd: string,
  handler: (args: Record<string, unknown>) => unknown,
): void {
  handlers.set(cmd, handler);
}

export function clearInvokeMocks(): void {
  handlers.clear();
  invokeCalls.length = 0;
  invokeMock.mockClear();
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

// ── Tauri events ─────────────────────────────────────────────────────────────

type Listener = (event: { payload: unknown }) => void;

const listeners = new Map<string, Set<Listener>>();
/** How many times `listen` was called, per event — proves single-subscription. */
export const listenCounts = new Map<string, number>();

export const listenMock = vi.fn(async (event: string, handler: Listener) => {
  listenCounts.set(event, (listenCounts.get(event) ?? 0) + 1);
  const set = listeners.get(event) ?? new Set<Listener>();
  set.add(handler);
  listeners.set(event, set);
  return () => {
    set.delete(handler);
  };
});

/** Fire a Tauri event at everything currently listening. */
export function emitTauriEvent(event: string, payload: unknown): void {
  for (const handler of listeners.get(event) ?? []) {
    handler({ payload });
  }
}

export function clearTauriEvents(): void {
  listeners.clear();
  listenCounts.clear();
  listenMock.mockClear();
}

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: Listener) => listenMock(event, handler),
}));

// ── Minimal jest-dom-style matchers ──────────────────────────────────────────

expect.extend({
  toBeInTheDocument(received: unknown) {
    const attached =
      received instanceof HTMLElement && document.body.contains(received);
    return {
      pass: attached,
      message: () =>
        attached
          ? 'expected element not to be in the document'
          : 'expected element to be in the document',
    };
  },

  toHaveAttribute(received: unknown, name: string, value?: string) {
    if (!(received instanceof HTMLElement)) {
      return { pass: false, message: () => 'expected an HTMLElement' };
    }
    const actual = received.getAttribute(name);
    const pass = value === undefined ? actual !== null : actual === value;
    return {
      pass,
      message: () =>
        `expected attribute ${name}${value === undefined ? '' : `="${value}"`}, got ${
          actual === null ? '(absent)' : `"${actual}"`
        }`,
    };
  },

  toHaveTextContent(received: unknown, expected: string) {
    if (!(received instanceof HTMLElement)) {
      return { pass: false, message: () => 'expected an HTMLElement' };
    }
    const text = received.textContent ?? '';
    return {
      pass: text.includes(expected),
      message: () => `expected text to contain "${expected}", got "${text}"`,
    };
  },
});

// ── Browser APIs jsdom does not implement ────────────────────────────────────

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  clearInvokeMocks();
  clearTauriEvents();
  localStorage.clear();
});
