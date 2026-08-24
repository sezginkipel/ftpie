/**
 * The 36px top bar: identity, session tabs, connect, panel toggles, settings.
 *
 * Every control has an accessible name and a keyboard shortcut hint where one
 * exists; the panel toggles are checkbox-like buttons with `aria-pressed` so
 * their state is announced.
 */
import { cn } from '../lib/cn';
import { useT } from '../lib/i18n';
import { useUiStore, type PanelName } from '../store/uiStore';
import { Button, Icon, IconButton, Kbd, Separator, Tooltip, type IconName } from './ui';
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
    <header className="flex h-toolbar shrink-0 items-stretch border-b border-border bg-surface-2">
      <div className="flex shrink-0 items-center gap-1.5 px-2">
        <Icon name="server" size={16} className="text-accent" />
        <span className="text-md font-semibold tracking-tight">{t('app.name')}</span>
      </div>

      <Separator orientation="vertical" />

      <div className="flex min-w-0 flex-1 items-stretch">
        <SessionTabBar />
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2">
        <Button
          size="sm"
          variant="primary"
          icon={<Icon name="plus" />}
          onClick={() => openDialog({ kind: 'connection' })}
        >
          {t('app.newConnection')}
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

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
                'flex h-6 w-6 items-center justify-center rounded transition-quick',
                panels[toggle.panel]
                  ? 'bg-accent-weak text-accent'
                  : 'text-text-3 hover:bg-surface hover:text-text-2',
              )}
            >
              <Icon name={toggle.icon} />
            </button>
          </Tooltip>
        ))}

        <Separator orientation="vertical" className="mx-1 h-5" />

        <IconButton
          label={t('app.shortcuts')}
          icon={<Icon name="help" />}
          size="sm"
          variant="ghost"
          onClick={() => openDialog({ kind: 'shortcuts' })}
        />
        <IconButton
          label={t('app.openSettings')}
          icon={<Icon name="settings" />}
          size="sm"
          variant="ghost"
          onClick={() => openDialog({ kind: 'settings' })}
        />
      </div>
    </header>
  );
}
