import { describe, expect, it } from 'vitest';

import { en } from '../lib/locales/en';
import { DEFAULT_SETTINGS, type Settings } from '../store/settingsStore';
import {
  MIN_MASTER_PASSWORD,
  validateBaseUrl,
  validatePasswordChange,
} from './SettingsDialog';

describe('validateBaseUrl', () => {
  it('accepts https anywhere', () => {
    expect(validateBaseUrl('https://api.example.com/v1')).toBe('ok');
    expect(validateBaseUrl('  https://example.com  ')).toBe('ok');
  });

  it('accepts http only on loopback', () => {
    expect(validateBaseUrl('http://localhost:11434')).toBe('ok');
    expect(validateBaseUrl('http://127.0.0.1:11434/v1')).toBe('ok');
    expect(validateBaseUrl('http://[::1]:8080')).toBe('ok');
  });

  it('rejects plaintext http to a remote host — the key travels over it', () => {
    expect(validateBaseUrl('http://api.example.com')).toBe('invalid');
    expect(validateBaseUrl('http://192.168.1.10:8080')).toBe('invalid');
  });

  it('rejects other schemes and embedded credentials', () => {
    expect(validateBaseUrl('ftp://example.com')).toBe('invalid');
    expect(validateBaseUrl('file:///etc/passwd')).toBe('invalid');
    expect(validateBaseUrl('https://user:pw@example.com')).toBe('invalid');
    expect(validateBaseUrl('not a url')).toBe('invalid');
  });

  it('distinguishes empty from invalid, so the field can say which', () => {
    expect(validateBaseUrl('')).toBe('empty');
    expect(validateBaseUrl('   ')).toBe('empty');
  });
});

describe('validatePasswordChange', () => {
  it('requires the current password before anything else', () => {
    expect(validatePasswordChange('', 'longenough1', 'longenough1')).toBe('missingCurrent');
  });

  it('enforces the minimum length', () => {
    expect(validatePasswordChange('old', 'short', 'short')).toBe('tooShort');
    expect(validatePasswordChange('old', 'a'.repeat(MIN_MASTER_PASSWORD - 1), 'x')).toBe(
      'tooShort',
    );
  });

  it('catches a mistyped confirmation', () => {
    expect(validatePasswordChange('old', 'longenough1', 'longenough2')).toBe('mismatch');
  });

  it('passes a well-formed change', () => {
    expect(validatePasswordChange('old', 'longenough1', 'longenough1')).toBe('ok');
  });
});

describe('settings surface', () => {
  /**
   * Guard against the old failure mode: ten settings shown, six of them inert.
   * Every field the dialog exposes must exist in the store, and every store
   * field must be exposed — a field nobody can reach is dead weight.
   */
  const EXPOSED: (keyof Settings)[] = [
    // General
    'locale',
    'theme',
    'dateFormat',
    'defaultProtocol',
    'showHiddenFiles',
    'confirmDelete',
    // Transfers
    'maxConcurrentTransfers',
    'overwriteMode',
    'doubleClickAction',
    'connectTimeoutSecs',
    'ioTimeoutSecs',
    // Editor
    'editorFontSize',
    'editorTabSize',
    'editorWordWrap',
  ];

  it('exposes exactly the settings the store holds', () => {
    expect([...EXPOSED].sort()).toEqual(
      (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).sort(),
    );
  });

  it('has no leftover transferMode setting', () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain('transferMode');
  });

  it('has a label for every tab it renders', () => {
    for (const key of [
      'settings.tab.general',
      'settings.tab.transfers',
      'settings.tab.editor',
      'settings.tab.security',
      'settings.tab.ai',
    ] as const) {
      expect(en[key]).toBeTruthy();
    }
  });
});
