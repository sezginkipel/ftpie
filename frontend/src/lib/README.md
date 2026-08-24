# Foundation layer — handoff for F2 (shell/browser) and F3 (panels)

Paths are relative to `src/`. Everything below is verified against the backend as
of Wave 1; `tsc`, `eslint` and `vitest` are green for these files.

## Imports

```ts
import { call, isAppError, errorCode }          from './lib/ipc';        // ONLY place invoke lives
import { useT, errorMessage, errorDetail }      from './lib/i18n';
import type { RemoteFile, TransferItem, ... }   from './lib/types';      // all wire types
import { formatBytes, formatSpeed, formatEta, formatDate, formatMode,
         parentPath, joinPath, baseName, pathSegments, truncateMiddle,
         chunkFingerprint, progressRatio, DASH } from './lib/format';
import { setupMonaco, languageForPath, RHAI_LANGUAGE_ID } from './lib/monaco';
import { cn }                                   from './lib/cn';
import { Button, Dialog, useToast, ... }        from './components/ui';  // barrel
```

## `ipc.call`

`await call<T>(cmd, args?)` — **no other file may import `invoke`.** It always
rejects with a well-formed `AppError` (`{ code, message, ...variantFields }`),
even when the bridge throws a bare string. Discriminate on `code`; the
`untrusted_host` variant carries `previousFingerprint`, `conflict` carries
`remoteHash`. Argument names are camelCase and Tauri maps them to snake_case;
commands taking a struct want it wrapped (`{ args: {...} }`, `{ input: {...} }`,
`{ update: {...} }`, `{ request: {...} }`) — see each store for the exact shape.

## `useT` / `t`

```ts
const { t, locale, setLocale } = useT();
t('delete.confirmMany', { count: 3 })   // TKey is compile-checked
```

Default locale `tr`. Every user-visible string goes through `t()` — labels,
tooltips, empty states, `aria-label`s, error text. Add a key to
`lib/locales/en.ts` first; `tr.ts` then fails to compile until translated.
For a rejection: `errorMessage(e, t)` is the localized primary sentence;
`errorDetail(e)` is the English backend detail for a disclosure.

## `useToast`

```ts
const { toast, showError, dismiss, dismissAll } = useToast();
toast({ title: t('editor.saved', { name }), variant: 'ok' });   // 'info'|'ok'|'warn'|'danger'
showError(e);                     // localized title + backend detail, danger
showError(e, 'script.runFailed'); // override the title key
```

Auto-dismiss is Radix's (5s, 9s for danger) — do not add your own timers.

## UI primitives (`components/ui`)

| Component | Key props |
| --- | --- |
| `Button` | `variant` primary/secondary/ghost/danger, `size` sm/md, `loading`, `icon`, plus button attrs |
| `IconButton` | **`label` (required → `aria-label` + title)**, `icon`, `variant`, `size` sm/md, `loading` |
| `Icon` | `name` (see `IconName`), `size` 14/16, `title` (only when standalone) |
| `Spinner` | `size`, `label` |
| `Field` | `label`, `hint`, `error`, `required`; render-prop child gets `{id, describedBy, invalid}` |
| `Input` | `invalid`, `mono`, plus input attrs |
| `NumberInput` | `value: number\|null`, `onValueChange(n\|null)` — **never emits NaN**, `min`, `max`, `invalid` |
| `Select` | `value`, `onValueChange`, `options: {value,label,disabled?}[]`, `invalid` |
| `Checkbox` | `checked`, `onCheckedChange`, `label` (required), `hint`, `indeterminate`, `disabled` |
| `Switch` | `checked`, `onCheckedChange`, `label`, `hint`, `disabled` |
| `Textarea` | `invalid`, `mono`, `rows` |
| `Dialog` | `open`, `onOpenChange`, `title`, `description`, `size` sm/md/lg/xl, `footer`, `headerExtra`, `showClose`, `dismissible` |
| `AlertDialog` | `open`, `onOpenChange`, `title`, `description`, **`confirmLabel` must name what and how many**, `cancelLabel`, `tone` danger/primary, `initialFocus` cancel/confirm (default cancel), `loading`, `onConfirm` |
| `Menu` | `trigger`, `items: MenuItem[]`, `label`, `align`, `side` |
| `ContextMenu` | `children`, `items: MenuItem[]`, `label`, `disabled` |
| `Tooltip` | `content`, `side`, `mono`, `disabled`; wrap app in `TooltipProvider` |
| `ToastProvider` / `useToast` | mount provider inside `I18nProvider` |
| `ProgressBar` | `value: number\|null` (null = indeterminate), `label`, `tone`, `height` 2/4/6 |
| `Badge` | `tone` neutral/accent/ok/warn/danger/info, `mono` |
| `Kbd` | `keys` e.g. `'Mod+Shift+T'` (`Mod` → ⌘/Ctrl) |
| `Separator` | `orientation`, `semantic` |
| `Tabs` | `tabs: {id,label,icon?,disabled?}[]`, `value`, `onValueChange`, `label` |
| `EmptyState` | `title`, `description`, `icon`, `action`, `compact` — **only for genuinely empty** |
| `ErrorState` | `error` (raw rejection), `title?`, `onRetry`, `action`, `compact` — **required on every failed fetch** |
| `InlineError` | `error` — one-line form for dialog footers |

