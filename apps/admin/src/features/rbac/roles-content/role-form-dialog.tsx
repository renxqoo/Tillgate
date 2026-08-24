'use client';

// 角色编辑/创建共享表单弹窗（码树勾选 = 授权全量替换;trigger 创建用,受控 open 行内编辑用）

import type { PermissionNode, RoleRow } from '@tillgate/api-client';
import {
  FieldDescription,
  FieldLabel,
  FormItem,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@tillgate/ui';
import type * as React from 'react';
import { useState } from 'react';
import { Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { createRoleAction, updateRoleAction } from '@/server/rbac-actions';
import { GrantTree } from './grant-tree';

export interface RoleRowWithGrants extends RoleRow {
  adminCount: number;
  codes: string[];
}

/** 角色编辑/创建表单（码树勾选 = 授权全量替换;trigger 创建用,受控 open 行内编辑用） */
export function RoleFormDialog({
  role,
  nodes,
  trigger,
  open,
  onOpenChange,
}: {
  role?: RoleRowWithGrants;
  nodes: PermissionNode[];
  trigger?: React.ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('roles');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.codes ?? []));

  const toggle = (code: string, next: boolean) => {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(code);
      else copy.delete(code);
      return copy;
    });
  };

  const formId = `role-form-${role?.id ?? 'create'}`;
  const nameId = `role-name-${role?.id ?? 'new'}`;

  return (
    <FormDialog
      formId={formId}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      title={role ? t('editTitle', { name: role.name }) : t('createTitle')}
      description={t('formDescription')}
      submitLabel={role ? tc('save') : tc('create')}
    >
      {({ run, pending }) => (
        <form
          id={formId}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const name = String(data.get('name') ?? '').trim();
              const res = role
                ? await updateRoleAction(role.id, {
                    name,
                    status: Number(data.get('status') ?? role.status),
                    permissions: [...selected],
                  })
                : await createRoleAction({
                    code: String(data.get('code') ?? ''),
                    name,
                    permissions: [...selected],
                  });
              if (res.errorKey) {
                toast.error(t(`errors.${res.errorKey}`));
                return false;
              }
              return notify(res, t('actionFailed'), role ? t('updated') : t('created'));
            });
          }}
        >
          {role == null && (
            <FormItem>
              <FieldLabel htmlFor="role-code">{t('code')}</FieldLabel>
              <Input id="role-code" name="code" required maxLength={64} />
              <FieldDescription>{t('codeHint')}</FieldDescription>
            </FormItem>
          )}
          <FormItem>
            <FieldLabel htmlFor={nameId}>{tc('name')}</FieldLabel>
            <Input id={nameId} name="name" defaultValue={role?.name} required maxLength={128} />
          </FormItem>
          {role != null && (
            <FormItem>
              <FieldLabel htmlFor={`role-status-${role.id}`}>{tc('status')}</FieldLabel>
              <NativeSelect
                id={`role-status-${role.id}`}
                name="status"
                defaultValue={String(role.status)}
              >
                <NativeSelectOption value="0">{tc('enabled')}</NativeSelectOption>
                <NativeSelectOption value="1">{tc('disabled')}</NativeSelectOption>
              </NativeSelect>
              <FieldDescription>{t('statusHint')}</FieldDescription>
            </FormItem>
          )}
          <FormItem>
            <FieldLabel>{t('grants')}</FieldLabel>
            <GrantTree
              nodes={nodes}
              selected={selected}
              onToggle={(code, next) => {
                toggle(code, next);
                // 勾按钮自动勾所属页面读码（UI 便利;后端无硬不变量）
                if (next) {
                  const button = nodes.find((n) => n.code === code);
                  if (button != null) {
                    const page = nodes.find((n) => n.id === button.parentId);
                    if (page?.code != null) toggle(page.code, true);
                  }
                }
              }}
            />
          </FormItem>
          {pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
        </form>
      )}
    </FormDialog>
  );
}
