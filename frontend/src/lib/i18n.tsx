/* eslint-disable react-refresh/only-export-components */
/**
 * Dependency-free typed i18n.
 *
 * `TKey` is derived from the English dictionary, so a key that exists in `en`
 * and not in `tr` fails to compile. Every user-visible string in the app goes
 * through `t()` — including error text, empty states, button labels, tooltips
 * and `aria-label`s.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { en, type TKey } from './locales/en';
import { tr } from './locales/tr';
import { isAppError } from './ipc';
import type { AppError, Locale } from './types';

export type { TKey } from './locales/en';
export type { Locale } from './types';

const DICTIONARIES: Record<Locale, Record<TKey, string>> = { en, tr };

export const LOCALES: readonly Locale[] = ['tr', 'en'];
export const DEFAULT_LOCALE: Locale = 'en';

export type TVars = Record<string, string | number>;

/** Translate a key with `{name}` interpolation. */
export type TFunction = (key: TKey, vars?: TVars) => string;

export function translate(locale: Locale, key: TKey, vars?: TVars): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
  // The English dictionary is the fallback so a mid-migration gap degrades to
  // English rather than to a raw key.
  const template = dict[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

interface I18nContextValue {
  t: TFunction;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  children: ReactNode;
  /** Initial locale. Defaults to {@link DEFAULT_LOCALE}. */
  locale?: Locale;
  /** Called when the locale changes, so the settings store can persist it. */
  onLocaleChange?: (locale: Locale) => void;
}

export function I18nProvider({ children, locale: controlled, onLocaleChange }: I18nProviderProps) {
  const [internal, setInternal] = useState<Locale>(controlled ?? DEFAULT_LOCALE);
  const locale = controlled ?? internal;

  const setLocale = useCallback(
    (next: Locale) => {
      setInternal(next);
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );

  /*
   * Keep `<html lang>` on the active locale.
   *
   * This is not cosmetic. `text-transform: uppercase` is locale-sensitive, and
   * the document was hardcoded to `lang="tr"`, so every uppercased English
   * label rendered with a dotted capital: MODIFIED came out as MODİFİED. It
   * also drives hyphenation, spellcheck and what a screen reader announces.
   */
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Access `t`, the current locale, and the locale setter.
 *
 * Falls back to the default locale outside a provider so an isolated component
 * test does not have to wrap everything.
 */
export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return {
    locale: DEFAULT_LOCALE,
    setLocale: () => {},
    t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
  };
}

/**
 * The localized, actionable sentence for a backend error.
 *
 * The backend `message` is English and belongs in secondary detail (an
 * `ErrorState` disclosure or a toast's detail line) — never as the primary text
 * a user reads. Anything that is not a recognised `AppError` is described as an
 * unexpected internal failure rather than dumped raw.
 */
export function errorMessage(e: unknown, t: TFunction): string {
  if (!isAppError(e)) return t('error.internal');
  const err: AppError = e;

  switch (err.code) {
    case 'untrusted_host':
      return err.previousFingerprint
        ? t('error.untrusted_host.changed')
        : t('error.untrusted_host');
    case 'vault_locked':
      return t('error.vault_locked');
    case 'auth':
      return t('error.auth');
    case 'network':
      return t('error.network');
    case 'timeout':
      return t('error.timeout');
    case 'not_found':
      return err.path ? t('error.not_found', { path: err.path }) : t('error.not_found.generic');
    case 'permission':
      return t('error.permission');
    case 'conflict':
      return t('error.conflict');
    case 'protocol':
      return t('error.protocol');
    case 'io':
      return t('error.io');
    case 'config':
      return t('error.config');
    case 'cancelled':
      return t('error.cancelled');
    case 'internal':
      return t('error.internal');
  }
}

/** The English backend detail, for a disclosure beneath {@link errorMessage}. */
export function errorDetail(e: unknown): string | null {
  if (isAppError(e)) return e.message || null;
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return null;
}