`MenuItem` is a union: `{id,label,icon?,shortcut?,disabled?,danger?,onSelect}`,
`{kind:'checkbox',...}`, `{kind:'separator',id}`, `{kind:'label',id,label}`.

## Stores (`store/`)

- **`useSettingsStore`** — `set(patch)` (clamps numbers, auto-pushes
  `maxConcurrentTransfers`), `reset()`, `syncToBackend()`; fields per `Settings`.
  Non-reactive read: `getSettings()`.
- **`useSessionStore`** — `sessions`, `order`, `activeId`, `ui`, `closing`;
  `active()`, `activeUi()`, `list()`, `uiFor(id)`; `connect(args)`,
  `connectBookmark(id)`, `disconnect(id)`, `hydrate()`, `setActive(id)`;
  per-session UI: `setRemotePath`, `setLocalPath`, `setSelection(id, side, paths)`,
  `clearSelection`, `setSort(id, side, sort)`. `connect` **re-throws
  `untrusted_host` / `vault_locked` unchanged** — handle them.
- **`useTransferStore`** — `items`, `order`, `queuePaused`, `hydrated`, `error`;
  `list()`, `listForSession(id)`, `aggregates()`; `subscribe()` (idempotent,
  returns unlisten), `hydrate()`, `cancel/pause/resume(id)`, `clearFinished()`,
  `setQueuePaused(bool)`. Call `subscribe()` + `hydrate()` once at app start.
- **`useBookmarkStore`** — `bookmarks`, `loading`, `error`; `byId`, `byTag()`,
  `search(q)`; `load()`, `create(input)`, `update(update)`, `remove(id)`,
  `duplicate(id, name)`, `exportAll(passphrase)`, `importArchive(archive, passphrase)`.
  Saving a password needs an unlocked vault — no fallback. Helper
  `canStorePassword(vaultStatus)`.
- **`useVaultStore`** — `status`, `busy`, `error`; `canStoreSecrets()`,
  `refresh()`, `initialize(pw)`, `unlock(pw)`, `lock()`, `changePassword(old,new)`.
- **`useEditorStore`** — `tabs`, `activeId`; `active()`, `byId(id)`,
  `dirtyTabs()`; `open(sessionId, remotePath)`, `applyFetched(id, file)`,
  `setActive`, `setContent`, `close(id)`, `closeSession(sessionId)`,
  `save(id, {force?})`, `revert(id)`. `open` may reject with a
  `ReopenConflict` (`isReopenConflict(e)`); `save` re-throws `conflict`.
  Binary tabs ignore edits and refuse to save.
- **`useUiStore`** — `dialog` (discriminated on `kind`), `panels`,
  `transfersCollapsed`, `transfersHeight`, `splitRatio`, `focusedPane`;
  `openDialog(d)`, `closeDialog()`, `openDialogForError(err, retry?)`,
  `togglePanel`, `setPanel`, `setTransfersCollapsed`, `setTransfersHeight`,
  `setSplitRatio`, `setFocusedPane`.

## Monaco

`setupMonaco()` runs once in `main.tsx`: it calls `loader.config({ monaco })`
with the local ESM build and installs `self.MonacoEnvironment.getWorker`, backed
by Vite `?worker` imports of the editor/json/css/html/ts workers. Nothing is
fetched from a CDN. Use `languageForPath(path)` for the remote editor and
`RHAI_LANGUAGE_ID` (`'rhai'`) for the script editor — never `'javascript'`.

## Non-negotiables

No `invoke` outside `lib/ipc.ts`. No hardcoded user-visible strings. No
`prompt`/`confirm`/`alert`. No `dangerouslySetInnerHTML`. Every `listen`
unlistens, every effect cleans up, every promise is awaited in a `try/catch` or
has a `.catch` that toasts. `EmptyState` never stands in for a failure.
