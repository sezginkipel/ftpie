import { beforeEach, describe, expect, it } from 'vitest';

import { clearInvokeMocks, invokeCalls, mockInvoke } from '../test/setup';
import { call, errorCode, isAppError, toAppError } from './ipc';
import type { AppError } from './types';

beforeEach(() => {
  clearInvokeMocks();
});

describe('call — success path', () => {
  it('returns the command result and forwards the arguments verbatim', async () => {
    mockInvoke('list_transfers', () => [{ id: 't1' }]);
    await expect(call('list_transfers')).resolves.toEqual([{ id: 't1' }]);

    mockInvoke('connect', (args) => args);
    await expect(call('connect', { args: { host: 'a' } })).resolves.toEqual({
      args: { host: 'a' },
    });
    expect(invokeCalls.at(-1)).toEqual({
      cmd: 'connect',
      args: { args: { host: 'a' } },
    });
  });
});

describe('call — error normalization', () => {
  it('passes a well-formed AppError through with its variant fields intact', async () => {
    const original: AppError = {
      code: 'untrusted_host',
      host: 'example.com',
      port: 22,
      kind: 'ssh_host_key',
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      previousFingerprint: 'SHA256:old',
      message: 'host key changed',
    };
    mockInvoke('connect', () => {
      throw original;
    });

    await expect(call('connect')).rejects.toEqual(original);

    // The fields the trust dialog depends on must survive normalization.
    try {
      await call('connect');
      expect.unreachable('should have rejected');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      const err = error as AppError & { code: 'untrusted_host' };
      expect(err.previousFingerprint).toBe('SHA256:old');
      expect(err.fingerprint).toBe('SHA256:abc');
    }
  });

  it('keeps the conflict variant’s remoteHash', async () => {
    mockInvoke('editor_save_file', () => {
      throw { code: 'conflict', message: 'changed', remoteHash: 'deadbeef' };
    });
    try {
      await call('editor_save_file');
      expect.unreachable('should have rejected');
    } catch (error) {
      const err = error as AppError & { code: 'conflict' };
      expect(err.code).toBe('conflict');
      expect(err.remoteHash).toBe('deadbeef');
    }
  });

  it('turns a bare string rejection into an internal AppError', async () => {
    // This is the real failure mode: an unregistered command or a plugin fault
    // rejects with a string, and a raw string must never reach a component.
    await expect(call('no_such_command')).rejects.toEqual({
      code: 'internal',
      message: 'Command no_such_command not found',
    });

    try {
      await call('no_such_command');
      expect.unreachable('should have rejected');
    } catch (error) {
      expect(typeof error).toBe('object');
      expect(isAppError(error)).toBe(true);
      expect(errorCode(error)).toBe('internal');
    }
  });

  it('keeps a plain message when there is no code to report', async () => {
    mockInvoke('plain', () => {
      throw { message: 'just a message' };
    });
    await expect(call('plain')).rejects.toEqual({
      code: 'internal',
      message: 'just a message',
    });
  });

  it('normalizes an Error instance', async () => {
    mockInvoke('boom', () => {
      throw new Error('serialization failed');
    });
    await expect(call('boom')).rejects.toEqual({
      code: 'internal',
      message: 'serialization failed',
    });
  });

  it('normalizes an unexpected object that only looks a bit like an error', async () => {
    mockInvoke('weird', () => {
      throw { code: 'not_a_real_code', message: 'nope' };
    });
    const rejection = await call('weird').catch((e: unknown) => e);
    expect(isAppError(rejection)).toBe(true);
    expect(errorCode(rejection)).toBe('internal');
    // The original payload is preserved as detail, not discarded.
    expect((rejection as AppError).message).toContain('not_a_real_code');
  });

  it('normalizes an object with a code but no message', async () => {
    mockInvoke('halfway', () => {
      throw { code: 'network' };
    });
    const rejection = await call('halfway').catch((e: unknown) => e);
    expect(errorCode(rejection)).toBe('internal');
  });

  it('normalizes null, undefined and primitives', async () => {
    for (const thrown of [null, undefined, 42, false]) {
      mockInvoke('odd', () => {
        throw thrown;
      });
      const rejection = await call('odd').catch((e: unknown) => e);
      expect(isAppError(rejection)).toBe(true);
      expect(errorCode(rejection)).toBe('internal');
      expect(typeof (rejection as AppError).message).toBe('string');
    }
  });
});

describe('isAppError / errorCode / toAppError', () => {
  it('recognises every documented code', () => {
    const codes = [
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
    for (const code of codes) {
      expect(isAppError({ code, message: 'x' })).toBe(true);
      expect(errorCode({ code, message: 'x' })).toBe(code);
    }
  });

  it('rejects anything that is not a structured backend error', () => {
    for (const value of [null, undefined, 'string', 42, [], {}, { code: 'nope' }]) {
      expect(isAppError(value)).toBe(false);
      expect(errorCode(value)).toBeNull();
    }
  });

  it('toAppError is idempotent on a real AppError', () => {
    const error: AppError = { code: 'timeout', message: 'slow' };
    expect(toAppError(error)).toBe(error);
  });
});
