/**
 * The application shell.
 *
 * Providers, the theme, global shortcuts, the close guard, the layout, and the
 * single host for every modal. Four things here are deliberate fixes:
 *
 * 1. **Theme `system` actually follows the system.** The old code read
 *    `matchMedia(...).matches` once at mount, so a machine that switched to
 *    dark at sunset kept the light theme until the app restarted. There is now
 *    a `change` listener, and only the `dark` class plus `data-theme` are set —
 *    the meaningless `light` class is gone.
 * 2. **Quitting with unsaved editor tabs is blocked**, both for a browser
 *    reload and for Tauri's own close request. Unsaved work used to vanish.
 * 3. **Global shortcuts are registered once**, from a tested key map, and are
 *    discoverable through the shortcut sheet.
 * 4. Panels are toggleable and the transfer queue's height is draggable and
 *    remembered, instead of a permanent 120px placeholder.
 *
 * The layout itself is a **gapped grid, not a set of regions divided by
 * hairlines**: the title bar and the status bar are chrome and span the window,
 * and everything between them floats on `bg` inside a 6px gutter, so each panel
 * reads as its own object. Every panel therefore owns its own border and radius;
 * this file only decides where the gaps are.
 */
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { I18nProvider, useT } from './lib/i18n';
import { useEditorStore } from './store/editorStore';
import { useSessionStore } from './store/sessionStore';
import { useSettingsStore } from './store/settingsStore';
import { useTransferStore } from './store/transferStore';
import { useUiStore } from './store/uiStore';
import { useVaultStore } from './store/vaultStore';
import { AiAssistant } from './components/AiAssistant';
import { ChmodDialog } from './components/ChmodDialog';
import { ConflictDialog } from './components/ConflictDialog';
import { ConnectionDialog } from './components/ConnectionDialog';
import { DeployHistoryPanel } from './components/DeployHistoryPanel';
import { EditorPane } from './components/EditorPane';
import { NewFolderDialog, Panes, RenameDialog } from './components/FileBrowser';
import { mapGlobalKey } from './components/FileBrowser';
import { GitPanel } from './components/GitPanel';
import { ScriptManager } from './components/ScriptManager';
import { SettingsDialog } from './components/SettingsDialog';
import { ShortcutSheet } from './components/ShortcutSheet';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { TransferQueue } from './components/TransferQueue';
import { TrustDialog } from './components/TrustDialog';
import { UpdateBanner } from './components/UpdateBanner';
import { VaultDialog } from './components/VaultDialog';
import { AlertDialog, ToastProvider, TooltipProvider, useToast } from './components/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    // A listing is a snapshot of a remote filesystem: retrying a rejection
    // hides the real error, and stale data is actively misleading.
    queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
  },
});

