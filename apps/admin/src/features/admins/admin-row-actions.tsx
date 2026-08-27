'use client';

import {
  DropdownMenuItem,
  FieldDescription,
  FieldLabel,
  FormItem,
  NativeSelect,
  NativeSelectOption,
  RowActions,
} from '@tillgate/ui';
import { useState } from 'react';
import {
  Loader2Icon,
  MailPlusIcon,
  PencilIcon,
  ShieldBanIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import {
  resendAdminInviteAction,
  toggleAdminStatusAction,
  updateAdminRoleAction,
} from '@/server/admins-actions';

import type { RoleOption } from './admin-create-form';

/**
 * 行操作（统一 RowActions 三点菜单）:变更角色（小弹窗）/ 封禁与恢复 /
 * 重发邀请邮件（邀请制——仅「待激活」行:未设密码且账号可用;已激活即隐藏,
 * 链接唯一用途是设置初始密码。canResend = admins:update,权威判定在后端 ACL）。
 * 「不可改自身 role/status」由后端守卫——此处仅禁用自身行的菜单项（UX 提前）。
 */
export function AdminRowActions({
  id,
  roleId,
  status,
  hasPassword,
  canResend,
  self,
  roles,
}: {
  id: number;
  roleId: number;
  status: number;
  hasPassword: boolean;
  canResend: boolean;
  self: boolean;
  roles: readonly RoleOption[];
}) {
  const t = useTranslations('admins');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, setPending] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  let statusIcon = <ShieldCheckIcon className="size-4" />;
  if (pending) statusIcon = <Loader2Icon className="size-4 animate-spin" />;
  else if (status === 0) statusIcon = <ShieldBanIcon className="size-4" />;

  const onToggleStatus = async () => {
    setPending(true);
    const res = await toggleAdminStatusAction(id, status === 0 ? 1 : 0);
    setPending(false);
    notify(res, t('updateFailed'));
  };

  const [invitePending, setInvitePending] = useState(false);
  const onResendInvite = async () => {
    setInvitePending(true);
    const res = await resendAdminInviteAction(id);
    setInvitePending(false);
    notify(res, t('resendFailed'), t('inviteResent'));
  };

  return (
    <>
      <FormDialog
        formId={`admin-role-form-${id}`}
        open={roleOpen}
        onOpenChange={setRoleOpen}
        title={t('changeRole')}
        submitLabel={tc('save')}
      >
        {({ run }) => (
          <form
            id={`admin-role-form-${id}`}
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const next = Number(new FormData(e.currentTarget).get('roleId') ?? roleId);
              run(async () => {
                const res = await updateAdminRoleAction(id, next);
                return notify(res, t('updateFailed'), t('roleUpdated'));
              });
            }}
          >
            <FormItem>
              <FieldLabel htmlFor={`admin-role-${id}`}>{t('role')}</FieldLabel>
              <NativeSelect id={`admin-role-${id}`} name="roleId" defaultValue={String(roleId)}>
                {roles.map((option) => (
                  <NativeSelectOption key={option.id} value={String(option.id)}>
                    {option.name}（{option.code}）
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>{t('changeRoleHint')}</FieldDescription>
            </FormItem>
          </form>
        )}
      </FormDialog>

      <RowActions label={tc('actions')}>
        <DropdownMenuItem
          disabled={self}
          onClick={() => setRoleOpen(true)}
          title={self ? t('cannotModifySelf') : undefined}
        >
          <PencilIcon className="size-4" />
          {t('changeRole')}
        </DropdownMenuItem>
        {canResend && !hasPassword && status === 0 && (
          <DropdownMenuItem disabled={invitePending} onClick={onResendInvite}>
            {invitePending ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <MailPlusIcon className="size-4" />
            )}
            {t('resendInvite')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={self || pending} onClick={onToggleStatus}>
          {statusIcon}
          {status === 0 ? t('ban') : t('restore')}
        </DropdownMenuItem>
      </RowActions>
    </>
  );
}
