/**
 * Resolve destination collisions before anything is enqueued.
 *
 * The backend has no `ask` policy — a worker must never block on the UI — so
 * when `overwriteMode` is `ask` this dialog turns every collision into a
 * concrete `overwrite` / `skip` / `rename`. The old UI shipped `ask` as the
 * default and then silently overwrote, which is how people lost files.
 */
import { useEffect, useState } from 'react';

import { DASH, baseName, formatBytes, formatDate } from '../lib/format';
import { useT } from '../lib/i18n';
import type { ConflictPolicy } from '../lib/types';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore, type ConflictEntry } from '../store/uiStore';
import { Button, Dialog, Icon, Select } from './ui';

const POLICIES: readonly ConflictPolicy[] = ['overwrite', 'skip', 'rename'];

export function ConflictDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const { t, locale } = useT();
  const dateFormat = useSettingsStore((state) => state.dateFormat);

  const entries: ConflictEntry[] = dialog.kind === 'conflict' ? dialog.entries : [];
  const [policies, setPolicies] = useState<ConflictPolicy[]>([]);

  /**
   * A stable identity for the conflict set. Depending on the array itself would
   * loop forever: the non-conflict branch rebuilds `[]` on every render.
   */
  const signature = entries
    .map((entry) => `${entry.item.direction}:${entry.item.localPath}>${entry.item.remotePath}`)
    .join('|');
  const count = entries.length;

  // One policy slot per entry, defaulting to the least destructive choice.
  useEffect(() => {
    setPolicies(Array.from({ length: count }, (): ConflictPolicy => 'rename'));
  }, [signature, count]);

  if (dialog.kind !== 'conflict') return null;

  const applyToAll = (policy: ConflictPolicy) => {
    setPolicies(entries.map(() => policy));
  };

  const label = (policy: ConflictPolicy) =>
    policy === 'overwrite'
      ? t('conflict.overwrite')
      : policy === 'skip'
        ? t('conflict.skip')
        : t('conflict.rename');

  const options = POLICIES.map((policy) => ({ value: policy, label: label(policy) }));

  const start = () => {
    const resolved = entries.map((entry, index) => ({
      item: entry.item,
      policy: policies[index] ?? 'rename',
    }));
    dialog.onResolved(resolved);
  };

  const destinationName = (entry: ConflictEntry) =>
    entry.item.direction === 'upload'
      ? baseName(entry.item.remotePath)
      : baseName(entry.item.localPath);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={t('conflict.title')}
      description={t('conflict.body', { count: entries.length })}
      size="lg"
      footer={
        <>
          <div className="mr-auto flex items-center gap-1">
            <span className="text-sm text-text-3">{t('conflict.applyToAll')}</span>
            <Button size="sm" variant="secondary" onClick={() => applyToAll('overwrite')}>
              {t('conflict.overwriteAll')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => applyToAll('skip')}>
              {t('conflict.skipAll')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => applyToAll('rename')}>
              {t('conflict.renameAll')}
            </Button>
          </div>
          <Button variant="secondary" onClick={closeDialog}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={start}>
            {t('conflict.start')}
          </Button>
        </>
      }
    >
      <div role="table" aria-label={t('conflict.title')} className="flex flex-col">
        <div
          role="row"
          className="row shrink-0 gap-2 border-b border-border px-1 text-xs text-text-3"
        >
          <span role="columnheader" className="min-w-0 flex-1">
            {t('common.name')}
          </span>
          <span role="columnheader" className="w-40 shrink-0">
            {t('conflict.existing')}
          </span>
          <span role="columnheader" className="w-40 shrink-0">
            {t('conflict.incoming')}
          </span>
          <span role="columnheader" className="w-32 shrink-0">
            {t('common.status')}
          </span>
        </div>

        {entries.map((entry, index) => (
          <div
            key={`${entry.item.direction}:${entry.item.remotePath}:${entry.item.localPath}`}
            role="row"
            className="row shrink-0 gap-2 border-b border-border px-1"
          >
            <span role="cell" className="flex min-w-0 flex-1 items-center gap-1.5">
              <Icon
                name={entry.item.direction === 'upload' ? 'upload' : 'download'}
                className="text-text-3"
              />
              <span className="cell-truncate font-mono text-sm" title={destinationName(entry)}>
                {destinationName(entry)}
              </span>
            </span>
            <span role="cell" className="w-40 shrink-0 tnum text-sm text-text-2">
              {entry.existingSize === null ? DASH : formatBytes(entry.existingSize)}
              {' · '}
              {formatDate(entry.existingModified, locale, dateFormat)}
            </span>
            <span role="cell" className="w-40 shrink-0 tnum text-sm text-text-2">
              {entry.incomingSize === null ? DASH : formatBytes(entry.incomingSize)}
              {' · '}
              {formatDate(entry.incomingModified, locale, dateFormat)}
            </span>
            <span role="cell" className="w-32 shrink-0">
              <Select
                aria-label={t('common.status')}
                value={policies[index] ?? 'rename'}
                onValueChange={(value) =>
                  setPolicies((current) =>
                    current.map((existing, slot) => (slot === index ? value : existing)),
                  )
                }
                options={options}
              />
            </span>
          </div>
        ))}
      </div>

      <p className="mt-2 text-sm text-text-3">{t('conflict.renameHint')}</p>
    </Dialog>
  );
}
