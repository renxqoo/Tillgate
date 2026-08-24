'use client';

// 新建 custom 权限节点弹窗（type/父子/码在创建时定死）

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
import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { createPermissionAction } from '@/server/rbac-actions';
import { type NodeType, parentOptionsOf } from './node-shared';

/** 新建 custom 节点入口（页头 actions 插槽;type/父子/码在创建时定死） */
export function CreateNodeForm({ nodes }: { nodes: PermissionNode[] }) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [type, setType] = useState<NodeType>('button');
  const formId = 'node-form-create';

  const parentOptions = parentOptionsOf(nodes, type);

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
              const res = await createPermissionAction({
                parentId: data.get('parentId') ? Number(data.get('parentId')) : null,
                type,
                code: String(data.get('code') ?? '').trim() || null,
                name: String(data.get('name') ?? '').trim(),
                path: type === 'page' ? String(data.get('path') ?? '') || null : null,
                icon: type === 'page' ? String(data.get('icon') ?? '') || null : null,
                sortOrder: Number(data.get('sortOrder') ?? 0),
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
            <FieldLabel htmlFor="node-type">{t('nodeType')}</FieldLabel>
            <NativeSelect
              id="node-type"
              value={type}
              onChange={(e) => setType(e.target.value as NodeType)}
              name="type"
            >
              <NativeSelectOption value="button">{t('typeButton')}</NativeSelectOption>
              <NativeSelectOption value="page">{t('typePage')}</NativeSelectOption>
              <NativeSelectOption value="group">{t('typeGroup')}</NativeSelectOption>
            </NativeSelect>
          </FormItem>
          {type !== 'group' && (
            <FormItem>
              <FieldLabel htmlFor="node-parent">{t('parent')}</FieldLabel>
              <NativeSelect id="node-parent" name="parentId" required>
                {parentOptions.map((option) => (
                  <NativeSelectOption key={option.id} value={String(option.id)}>
                    {option.name}
                    {option.code != null ? `（${option.code}）` : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormItem>
          )}
          {type !== 'group' && (
            <FormItem>
              <FieldLabel htmlFor="node-code">{t('code')}</FieldLabel>
              <Input id="node-code" name="code" placeholder="custom:action" maxLength={64} />
              <FieldDescription>{t('customCodeHint')}</FieldDescription>
            </FormItem>
          )}
          <FormItem>
            <FieldLabel htmlFor="node-create-name">{tc('name')}</FieldLabel>
            <Input id="node-create-name" name="name" required maxLength={128} />
          </FormItem>
          {type === 'page' && (
            <>
              <FormItem>
                <FieldLabel htmlFor="node-create-path">{t('path')}</FieldLabel>
                <Input
                  id="node-create-path"
                  name="path"
                  placeholder="/dashboard/xxx"
                  maxLength={255}
                />
              </FormItem>
              <FormItem>
                <FieldLabel htmlFor="node-create-icon">{t('icon')}</FieldLabel>
                <Input id="node-create-icon" name="icon" maxLength={64} />
              </FormItem>
            </>
          )}
          <FormItem>
            <FieldLabel htmlFor="node-create-sort">{t('sortOrder')}</FieldLabel>
            <Input
              id="node-create-sort"
              name="sortOrder"
              type="number"
              defaultValue={0}
              min={0}
              max={9999}
            />
          </FormItem>
        </form>
      )}
    </FormDialog>
  );
}
