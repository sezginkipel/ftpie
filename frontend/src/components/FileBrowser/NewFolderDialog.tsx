/**
 * Create a folder in either pane.
 *
 * Replaces a native `prompt()`, which could not be styled, translated, focus
 * trapped or validated. Driven by `uiStore`'s `newFolder` dialog state.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { call } from '../../lib/ipc';
import { joinPath } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../store/uiStore';
import { Button, Dialog, Field, InlineError, Input, useToast } from '../ui';
import { listingQueryKey } from './logic';

/** Characters no server or filesystem accepts inside a single component. */
const INVALID = /[\\/:*?"<>|]/;

export function NewFolderDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const open = dialog.kind === 'newFolder';

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  if (dialog.kind !== 'newFolder') return null;
  const { sessionId, side, parentPath } = dialog;

  const trimmed = name.trim();
  const validation =
    trimmed === ''
      ? null
      : INVALID.test(trimmed)
        ? t('file.nameInvalid')
        : trimmed === '.' || trimmed === '..'
          ? t('file.nameInvalid')
          : null;

  const submit = async () => {
    if (trimmed === '' || validation) return;
    const target = joinPath(parentPath, trimmed, side === 'remote');
    setBusy(true);
    setError(null);
    try {
      if (side === 'remote') {
        await call<void>('mkdir_remote', { sessionId, path: target });
      } else {
        await call<void>('mkdir_local', { path: target });
      }
      await queryClient.invalidateQueries({
        queryKey: listingQueryKey(side, side === 'remote' ? sessionId : null, parentPath),
      });
      toast({ title: t('file.folderCreated', { name: trimmed }), variant: 'ok' });
      closeDialog();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={t('file.newFolderTitle')}
      description={parentPath}
      size="sm"
      footer={
        <>
          <InlineError error={error} className="mr-auto" />
          <Button variant="secondary" onClick={closeDialog} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={trimmed === '' || validation !== null}
            onClick={() => void submit()}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t('file.newFolderName')} error={validation} required>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              mono
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
