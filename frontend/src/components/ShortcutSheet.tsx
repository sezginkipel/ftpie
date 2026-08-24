/* eslint-disable react-refresh/only-export-components */
/**
 * ShortcutSheet — every keyboard shortcut, grouped, in one dialog.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <ShortcutSheet open={dialog.kind === 'shortcuts'} onOpenChange={…} />
 * ```
 * Opened with `?` or from the menu. {@link SHORTCUT_GROUPS} is the single list
 * the shell should register against, so the sheet and the handlers cannot drift
 * apart: F2 can import it and bind from the same data.
 *
 * `Kbd` renders `Mod` as ⌘ on macOS and Ctrl elsewhere, so nothing here branches
 * per platform.
 */
import { useT } from '../lib/i18n';
import type { TKey } from '../lib/i18n';
import { Dialog, Kbd } from './ui';

export interface ShortcutEntry {
  /** Shortcut in `Mod+Shift+T` form — `Mod` is ⌘ on macOS, Ctrl elsewhere. */
  keys: string;
  /** i18n key for what it does. */
  label: TKey;
}

export interface ShortcutGroup {
  /** i18n key for the group heading. */
  heading: TKey;
  entries: ShortcutEntry[];
}

/** The authoritative shortcut list. Bind handlers from this, not from memory. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    heading: 'shortcut.group.global',
    entries: [
      { keys: 'Mod+N', label: 'shortcut.newConnection' },
      { keys: 'Mod+,', label: 'shortcut.settings' },
      { keys: 'F5', label: 'shortcut.refresh' },
      { keys: 'Mod+Shift+T', label: 'shortcut.closeSession' },
      { keys: 'Mod+Q', label: 'shortcut.quit' },
      { keys: '?', label: 'shortcut.showShortcuts' },
    ],
  },
  {
    heading: 'shortcut.group.files',
    entries: [
      { keys: 'Tab', label: 'shortcut.switchPane' },
      { keys: 'Up', label: 'shortcut.moveSelection' },
      { keys: 'Shift+Up', label: 'shortcut.extendSelection' },
      { keys: 'Mod+A', label: 'shortcut.selectAll' },
      { keys: 'Space', label: 'shortcut.toggleSelect' },
      { keys: 'Enter', label: 'shortcut.openItem' },
      { keys: 'Backspace', label: 'shortcut.goUp' },
      { keys: 'Delete', label: 'shortcut.delete' },
      { keys: 'F2', label: 'shortcut.rename' },
      { keys: 'Mod+C', label: 'shortcut.copyPath' },
      { keys: 'A', label: 'shortcut.typeAhead' },
    ],
  },
  {
    heading: 'shortcut.group.transfers',
    entries: [{ keys: 'Mod+Enter', label: 'shortcut.transfer' }],
  },
  {
    heading: 'shortcut.group.editor',
    entries: [
      { keys: 'Mod+S', label: 'shortcut.save' },
      { keys: 'Mod+W', label: 'shortcut.closeTab' },
    ],
  },
  {
    heading: 'shortcut.group.panels',
    entries: [
      { keys: 'Mod+B', label: 'app.toggleSidebar' },
      { keys: 'Mod+J', label: 'app.toggleTransfers' },
      { keys: 'Mod+E', label: 'app.toggleEditor' },
      { keys: 'Mod+G', label: 'app.toggleGit' },
      { keys: 'Mod+I', label: 'app.toggleAi' },
    ],
  },
];

export interface ShortcutSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutSheet({ open, onOpenChange }: ShortcutSheetProps) {
  const { t } = useT();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t('shortcut.title')}
      description={t('shortcut.intro')}
    >
      {/*
       * One card per group. The heading is chrome on the card, so the eye can
       * jump between groups instead of reading one long undifferentiated list.
       */}
      <div className="grid gap-3 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((group) => (
          <section
            key={group.heading}
            className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-e1"
          >
            <h3 className="flex-none border-b border-border bg-surface-2 px-2.5 py-1.5 text-2xs font-semibold uppercase tracking-wider text-text-3">
              {t(group.heading)}
            </h3>
            <dl className="flex flex-col">
              {group.entries.map((entry) => (
                <div
                  key={`${group.heading}:${entry.keys}`}
                  className="flex h-7 items-center justify-between gap-3 border-b border-border px-2.5 transition-quick last:border-b-0 hover:bg-surface-2"
                >
                  <dt className="min-w-0 truncate text-base text-text-2">{t(entry.label)}</dt>
                  <dd className="flex-none">
                    <Kbd keys={entry.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
