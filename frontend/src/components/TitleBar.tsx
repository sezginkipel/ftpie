/**
 * The 40px top bar: identity, session tabs, connect, panel toggles, settings.
 *
 * Every control has an accessible name and a keyboard shortcut hint where one
 * exists; the panel toggles are checkbox-like buttons with `aria-pressed` so
 * their state is announced.
 *
 * Visually this is the top of the chrome stack, so it is the only surface that
 * sits above the panels: `bg-surface-2`, one hairline underneath, and no
 * elevation of its own — the panels below are what should look lifted.
 */
import { cn } from '../lib/cn';
import { useT } from '../lib/i18n';
import { useUiStore, type PanelName } from '../store/uiStore';
import { Button, Icon, IconButton, Kbd, Tooltip, type IconName } from './ui';
import { SessionTabBar } from './SessionTabBar';
import type { TKey } from '../lib/i18n';

interface Toggle {
  panel: PanelName;
  icon: IconName;
  labelKey: TKey;
  shortcut?: string;
}

/** Shortcuts here must match `SHORTCUT_GROUPS` in `ShortcutSheet.tsx`. */
const TOGGLES: readonly Toggle[] = [
  { panel: 'sidebar', icon: 'panel', labelKey: 'app.toggleSidebar', shortcut: 'Mod+B' },
  { panel: 'transfers', icon: 'list', labelKey: 'app.toggleTransfers', shortcut: 'Mod+J' },
  { panel: 'editor', icon: 'file-text', labelKey: 'app.toggleEditor', shortcut: 'Mod+E' },
  { panel: 'git', icon: 'git-branch', labelKey: 'app.toggleGit', shortcut: 'Mod+G' },
  { panel: 'ai', icon: 'sparkles', labelKey: 'app.toggleAi', shortcut: 'Mod+I' },
];

export function TitleBar() {
  const { t } = useT();
  const panels = useUiStore((state) => state.panels);
  const togglePanel = useUiStore((state) => state.togglePanel);
  const openDialog = useUiStore((state) => state.openDialog);

  return (
    <header className="flex h-toolbar shrink-0 items-stretch gap-2 border-b border-border bg-surface-2 pl-2.5 pr-2">
      <div className="flex shrink-0 items-center gap-2">
        {/* The mark gets its own tinted chip so the name is not the only anchor. */}
        <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-accent-weak text-accent">
          <Icon name="server" size={16} />
        </span>
        <span className="text-md font-semibold tracking-tighter">{t('app.name')}</span>
      </div>

      {/* Tabs own the middle. They align to the bottom edge so the active tab's
          accent underline can sit on the bar's own hairline. */}
      <div className="flex min-w-0 flex-1 items-stretch overflow-hidden">
        <SessionTabBar />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="primary"
          icon={<Icon name="plus" />}
          onClick={() => openDialog({ kind: 'connection' })}
        >
          {t('app.newConnection')}
        </Button>

        <Divider />

        {/* One segmented cluster, so five toggles read as one control group. */}
        <div className="flex items-center gap-0.5 rounded bg-surface p-0.5 shadow-e1">
          {TOGGLES.map((toggle) => (
            <Tooltip
              key={toggle.panel}
              content={
                <span className="flex items-center gap-1.5">
                  {t(toggle.labelKey)}
                  {toggle.shortcut ? <Kbd keys={toggle.shortcut} /> : null}
                </span>
              }
            >
              <button
                type="button"
                aria-pressed={panels[toggle.panel]}
                aria-label={t(toggle.labelKey)}
                onClick={() => togglePanel(toggle.panel)}
                className={cn(
                  'press flex h-6 w-6 items-center justify-center rounded-sm transition-quick',
                  panels[toggle.panel]
                    ? 'bg-accent-weak text-accent shadow-e1'
                    : 'text-text-3 hover:bg-surface-2 hover:text-text-2',
                )}
              >
                <Icon name={toggle.icon} />
              </button>
            </Tooltip>
          ))}
        </div>

        <Divider />

        <IconButton
          label={t('app.shortcuts')}
          icon={<Icon name="help" />}
          size="md"
          variant="ghost"
          className="press"
          onClick={() => openDialog({ kind: 'shortcuts' })}
        />
        <IconButton
          label={t('app.openSettings')}
          icon={<Icon name="settings" />}
          size="md"
          variant="ghost"
          className="press"
          onClick={() => openDialog({ kind: 'settings' })}
        />
      </div>
    </header>
  );
}

/** A short hairline, inset from the bar's edges rather than spanning it. */
function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}
