/**
 * Change remote permissions.
 *
 * The two representations stay in sync in both directions: ticking a box
 * updates the octal field and typing an octal value updates the boxes.
 * `chmod_remote` takes a numeric mode and has **no recursive option**, so this
 * dialog does not pretend to offer one.
 */
import { useEffect, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { formatMode, modeToOctal, parseMode, parentPath } from '../lib/format';
import { useT } from '../lib/i18n';
import { call } from '../lib/ipc';
import { useUiStore } from '../store/uiStore';
import { Button, Checkbox, Dialog, Field, InlineError, Input, useToast } from './ui';
import { listingQueryKey } from './FileBrowser';

type Who = 'owner' | 'group' | 'other';
type What = 'read' | 'write' | 'execute';

const SHIFT: Record<Who, number> = { owner: 6, group: 3, other: 0 };
const BIT: Record<What, number> = { read: 4, write: 2, execute: 1 };

function hasBit(mode: number, who: Who, what: What): boolean {
  return ((mode >> SHIFT[who]) & BIT[what]) !== 0;
}

function withBit(mode: number, who: Who, what: What, on: boolean): number {
  const mask = BIT[what] << SHIFT[who];
  return on ? mode | mask : mode & ~mask;
}

export function ChmodDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState(0o644);
  const [octal, setOctal] = useState('644');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const open = dialog.kind === 'chmod';
  const first = dialog.kind === 'chmod' ? dialog.targets[0] : null;
  const initial = first ? (parseMode(first.mode ?? first.permissions) ?? 0o644) : 0o644;

  useEffect(() => {
    if (!open) return;
    setMode(initial);
    setOctal(modeToOctal(initial));
    setError(null);
    setBusy(false);
  }, [open, initial]);

  if (dialog.kind !== 'chmod') return null;
  const { sessionId, targets } = dialog;

  const octalValid = parseMode(octal) !== null && /^[0-7]{3,4}$/.test(octal.trim());

  const setFromOctal = (value: string) => {
    setOctal(value);
    const parsed = parseMode(value);
    if (parsed !== null && /^[0-7]{3,4}$/.test(value.trim())) setMode(parsed);
  };

  const toggle = (who: Who, what: What, on: boolean) => {
    const next = withBit(mode, who, what, on);
    setMode(next);
    setOctal(modeToOctal(next));
  };

  const apply = async () => {
    if (!octalValid) return;
    setBusy(true);
    setError(null);
    const parents = new Set<string>();
    try {
      for (const target of targets) {
        await call<void>('chmod_remote', { sessionId, path: target.path, mode });
        const parent = parentPath(target.path, true);
        if (parent) parents.add(parent);
      }
      for (const parent of parents) {
        await queryClient.invalidateQueries({
          queryKey: listingQueryKey('remote', sessionId, parent),
        });
      }
      toast({ title: t('chmod.applied'), variant: 'ok' });
      closeDialog();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const targetLabel =
    targets.length === 1
      ? t('chmod.target', { name: targets[0].name })
      : t('common.itemsSelected', { count: targets.length });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={t('chmod.title')}
      description={targetLabel}
      size="sm"
      footer={
        <>
          <InlineError error={error} className="mr-auto" />
          <Button variant="secondary" className="press" onClick={closeDialog} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            className="press"
            loading={busy}
            disabled={!octalValid}
            onClick={() => void apply()}
          >
            {t('common.apply')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/*
         * The permission grid is the primary control here, so it gets a panel of
         * its own with proper chrome on the header row rather than sitting as a
         * bare table in the flow.
         */}
        <table className="w-full overflow-hidden rounded-lg border border-border text-sm">
          <thead>
            <tr className="bg-surface-2 text-left text-2xs uppercase tracking-wider text-text-3">
              <th scope="col" className="w-24 px-3 py-1.5" />
              <th scope="col" className="px-3 py-1.5">
                {t('chmod.read')}
              </th>
              <th scope="col" className="px-3 py-1.5">
                {t('chmod.write')}
              </th>
              <th scope="col" className="px-3 py-1.5">
                {t('chmod.execute')}
              </th>
            </tr>
          </thead>
          <tbody>
            {(['owner', 'group', 'other'] as Who[]).map((who) => (
              <tr key={who} className="border-t border-border transition-quick hover:bg-surface-2">
                <th
                  scope="row"
                  className="px-3 py-1.5 text-left text-2xs font-normal uppercase tracking-wider text-text-2"
                >
                  {t(`chmod.${who}`)}
                </th>
                {(['read', 'write', 'execute'] as What[]).map((what) => (
                  <td key={what} className="px-3 py-1.5">
                    <Checkbox
                      checked={hasBit(mode, who, what)}
                      onCheckedChange={(checked) => toggle(who, what, checked)}
                      label={`${t(`chmod.${who}`)} — ${t(`chmod.${what}`)}`}
                      // The column and row headers already name this box, so
                      // the primitive's own label is for screen readers only.
                      className="[&_label]:sr-only"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {/*
         * Octal and symbolic side by side: typing one updates the other, and
         * the symbolic form stays visible so a mistyped digit is obvious.
         */}
        <div className="flex items-end gap-3">
          <Field
            label={t('chmod.octal')}
            error={octalValid ? null : t('chmod.octalInvalid')}
            hint={t('chmod.octalHint')}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                mono
                inputMode="numeric"
                value={octal}
                onChange={(event) => setFromOctal(event.target.value)}
                className="w-24"
              />
            )}
          </Field>
          <span className="mb-6 select-all rounded border border-border bg-surface-2 px-2.5 py-1 font-mono text-base tnum text-text">
            {formatMode(mode)}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
