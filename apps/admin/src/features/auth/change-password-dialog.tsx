'use client';

/**
 * 管理员修改密码弹窗（账号菜单项受控打开）：验旧密 → 服务端换发新 token →
 * BFF 立即换 cookie（改密不登出）。表单级校验在 action 内（password-policy
 * 纯函数返回 i18n 键），此处只透传服务端 error 文案。
 */
import { useTranslations } from 'next-intl';

import { FieldGroup, FieldLabel, FormItem, PasswordInput } from '@tillgate/ui';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { changeMyPasswordAction } from '@/server/password-actions';

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('changePassword');
  const notify = useActionResult();

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      description={t('description')}
      submitLabel={t('submit')}
      formId="change-password-form"
    >
      {({ run }) => (
        <form
          method="post"
          id="change-password-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const fd = new FormData(event.currentTarget);
            run(async () => {
              const res = await changeMyPasswordAction({
                oldPassword: String(fd.get('oldPassword') ?? ''),
                newPassword: String(fd.get('newPassword') ?? ''),
                confirmPassword: String(fd.get('confirmPassword') ?? ''),
              });
              return notify(res, t('failed'), t('success'));
            });
          }}
        >
          <FieldGroup>
            <FormItem>
              <FieldLabel htmlFor="oldPassword">{t('oldPassword')}</FieldLabel>
              <PasswordInput
                id="oldPassword"
                name="oldPassword"
                autoComplete="current-password"
                placeholder={t('oldPasswordPlaceholder')}
                required
              />
            </FormItem>
            <FormItem>
              <FieldLabel htmlFor="newPassword">{t('newPassword')}</FieldLabel>
              <PasswordInput
                id="newPassword"
                name="newPassword"
                autoComplete="new-password"
                placeholder={t('newPasswordPlaceholder')}
                required
              />
            </FormItem>
            <FormItem>
              <FieldLabel htmlFor="confirmPassword">{t('confirmPassword')}</FieldLabel>
              <PasswordInput
                id="confirmPassword"
                name="confirmPassword"
                autoComplete="new-password"
                placeholder={t('confirmPasswordPlaceholder')}
                required
              />
            </FormItem>
          </FieldGroup>
        </form>
      )}
    </FormDialog>
  );
}
