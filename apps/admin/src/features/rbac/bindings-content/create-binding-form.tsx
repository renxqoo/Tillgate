'use client';

// 新建接口绑定弹窗（页头 actions 插槽）

import type { PermissionNode } from '@tillgate/api-client';
import {
  Button,
  FieldDescription,
  FieldLabel,
  FormItem,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@tillgate/ui';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { createBindingAction } from '@/server/binding-actions';
import { type Method, METHODS } from './binding-shared';

/** 新建绑定入口（页头 actions 插槽） */
export function CreateBindingForm({ nodes }: { nodes: PermissionNode[] }) {
  const t = useTranslations('endpoints');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const formId = 'binding-form-create';
  const coded = nodes.filter((node) => node.code != null && node.status === 0);
  return (
    <FormDialog
      formId={formId}
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
          id={formId}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const res = await createBindingAction({
                method: String(data.get('method')) as Method,
                path: String(data.get('path') ?? '').trim(),
                permissionId: Number(data.get('permissionId')),
              });
              if (res.errorKey) {
                toast.error(t(`errors.${res.errorKey}`));
                return false;
              }
              return notify(res, t('actionFailed'), t('created'));
            });
          }}
        >
          <FormItem>
            <FieldLabel htmlFor="binding-method">{t('method')}</FieldLabel>
            <NativeSelect id="binding-method" name="method" defaultValue="GET">
              {METHODS.map((method) => (
                <NativeSelectOption key={method} value={method}>
                  {method}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="binding-path">{t('path')}</FieldLabel>
            <Input
              id="binding-path"
              name="path"
              placeholder="/v1/example/:id"
              required
              maxLength={255}
            />
            <FieldDescription>{t('pathHint')}</FieldDescription>
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="binding-permission">{t('permission')}</FieldLabel>
            <NativeSelect id="binding-permission" name="permissionId" required>
              {coded.map((node) => (
                <NativeSelectOption key={node.id} value={String(node.id)}>
                  {node.name}（{node.code}）
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormItem>
        </form>
      )}
    </FormDialog>
  );
}
