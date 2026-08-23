'use client';

import { NativeSelect, NativeSelectOption } from '@tokenlens/ui';
import { useState } from 'react';
import { Loader2Icon, PencilIcon, ShieldBanIcon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { toggleAdminStatusAction, updateAdminRoleAction } from '@/server/admins-actions';

/** 与 admin-create-form 同词表（值 = 后端 domain/rbac ADMIN_ROLES;label 为 i18n key） */
const ROLES = [
  { id: 'super_admin', label: 'roleSuperAdmin' },
  { id: 'operator', label: 'roleOperator' },
  { id: 'finance', label: 'roleFinance' },
  { id: 'support', label: 'roleSupport' },
  { id: 'viewer', label: 'roleViewer' },
] as const;

/**
 * 行操作：改角色（小弹窗）/ 封禁与恢复（确认即发）。
 * 「不可改自身 role/status」由后端守卫——此处仅禁用自身行的操作入口（UX 提前）。
 */
export function AdminRowActions({
  id,
  role,
  status,
  self,
}: {
  id: number;
  role: string;
  status: number;
  self: boolean;
}) {
  const t = useTranslations('admins');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, setPending] = useState<string | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);

  async function runToggle() {
    setPending('toggle');
    const res = await toggleAdminStatusAction(id, status === 0 ? 1 : 0);
    setPending(null);
    notify(res, t('updateFailed'));
  }

  return (
    <div className="flex items-center gap-1">
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
              const next = String(new FormData(e.currentTarget).get('role') ?? role);
              run(async () => {
                const res = await updateAdminRoleAction(id, next);
                return notify(res, t('updateFailed'), t('roleUpdated'));
              });
            }}
          >
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor={`admin-role-${id}`}>
                {t('role')}
              </label>
              <NativeSelect id={`admin-role-${id}`} name="role" defaultValue={role}>
                {ROLES.map((option) => (
                  <NativeSelectOption key={option.id} value={option.id}>
                    {t(option.label)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">{t('changeRoleHint')}</p>
            </div>
          </form>
        )}
      </FormDialog>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
        disabled={self}
        title={self ? t('cannotModifySelf') : t('changeRole')}
        onClick={() => setRoleOpen(true)}
      >
        <PencilIcon className="size-4" />
      </button>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
        disabled={self || pending !== null}
        title={self ? t('cannotModifySelf') : status === 0 ? t('ban') : t('restore')}
        onClick={runToggle}
      >
        {pending === 'toggle' ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : status === 0 ? (
          <ShieldBanIcon className="size-4" />
        ) : (
          <ShieldCheckIcon className="size-4" />
        )}
      </button>
    </div>
  );
}
