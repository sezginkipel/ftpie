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
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-overlay-in bg-black/50" />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[92vw] -translate-x-1/2 -translate-y-1/2',
            'flex-col rounded border border-border-strong bg-surface shadow-2xl',
            SIZES[size],
            className,
          )}
          onEscapeKeyDown={dismissible ? undefined : (e) => e.preventDefault()}
          onPointerDownOutside={dismissible ? undefined : (e) => e.preventDefault()}
          onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
        >
          <header className="flex flex-none items-start gap-2 border-b border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="truncate text-md font-semibold text-text">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-0.5 text-sm text-text-2">
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
                  className="mt-0.5"
                />
              </RadixDialog.Close>
            ) : null}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{children}</div>

          {footer ? (
            <footer className="flex flex-none items-center justify-end gap-2 border-t border-border px-3 py-2">
              {footer}
            </footer>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
