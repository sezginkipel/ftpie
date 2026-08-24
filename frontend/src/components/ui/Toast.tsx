/* eslint-disable react-refresh/only-export-components */
import * as RadixToast from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { errorDetail, errorMessage, useT, type TKey } from '../../lib/i18n';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';

export type ToastVariant = 'info' | 'ok' | 'warn' | 'danger';

export interface ToastOptions {
  /** Translated primary text. */
  title: string;
  /** Optional secondary detail — the place for raw backend text. */
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds. Defaults to 5000, or 9000 for `danger`. */
  duration?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
}

interface ToastApi {
  /** Show a toast; returns its id. */
  toast: (options: ToastOptions) => number;
  /**
   * Show an error toast for an unknown rejection: localized sentence as the
   * title, the backend's English `message` as the detail. Use this in every
   * `catch` so no failure is silent.
   */
  showError: (error: unknown, titleKey?: TKey) => number;
  dismiss: (id: number) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Per-variant styling is a coloured leading edge plus a matching icon — not a
 * tinted surface. A fully tinted toast reads as an alert box and, stacked four
 * deep, turns the corner of the screen into a traffic light; the edge carries the
 * same information while every toast still looks like the same object.
 */
const VARIANT_STYLE: Record<ToastVariant, { edge: string; icon: IconName; tone: string }> = {
  info: { edge: 'bg-info', icon: 'info', tone: 'text-info' },
  ok: { edge: 'bg-ok', icon: 'check', tone: 'text-ok' },
  warn: { edge: 'bg-warn', icon: 'alert-triangle', tone: 'text-warn' },
  danger: { edge: 'bg-danger', icon: 'alert-circle', tone: 'text-danger' },
};

let nextId = 1;

/**
 * Toast host. Mount once, inside `I18nProvider`.
 *
 * Auto-dismiss is delegated to Radix's own per-toast duration rather than our
 * own `setTimeout`s: the old implementation shared one timer variable across
 * toasts, so each new toast cancelled the previous one's dismissal and left
 * stale messages on screen. Radix also renders the viewport as a live region,
 * so a screen reader announces every toast.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismissAll = useCallback(() => setToasts([]), []);

  const toast = useCallback((options: ToastOptions) => {
    const id = nextId;
    nextId += 1;
    setToasts((current) => {
      const next = [...current, { ...options, id }];
      // Keep the stack bounded; a failing loop must not fill the screen.
      return next.length > 5 ? next.slice(next.length - 5) : next;
    });
    return id;
  }, []);

  const showError = useCallback(
    (error: unknown, titleKey?: TKey) => {
      const detail = errorDetail(error);
      const primary = titleKey ? t(titleKey) : errorMessage(error, t);
      return toast({
        title: primary,
        description: detail && detail !== primary ? detail : undefined,
        variant: 'danger',
      });
    },
    [t, toast],
  );

  const api = useMemo<ToastApi>(
    () => ({ toast, showError, dismiss, dismissAll }),
    [toast, showError, dismiss, dismissAll],
  );

  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider swipeDirection="right" duration={5000}>
        {children}

        {toasts.map((item) => {
          const variant = item.variant ?? 'info';
          const style = VARIANT_STYLE[variant];
          return (
            <RadixToast.Root
              key={item.id}
              duration={item.duration ?? (variant === 'danger' ? 9000 : 5000)}
              onOpenChange={(open) => {
                if (!open) dismiss(item.id);
              }}
              className={cn(
                'raised relative flex items-start gap-2.5 overflow-hidden',
                'animate-toast-in rounded-lg py-2.5 pl-4 pr-2 shadow-e3',
                'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]',
              )}
            >
              {/* The variant's leading edge. Decorative: the icon and the text
                  already carry the meaning. */}
              <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', style.edge)} />
              <Icon name={style.icon} className={cn('mt-[3px] flex-none', style.tone)} />
              <div className="min-w-0 flex-1">
                <RadixToast.Title className="text-base font-medium tracking-tight text-text">
                  {item.title}
                </RadixToast.Title>
                {item.description ? (
                  <RadixToast.Description className="mt-1 break-words font-mono text-xs leading-snug text-text-3">
                    {item.description}
                  </RadixToast.Description>
                ) : null}
              </div>
              <RadixToast.Close asChild>
                <IconButton label={t('toast.close')} icon={<Icon name="x" />} />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}

        <RadixToast.Viewport
          label={t('toast.region')}
          className="fixed bottom-3 right-3 z-[60] flex w-[22rem] max-w-[92vw] flex-col gap-2 outline-none"
        />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

/**
 * Access the toast API.
 *
 * Outside a `ToastProvider` this returns inert no-ops rather than throwing, so
 * a unit test of a component that reports errors does not need the whole host.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  return (
    ctx ?? {
      toast: () => 0,
      showError: () => 0,
      dismiss: () => {},
      dismissAll: () => {},
    }
  );
}
