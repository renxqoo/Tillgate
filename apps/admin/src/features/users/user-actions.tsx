'use client';

import { Button } from '@tillgate/ui';
import { useTransition } from 'react';
import { BriefcaseIcon, Loader2Icon, UserIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AdjustDialog } from '@/features/users/adjust-user-dialog';
import { GiftDialog } from '@/features/users/gift-user-dialog';
import { PasswordDialog } from '@/features/users/set-user-password-dialog';
import type { AdminUserRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';

/**
 * 用户详情页操作按钮组（弹窗实现在同目录 *-user-dialog 文件）。
 */
export function UserActions({ user }: { readonly user: AdminUserRow }) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  let enterpriseIcon = <BriefcaseIcon />;
  if (pending) enterpriseIcon = <Loader2Icon className="animate-spin" />;
  else if (user.isEnterprise) enterpriseIcon = <UserIcon />;

  function toggleEnterprise() {
    startTransition(async () => {
      const { setUserEnterpriseAction } = await import('@/server/users-actions');
      const res = await setUserEnterpriseAction(user.id, !user.isEnterprise);
      notify(
        res,
        tc('actionFailed'),
        user.isEnterprise ? t('removedEnterprise') : t('markedEnterprise'),
      );
    });
  }

  return (
    <div className="flex items-center gap-2">
      <AdjustDialog user={user} />
      <GiftDialog user={user} />
      <PasswordDialog user={user} />
      <Button
        size="sm"
        variant={user.isEnterprise ? 'secondary' : 'outline'}
        disabled={pending}
        title={user.isEnterprise ? t('removeEnterprise') : t('setEnterprise')}
        onClick={toggleEnterprise}
      >
        {enterpriseIcon}
        {user.isEnterprise ? t('removeEnterprise') : t('setEnterprise')}
      </Button>
    </div>
  );
}
