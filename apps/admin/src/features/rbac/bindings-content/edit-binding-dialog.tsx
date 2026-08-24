'use client';

// 编辑接口绑定弹窗（全字段:method/path/permission 部分更新;受控:RowActions 菜单触发）

import type { EndpointBindingRow, PermissionNode } from '@tillgate/api-client';
import {
  FieldDescription,
  FieldLabel,
  FormItem,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { updateBindingAction } from '@/server/binding-actions';
import { type Method, METHODS } from './binding-shared';

/** 编辑弹窗（全字段:method/path/permission 部分更新;受控:RowActions 菜单触发） */
export function EditBindingDialog({
  binding,
  nodes,
  open,
  onOpenChange,
}: {
  binding: EndpointBindingRow;
  nodes: PermissionNode[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('endpoints');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const formId = `binding-edit-form-${binding.id}`;
  const coded = nodes.filter((node) => node.code != null && node.status === 0);
  return (
    <FormDialog
      formId={formId}
      open={open}
      onOpenChange={onOpenChange}
      title={t('editTitle', { method: binding.method, path: binding.path })}
      description={t('editDescription')}
      submitLabel={tc('save')}
    >
      {({ run }) => (
        <form
          id={formId}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const res = await updateBindingAction(binding.id, {
                method: String(data.get('method')) as Method,
                path: String(data.get('path') ?? '').trim(),
                permissionId: Number(data.get('permissionId')),
              });
              if (res.errorKey) {
                toast.error(t(`errors.${res.errorKey}`));
                return false;
              }
              return notify(res, t('actionFailed'), t('updated'));
            });
          }}
        >
          <FormItem>
            <FieldLabel htmlFor={`binding-edit-method-${binding.id}`}>{t('method')}</FieldLabel>
            <NativeSelect
              id={`binding-edit-method-${binding.id}`}
              name="method"
              defaultValue={binding.method}
            >
              {METHODS.map((method) => (
                <NativeSelectOption key={method} value={method}>
                  {method}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor={`binding-edit-path-${binding.id}`}>{t('path')}</FieldLabel>
            <Input
              id={`binding-edit-path-${binding.id}`}
              name="path"
              defaultValue={binding.path}
              placeholder="/v1/example/:id"
              required
              maxLength={255}
            />
            <FieldDescription>{t('pathHint')}</FieldDescription>
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor={`binding-edit-permission-${binding.id}`}>
              {t('permission')}
            </FieldLabel>
            <NativeSelect
              id={`binding-edit-permission-${binding.id}`}
              name="permissionId"
              defaultValue={String(binding.permissionId)}
            >
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
