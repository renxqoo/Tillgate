'use client';

import { Button, Input, NativeSelect, NativeSelectOption } from '@tokenlens/ui';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { createAdminAction } from '@/server/admins-actions';

/** 角色词表（值与后端 domain/rbac ADMIN_ROLES 一致;label 是 admins 命名空间 i18n key） */
const ROLES = [
  { id: 'super_admin', label: 'roleSuperAdmin' },
  { id: 'operator', label: 'roleOperator' },
  { id: 'finance', label: 'roleFinance' },
  { id: 'support', label: 'roleSupport' },
  { id: 'viewer', label: 'roleViewer' },
] as const;

const FORM_ID = 'admin-create-form';

/** 创建管理员（admins:write 显隐由页面控制——无权限不渲染本组件） */
export function AdminCreateForm() {
  const t = useTranslations('admins');
  const tc = useTranslations('common');
  const notify = useActionResult();

  return (
    <FormDialog
      formId={FORM_ID}
      trigger={
        <Button size="sm">
          <PlusIcon className="size-4" />
          {t('create')}
        </Button>
      }
      title={t('createTitle')}
      description={t('createDescription')}
      submitLabel={tc('create')}
    >
      {({ run }) => (
        <form
          id={FORM_ID}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const res = await createAdminAction({
                email: String(data.get('email') ?? ''),
                displayName: String(data.get('displayName') ?? '').trim() || undefined,
                password: String(data.get('password') ?? ''),
                role: String(data.get('role') ?? 'viewer') as (typeof ROLES)[number]['id'],
              });
              return notify(res, t('createFailed'), t('created'));
            });
          }}
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="admin-email">
              {tc('email')}
            </label>
            <Input id="admin-email" name="email" type="email" required maxLength={255} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="admin-display-name">
              {tc('displayName')}
            </label>
            <Input id="admin-display-name" name="displayName" maxLength={64} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="admin-password">
              {t('initialPassword')}
            </label>
            <Input
              id="admin-password"
              name="password"
              type="text"
              required
              minLength={8}
              maxLength={128}
            />
            <p className="text-xs text-muted-foreground">{t('initialPasswordHint')}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="admin-role">
              {t('role')}
            </label>
            <NativeSelect id="admin-role" name="role" defaultValue="viewer">
              {ROLES.map((role) => (
                <NativeSelectOption key={role.id} value={role.id}>
                  {t(role.label)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </form>
      )}
    </FormDialog>
  );
}
