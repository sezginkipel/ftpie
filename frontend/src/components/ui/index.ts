/**
 * Accessible, theme-aware UI primitives.
 *
 * Import from here: `import { Button, Dialog, useToast } from '@/components/ui'`
 * (or the relative equivalent). Every primitive is keyboard-operable, takes its
 * colours from the CSS tokens, and expects already-translated strings — none of
 * them calls `t()` on your behalf except for their own built-in chrome
 * (close buttons, "show details", and the like).
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { Icon, type IconProps, type IconName } from './Icon';
export { Spinner, type SpinnerProps } from './Spinner';

export { Field, controlClass, type FieldProps } from './Field';
export { Input, type InputProps } from './Input';
export { NumberInput, type NumberInputProps } from './NumberInput';
export { Select, type SelectProps, type SelectOption } from './Select';
export { Checkbox, type CheckboxProps } from './Checkbox';
export { Switch, type SwitchProps } from './Switch';
export { Textarea, type TextareaProps } from './Textarea';

export { Dialog, type DialogProps, type DialogSize } from './Dialog';
export { AlertDialog, type AlertDialogProps } from './AlertDialog';
export { Menu, menuContentClass, menuItemClass, type MenuProps, type MenuItem } from './Menu';
export { ContextMenu, type ContextMenuProps } from './ContextMenu';
export { Tooltip, TooltipProvider, type TooltipProps } from './Tooltip';
export {
  ToastProvider,
  useToast,
  type ToastOptions,
  type ToastVariant,
} from './Toast';

export { ProgressBar, type ProgressBarProps, type ProgressTone } from './ProgressBar';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { Kbd, type KbdProps } from './Kbd';
export { Separator, type SeparatorProps } from './Separator';
export { Tabs, type TabsProps, type TabDefinition } from './Tabs';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ErrorState, InlineError, type ErrorStateProps } from './ErrorState';
