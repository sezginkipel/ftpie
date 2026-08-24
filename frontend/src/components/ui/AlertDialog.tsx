import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { useT } from '../../lib/i18n';
import { Button } from './Button';
import { dialogOverlayClass } from './Dialog';
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
 *
 * Visually it is a smaller sibling of {@link Dialog} — same raised surface, same
 * entrance, same right-aligned footer — with the tone icon in a tinted disc so
 * the severity registers before the words do.
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

  const danger = tone === 'danger';

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={dialogOverlayClass} />
        <RadixDialog.Content
          role="alertdialog"
          className={cn(
            'raised fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(92vw,28rem)]',
            '-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl',
            'animate-dialog-in shadow-e3',
          )}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-4">
            <div className="flex gap-3">
              <span
                aria-hidden
                className={cn(
                  'flex h-8 w-8 flex-none items-center justify-center rounded-full',
                  danger ? 'bg-danger-weak text-danger' : 'bg-accent-weak text-accent',
                )}
              >
                <Icon name={danger ? 'alert-triangle' : 'alert-circle'} size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <RadixDialog.Title className="text-md font-semibold tracking-tight text-text">
                  {title}
                </RadixDialog.Title>
                <RadixDialog.Description asChild>
                  <div className="mt-1.5 text-base leading-snug text-text-2">{description}</div>
                </RadixDialog.Description>
                {children ? <div className="mt-3">{children}</div> : null}
              </div>
            </div>
          </div>

          <div className="flex flex-none items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-3">
            <RadixDialog.Close asChild>
              <Button ref={cancelRef} variant="secondary" disabled={loading}>
                {cancelLabel ?? t('common.cancel')}
              </Button>
            </RadixDialog.Close>
            <Button
              ref={confirmRef}
              variant={danger ? 'danger' : 'primary'}
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