export default function App() {
  const locale = useSettingsStore((state) => state.locale);
  const theme = useSettingsStore((state) => state.theme);
  const setSetting = useSettingsStore((state) => state.set);

  // `system` means "follow the OS, now and later".
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      root.classList.toggle('dark', dark);
      if (theme === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', theme);
    };

    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return (
    <I18nProvider locale={locale} onLocaleChange={(next) => setSetting({ locale: next })}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <Shell />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

function Shell() {
  const { t } = useT();
  const { showError } = useToast();
  const queryClient = useQueryClient();

  const panels = useUiStore((state) => state.panels);
  const togglePanel = useUiStore((state) => state.togglePanel);
  const openDialog = useUiStore((state) => state.openDialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const dialog = useUiStore((state) => state.dialog);

  const activeId = useSessionStore((state) => state.activeId);
  const disconnect = useSessionStore((state) => state.disconnect);
  const hydrateSessions = useSessionStore((state) => state.hydrate);

  const tabs = useEditorStore((state) => state.tabs);
  const dirtyCount = useMemo(() => tabs.filter((tab) => tab.dirty).length, [tabs]);
  const dirtyRef = useRef(dirtyCount);
  dirtyRef.current = dirtyCount;

  const [quitBlocked, setQuitBlocked] = useState(false);
  /** Editor height, dragged by the separator above it. */
  const [editorHeight, setEditorHeight] = useState(320);

  // ── Startup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const handle = await useTransferStore.getState().subscribe();
      if (cancelled) handle();
      else unlisten = handle;
      await useTransferStore.getState().hydrate();
    })().catch((error: unknown) => showError(error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showError]);

  useEffect(() => {
    void hydrateSessions().catch(() => {
      // No sessions is the normal first-run state; a genuine failure shows up
      // the moment the user tries to browse.
    });
    void useVaultStore
      .getState()
      .refresh()
      .catch(() => {
        // The status bar renders "loading" rather than lying about the vault.
      });
    void useSettingsStore
      .getState()
      .syncToBackend()
      .catch(() => {
        // Concurrency is a preference, not worth an error dialog at startup.
      });
  }, [hydrateSessions]);

  // ── Quitting with unsaved work ────────────────────────────────────────────

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current === 0) return;
      event.preventDefault();
      // Chromium still wants `returnValue` set to raise its own prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const handle = await getCurrentWindow().onCloseRequested((event) => {
          if (dirtyRef.current === 0) return;
          event.preventDefault();
          setQuitBlocked(true);
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Running outside a Tauri window (tests, a plain browser): the
        // `beforeunload` guard above is the only one available.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const quit = useCallback(() => {
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().destroy();
      } catch {
        window.close();
      }
    })();
  }, []);

  // ── Global shortcuts ──────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          // A focused file grid consumes bare keys for type-ahead, so "?" must
          // jump to a file there rather than open the shortcut sheet.
          target.closest('[role="grid"]') !== null);

      const action = mapGlobalKey(event);
      if (!action) return;
      // While typing, only modifier-based shortcuts apply — otherwise "?" in a
      // filter box would open the shortcut sheet.
      if (typing && !event.ctrlKey && !event.metaKey && event.key !== 'F5') return;

      event.preventDefault();
      switch (action.kind) {
        case 'newConnection':
          openDialog({ kind: 'connection' });
          return;
        case 'settings':
          openDialog({ kind: 'settings' });
          return;
        case 'shortcuts':
          openDialog({ kind: 'shortcuts' });
          return;
        case 'refresh':
          void queryClient.invalidateQueries({ queryKey: ['listing'] });
          return;
        case 'closeSession':
          if (activeId) void disconnect(activeId);
          return;
        case 'togglePanel':
          togglePanel(action.panel);
          return;
        case 'quit':
          if (dirtyRef.current > 0) setQuitBlocked(true);
          else quit();
          return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeId, disconnect, openDialog, queryClient, quit, togglePanel]);

  // ── Editor height ─────────────────────────────────────────────────────────

  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const state = dragState.current;
      if (!state) return;
      setEditorHeight(clampEditorHeight(state.startHeight - (event.clientY - state.startY)));
    };
    const onUp = () => {
      dragState.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-text">
      <TitleBar />

      {/* 6px gutter all round, 6px between panels. Small and consistent beats
          flush-against-hairlines, and it is what makes the panels read as
          objects rather than as cut-outs. */}
      <div className="flex min-h-0 flex-1 items-stretch gap-1.5 p-1.5">
        {panels.sidebar ? <Sidebar /> : null}

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Panes />

          {/* TransferQueue owns its own collapse state and height. */}
          {panels.transfers ? <TransferQueue /> : null}

          {panels.editor ? (
            <>
              {/*
                The drag handle is a 6px hit area — the gap itself — with a 2px
                grip that appears on hover or focus. A 1px line was unhittable.
              */}
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={t('layout.resizeEditor')}
                aria-valuenow={editorHeight}
                aria-valuemin={120}
                aria-valuemax={900}
                tabIndex={0}
                data-focus-none
                onMouseDown={(event) => {
                  dragState.current = { startY: event.clientY, startHeight: editorHeight };
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setEditorHeight(clampEditorHeight(editorHeight + 16));
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setEditorHeight(clampEditorHeight(editorHeight - 16));
                  }
                }}
                className="group -my-1 flex h-1.5 shrink-0 cursor-row-resize items-center justify-center focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className="h-0.5 w-16 rounded-full bg-transparent transition-base group-hover:bg-border-strong group-focus-visible:bg-accent group-active:bg-accent"
                />
              </div>
              {/* Inline height because it is dragged; a class cannot express it. */}
              <div
                style={{ height: editorHeight }}
                className="flex shrink-0 flex-col overflow-hidden rounded-lg"
              >
                <EditorPane className="min-h-0 flex-1" />
              </div>
            </>
          ) : null}
        </div>

        {panels.git ? (
          <div className="flex w-[340px] shrink-0 flex-col gap-1.5 overflow-hidden">
            <GitPanel className="min-h-0 flex-1 overflow-hidden rounded-lg" />
            <DeployHistoryPanel
              sessionId={activeId}
              repoPath={null}
              className="min-h-0 max-h-[40%] overflow-hidden rounded-lg"
            />
          </div>
        ) : null}

        {panels.ai ? (
          <AiAssistant className="w-[340px] shrink-0 overflow-hidden rounded-lg" />
        ) : null}
      </div>

      <StatusBar />

      {/* Every modal in one place, each self-gating on `uiStore.dialog.kind`. */}
      <TrustDialog />
      <VaultDialog />
      <ConflictDialog />
      <ConnectionDialog />
      <ChmodDialog />
      <NewFolderDialog />
      <RenameDialog />
      {/* `saveConflict` is deliberately absent: EditorPane mounts that itself. */}
      <SettingsDialog
        open={dialog.kind === 'settings'}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
        initialTab={dialog.kind === 'settings' ? dialog.tab : undefined}
      />
      <ShortcutSheet
        open={dialog.kind === 'shortcuts'}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
      />
      <ScriptManager
        open={dialog.kind === 'scripts'}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
        initialScriptId={dialog.kind === 'scripts' ? dialog.scriptId : undefined}
      />

      {/* Fixed overlay: checks once on mount, never installs on its own. */}
      <UpdateBanner />

      <AlertDialog
        open={quitBlocked}
        onOpenChange={setQuitBlocked}
        title={t('app.quitBlockedTitle')}
        description={t('app.quitBlockedBody', { count: dirtyCount })}
        tone="danger"
        confirmLabel={t('app.quitDiscard')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          setQuitBlocked(false);
          quit();
        }}
      />
    </div>
  );
}

/** Editor height bounds, so a drag can never hide the panes entirely. */
function clampEditorHeight(height: number): number {
  return Math.max(120, Math.min(900, Math.round(height)));
}
