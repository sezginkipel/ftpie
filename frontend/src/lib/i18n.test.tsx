import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, I18nProvider, errorDetail, errorMessage, translate } from './i18n';
import { en } from './locales/en';
import { tr } from './locales/tr';
import type { AppError, AppErrorCode, Locale } from './types';

const LOCALES: Locale[] = ['tr', 'en'];

const ALL_CODES: AppErrorCode[] = [
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

/** A minimal valid AppError for each code. */
function sample(code: AppErrorCode): AppError {
  switch (code) {
    case 'untrusted_host':
      return {
        code,
        host: 'example.com',
        port: 22,
        kind: 'ssh_host_key',
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:abc',
        previousFingerprint: null,
        message: 'unknown host key',
      };
    case 'not_found':
      return { code, path: '/var/www/gone.txt', message: 'no such file' };
    case 'conflict':
      return { code, message: 'changed on the server', remoteHash: 'abc' };
    default:
      return { code, message: 'backend detail' } as AppError;
  }
}

describe('dictionaries', () => {
  it('defines the default locale as English', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('has exactly the same key set in both languages', () => {
    // The type system already guarantees this; the test guards against someone
    // widening the Dictionary type to escape the check.
    const enKeys = Object.keys(en).sort();
    const trKeys = Object.keys(tr).sort();
    expect(trKeys).toEqual(enKeys);
  });

  it('has no empty or placeholder-only values', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(locale === 'en' ? en : tr)) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('keeps the same placeholders on both sides of every translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(tr[key]), `mismatched placeholders in "${key}"`).toEqual(
        placeholders(en[key]),
      );
    }
  });
});

describe('translate', () => {
  it('returns the string for the requested locale', () => {
    expect(translate('en', 'common.cancel')).toBe('Cancel');
    expect(translate('tr', 'common.cancel')).toBe('Vazgeç');
  });

  it('interpolates {name} placeholders', () => {
    expect(translate('en', 'common.items', { count: 3 })).toBe('3 items');
    expect(translate('tr', 'common.items', { count: 3 })).toBe('3 öğe');
  });

  it('leaves an unsupplied placeholder visible rather than printing "undefined"', () => {
    expect(translate('en', 'common.items', {})).toBe('{count} items');
  });

  it('substitutes every occurrence and coerces numbers', () => {
    expect(translate('en', 'git.aheadBehind', { ahead: 2, behind: 0 })).toBe('2 ahead, 0 behind');
  });
});

describe('errorMessage', () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
    translate('tr', key, vars);

  it('returns a localized, non-empty sentence for every code', () => {
    for (const code of ALL_CODES) {
      const message = errorMessage(sample(code), t);
      expect(message, code).toBeTruthy();
      // Never fall through to the raw key, and never echo the English detail.
      expect(message, code).not.toContain('error.');
      expect(message, code).not.toBe('backend detail');
    }
  });

  it('distinguishes a changed fingerprint from a first-time one', () => {
    const unknown = sample('untrusted_host');
    const changed = { ...unknown, previousFingerprint: 'SHA256:old' } as AppError;
    const unknownText = errorMessage(unknown, t);
    const changedText = errorMessage(changed, t);

    expect(changedText).not.toBe(unknownText);
    // A possible interception must say so in the strongest terms available.
    expect(changedText).toMatch(/DEĞİŞTİ/);
  });

  it('names the missing path when the backend supplied one', () => {
    expect(errorMessage(sample('not_found'), t)).toContain('/var/www/gone.txt');
  });

  it('falls back to a generic not-found sentence without a path', () => {
    const message = errorMessage({ code: 'not_found', path: '', message: 'gone' }, t);
    expect(message).toBe(translate('tr', 'error.not_found.generic'));
  });

  it('reports an unrecognised rejection as an internal error, not a crash', () => {
    for (const value of [null, undefined, 'raw string', 42, {}]) {
      expect(errorMessage(value, t)).toBe(translate('tr', 'error.internal'));
    }
  });

  it('produces a different sentence in each language', () => {
    const error = sample('network');
    const inTr = errorMessage(error, (k, v) => translate('tr', k, v));
    const inEn = errorMessage(error, (k, v) => translate('en', k, v));
    expect(inTr).not.toBe(inEn);
  });
});

describe('errorDetail', () => {
  it('surfaces the English backend message as secondary detail', () => {
    expect(errorDetail(sample('network'))).toBe('backend detail');
  });

  it('handles Errors and strings', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail('boom')).toBe('boom');
  });

  it('returns null when there is nothing useful to show', () => {
    expect(errorDetail(null)).toBeNull();
    expect(errorDetail(42)).toBeNull();
  });
});

describe('<html lang>', () => {
  /*
   * `text-transform: uppercase` follows the document language, so a stale
   * `lang` silently corrupts casing: with lang="tr", the English column header
   * MODIFIED renders as MODİFİED. Nothing throws and no test of the string
   * itself would catch it, which is why this asserts on the attribute.
   */
  it.each(LOCALES)('tracks the active locale (%s)', (locale) => {
    document.documentElement.lang = 'zz';
    render(<I18nProvider locale={locale}>ok</I18nProvider>);
    expect(document.documentElement.lang).toBe(locale);
  });
});
