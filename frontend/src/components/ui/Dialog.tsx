import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { useT } from '../../lib/i18n';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

/**
 * The scrim. Blurring it — rather than only darkening it — is what makes the
 * dialog read as floating above the app instead of pasted onto a screenshot of
 * it, and it stops a busy file listing competing with the dialog for attention.
 */
export const dialogOverlayClass =
  'fixed inset-0 z-40 animate-overlay-in bg-black/45 backdrop-blur-sm';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Translated title. Becomes the dialog's accessible name. */
  title: string;
  /**
   * Translated description. Radix wires it as the accessible description, so a
   * dialog without one is announced as bare — supply it whenever there is
   * anything to say.
   */
  description?: string;
  size?: DialogSize;
  /** Rendered in the footer, right-aligned. */
  footer?: ReactNode;
  /** Extra content between the title and the close button. */
  headerExtra?: ReactNode;
  /** Set false for a dialog whose only exits are its own buttons. */
  showClose?: boolean;
  /** Prevent Escape and outside-click dismissal (use sparingly). */
  dismissible?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Radix Dialog: focus trap, Escape to close, focus restored on close, and a
 * labelled title and description. Never use `window.confirm`/`prompt` — every
 * prompt in this app is one of these.
 *
 * Layout is a fixed three-band rhythm — header, scrolling body, footer — held
 * inside `max-h-[min(85vh,44rem)]`. The body is the only scroller, so a long
 * settings page never pushes the footer buttons off a small window, and the
 * header/footer hairlines give the eye two stable anchors.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  footer,
  headerExtra,
  showClose = true,
  dismissible = true,
  className,
  children,
}: DialogProps) {
  const { t } = useT();

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={dialogOverlayClass} />
        <RadixDialog.Content
          className={cn(
            'raised fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2',
            'w-[min(92vw,100%)] flex-col overflow-hidden rounded-xl',
            'max-h-[min(85vh,44rem)] animate-dialog-in shadow-e3',
            SIZES[size],
            className,
          )}
          onEscapeKeyDown={dismissible ? undefined : (e) => e.preventDefault()}
          onPointerDownOutside={dismissible ? undefined : (e) => e.preventDefault()}
          onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
        >
          <header className="flex flex-none items-start gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="truncate text-lg font-semibold tracking-tight text-text">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-sm leading-snug text-text-2">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            {headerExtra}
            {showClose ? (
              <RadixDialog.Close asChild>
                <IconButton
                  label={t('common.close')}
                  icon={<Icon name="x" />}
                  className="-mr-1 mt-px"
                />
              </RadixDialog.Close>
            ) : null}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            {children}
          </div>

          {footer ? (
            <footer
              className={cn(
                'flex flex-none flex-wrap items-center justify-end gap-2',
                // Quieter than the body, like a real window's command strip.
                'border-t border-border bg-surface-2 px-4 py-3',
              )}
            >
              {footer}
            </footer>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
