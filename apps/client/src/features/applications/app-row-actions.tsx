'use client';

// 应用行操作：启用态可轮换密钥/删除（弹窗受控挂在菜单外），停用态整组不可达

import { useState } from 'react';

import { RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DropdownMenuItem, DropdownMenuSeparator, RowActions } from '@tillgate/ui';
import type { AppRow } from '@tillgate/api-client';

import { ConfirmAction } from '@/features/shared/confirm-action';
import { deleteAppAction } from '@/server/actions/apps';

import { RotateSecretInline } from './rotate-secret-dialog';

export function AppRowActions({ app }: { app: AppRow }) {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <RowActions label={tCommon('actions')}>
        {app.status === 0 ? (
          <>
            <DropdownMenuItem onClick={() => setRotateOpen(true)}>
              <RefreshCwIcon /> {t('rotateSecret')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2Icon /> {tCommon('delete')}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem disabled>{t('statusDisabled')}</DropdownMenuItem>
        )}
      </RowActions>
      <RotateSecretInline
        id={app.id}
        name={app.name}
        trigger={null}
        open={rotateOpen}
        onOpenChange={setRotateOpen}
      />
      {/* 弹窗挂在菜单外(受控 open):菜单点选关闭时会卸载整个 content,放里面会连弹窗一起卸掉 */}
      <ConfirmAction
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        confirm={t('deleteConfirm', { name: app.name })}
        action={async () => deleteAppAction(app.id)}
        errorTitle={tCommon('deleteFailed')}
        success={t('deletedToast')}
      />
    </>
  );
}
