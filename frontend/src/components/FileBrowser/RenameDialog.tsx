/**
 * Rename one entry, in either pane.
 *
 * Also replaces a native `prompt()`. The new name is a single path component,
 * joined onto the same parent — typing a separator is rejected rather than
 * quietly moving the file somewhere else.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { joinPath, parentPath as parentOf } from '../../lib/format';
import { call } from '../../lib/ipc';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../store/uiStore';
import { Button, Dialog, Field, InlineError, Input, useToast } from '../ui';
import { listingQueryKey } from './logic';

const INVALID = /[\\/:*?"<>|]/;

export function RenameDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = dialog.kind === 'rename';
  const currentName = dialog.kind === 'rename' ? dialog.currentName : '';

  useEffect(() => {
    if (!open) return;
    setName(currentName);
    setError(null);
    setBusy(false);
    // Select the stem, not the extension — the usual reason to rename.
    const dot = currentName.lastIndexOf('.');
    const end = dot > 0 ? dot : currentName.length;
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(0, end));
  }, [open, currentName]);

  if (dialog.kind !== 'rename') return null;
  const { sessionId, side, path } = dialog;

  const isRemote = side === 'remote';
  const parent = parentOf(path, isRemote);
  const trimmed = name.trim();
  const validation =
    trimmed === '' || trimmed === currentName
      ? null
      : INVALID.test(trimmed) || trimmed === '.' || trimmed === '..'
        ? t('file.nameInvalid')
        : parent === null
          ? t('file.renameRootBlocked')
          : null;

  const submit = async () => {
    if (trimmed === '' || trimmed === currentName || validation || parent === null) return;
    const target = joinPath(parent, trimmed, isRemote);
    setBusy(true);
    setError(null);
    try {
      if (isRemote) {
        await call<void>('rename_remote', { sessionId, from: path, to: target });
      } else {
        await call<void>('rename_local', { from: path, to: target });
      }
      await queryClient.invalidateQueries({
        queryKey: listingQueryKey(side, isRemote ? sessionId : null, parent),
      });
      toast({ title: t('file.renamed', { from: currentName, to: trimmed }), variant: 'ok' });
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
      title={t('file.renameTitle')}
      description={path}
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
            disabled={trimmed === '' || trimmed === currentName || validation !== null}
            onClick={() => void submit()}
          >
            {t('common.rename')}
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
        <Field label={t('file.renameLabel')} error={validation} required>
          {({ id, describedBy, invalid }) => (
            <Input
              ref={inputRef}
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
