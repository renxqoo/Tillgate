'use client';

import {
  Button,
  FieldDescription,
  FieldLabel,
  FormItem,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@tokenlens/ui';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { createAdminAction } from '@/server/admins-actions';

/** 角色清单由页面注入（GET /v1/roles——动态角色,不再静态词表） */
export interface RoleOption {
  readonly id: number;
  readonly code: string;
  readonly name: string;
}

const FORM_ID = 'admin-create-form';

/** 创建管理员（admins:create 显隐由页面控制——无权限不渲染本组件） */
export function AdminCreateForm({ roles }: { roles: readonly RoleOption[] }) {
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
                roleId: Number(data.get('roleId') ?? roles[0]?.id ?? 0),
              });
              return notify(res, t('createFailed'), t('created'));
            });
          }}
        >
          <FormItem>
            <FieldLabel htmlFor="admin-email">{tc('email')}</FieldLabel>
            <Input id="admin-email" name="email" type="email" required maxLength={255} />
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="admin-display-name">{tc('displayName')}</FieldLabel>
            <Input id="admin-display-name" name="displayName" maxLength={64} />
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="admin-password">{t('initialPassword')}</FieldLabel>
            <Input
              id="admin-password"
              name="password"
              type="text"
              required
              minLength={8}
              maxLength={128}
            />
            <FieldDescription>{t('initialPasswordHint')}</FieldDescription>
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="admin-role">{t('role')}</FieldLabel>
            <NativeSelect id="admin-role" name="roleId" defaultValue={String(roles[0]?.id ?? '')}>
              {roles.map((role) => (
                <NativeSelectOption key={role.id} value={String(role.id)}>
                  {role.name}（{role.code}）
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormItem>
        </form>
      )}
    </FormDialog>
  );
}
