'use client';

import { useState } from 'react';

import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DropdownMenuItem, DropdownMenuSeparator, RowActions } from '@tillgate/ui';
import type { KeyRow } from '@tillgate/api-client';

import { ConfirmAction } from '@/features/shared/confirm-action';
import { revokeKeyAction } from '@/server/actions/keys';

import { EditKeyDialog } from './edit-key-dialog';

export function KeyRowActions({ keyRow }: { keyRow: KeyRow }) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const [editOpen, setEditOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  return (
    <>
      <RowActions label={tCommon('actions')}>
        {keyRow.status === 0 ? (
          <>
            <DropdownMenuItem onClick={() => setEditOpen(true)}>
              <PencilIcon /> {tCommon('edit')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setRevokeOpen(true)}>
              <Trash2Icon /> {t('revoke')}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem disabled>{t('statusRevoked')}</DropdownMenuItem>
        )}
      </RowActions>
      <EditKeyDialog keyRow={keyRow} open={editOpen} onOpenChange={setEditOpen} />
      {/* 弹窗挂在菜单外(受控 open):菜单点选关闭时会卸载整个 content,放里面会连弹窗一起卸掉 */}
      <ConfirmAction
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        confirm={t('revokeConfirm')}
        action={async () => revokeKeyAction(keyRow.id)}
        errorTitle={t('revokeFailed')}
        success={t('revokedToast')}
      />
    </>
  );
}
