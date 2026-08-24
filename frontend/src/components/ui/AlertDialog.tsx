import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { useT } from '../../lib/i18n';
import { Button } from './Button';
import { Icon } from './Icon';

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Translated title, e.g. "Delete 3 items?". */
  title: string;
  /** Translated body naming exactly what is at stake. */
  description: ReactNode;
  /**
   * The confirm button's label. **It must name what is being destroyed and how
   * many items** — "Delete 3 items", not "OK". A generic label is how people
   * click through a destructive confirm without reading it.
   */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` (default) for destructive actions; `primary` for benign ones. */
  tone?: 'danger' | 'primary';
  /**
   * Which button gets initial focus. Defaults to `cancel`, so pressing Enter
   * immediately never destroys anything.
   */
  initialFocus?: 'cancel' | 'confirm';
  loading?: boolean;
  onConfirm: () => void;
  /** Extra content between the description and the buttons. */
  children?: ReactNode;
}

/**
 * Destructive confirmation.
 *
 * `@radix-ui/react-alert-dialog` is not installed, so this is built on Radix
 * Dialog with the alertdialog role applied and non-dismissible-by-default
 * semantics: Escape and Cancel both back out, but an outside click does not
 * silently discard the decision.
 */
export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  initialFocus = 'cancel',
  loading = false,
  onConfirm,
  children,
}: AlertDialogProps) {
  const { t } = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const target = initialFocus === 'confirm' ? confirmRef.current : cancelRef.current;
    target?.focus();
  }, [open, initialFocus]);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-overlay-in bg-black/50" />
        <RadixDialog.Content
          role="alertdialog"
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2',
            'rounded border border-border-strong bg-surface p-3 shadow-2xl',
          )}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex gap-2.5">
            <Icon
              name={tone === 'danger' ? 'alert-triangle' : 'alert-circle'}
              size={16}
              className={cn('mt-0.5', tone === 'danger' ? 'text-danger' : 'text-accent')}
            />
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-md font-semibold text-text">
                {title}
              </RadixDialog.Title>
              <RadixDialog.Description asChild>
                <div className="mt-1 text-base text-text-2">{description}</div>
              </RadixDialog.Description>
              {children ? <div className="mt-2">{children}</div> : null}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <RadixDialog.Close asChild>
              <Button ref={cancelRef} variant="secondary" disabled={loading}>
                {cancelLabel ?? t('common.cancel')}
              </Button>
            </RadixDialog.Close>
            <Button
              ref={confirmRef}
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={loading}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
