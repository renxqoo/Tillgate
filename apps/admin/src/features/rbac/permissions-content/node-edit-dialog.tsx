'use client';

// 权限节点编辑弹窗：全字段（码/类型/父子移动;type 联动父选项与字段显隐,结构校验后端兜底）

import type { PermissionNode } from '@tillgate/api-client';
import {
  FieldDescription,
  FieldLabel,
  FormItem,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@tillgate/ui';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { updatePermissionAction } from '@/server/rbac-actions';
import { type NodeType, parentOptionsOf } from './node-shared';

/** 表单字段 → trim 后非空字符串（空串 → null） */
function textOrNull(data: FormData, key: string): string | null {
  const value = String(data.get(key) ?? '').trim();
  return value !== '' ? value : null;
}

/** 编辑表单值 → 权限节点更新载荷（按节点类型分流可空字段） */
function toPermissionUpdatePayload(ctx: {
  node: PermissionNode;
  type: NodeType;
  parentId: number | null;
  data: FormData;
}): Parameters<typeof updatePermissionAction>[1] {
  const { node, type, parentId, data } = ctx;
  return {
    type,
    parentId: type === 'group' ? null : (parentId ?? node.parentId),
    code: type === 'group' ? null : textOrNull(data, 'code'),
    name: String(data.get('name') ?? '').trim(),
    path: type === 'page' ? textOrNull(data, 'path') : null,
    icon: type === 'page' ? textOrNull(data, 'icon') : null,
    i18nKey: textOrNull(data, 'i18nKey'),
    description: textOrNull(data, 'description'),
    sortOrder: Number(data.get('sortOrder') ?? node.sortOrder),
    status: Number(data.get('status') ?? node.status),
  };
}

/** 编辑弹窗表单体：全字段平铺（type 联动父选项与字段显隐）——从 NodeEditDialog 提出 */
// eslint-disable-next-line max-lines-per-function -- 全字段表单平铺（10 个字段的 UI 声明，非控制流），拆分收益为负
function NodeEditFormBody(ctx: {
  node: PermissionNode;
  nodes: PermissionNode[];
  formId: string;
  type: NodeType;
  setType: (next: NodeType) => void;
  parentId: number | null;
  setParentId: Dispatch<SetStateAction<number | null>>;
  parentOptions: PermissionNode[];
  parentValid: boolean;
  run: (fn: () => Promise<boolean>) => void;
  t: ReturnType<typeof useTranslations<'permissions'>>;
  tc: ReturnType<typeof useTranslations<'common'>>;
}) {
  const {
    node,
    nodes,
    formId,
    type,
    setType,
    parentId,
    setParentId,
    parentOptions,
    parentValid,
    run,
    t,
    tc,
  } = ctx;
  const notify = useActionResult();
  return (
    <form
      id={formId}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        run(async () => {
          const res = await updatePermissionAction(node.id, {
            ...toPermissionUpdatePayload({ node, type, parentId, data }),
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
        <FieldLabel htmlFor={`node-type-${node.id}`}>{t('nodeType')}</FieldLabel>
        <NativeSelect
          id={`node-type-${node.id}`}
          value={type}
          onChange={(e) => {
            const next = e.target.value as NodeType;
            setType(next);
            // 类型切换后原父节点可能不再合法——回落到首个合法父
            const opts = parentOptionsOf(nodes, next);
            setParentId((current) =>
              current != null && opts.some((o) => o.id === current)
                ? current
                : (opts[0]?.id ?? null),
            );
          }}
          name="type"
        >
          <NativeSelectOption value="button">{t('typeButton')}</NativeSelectOption>
          <NativeSelectOption value="page">{t('typePage')}</NativeSelectOption>
          <NativeSelectOption value="group">{t('typeGroup')}</NativeSelectOption>
        </NativeSelect>
      </FormItem>
      {type !== 'group' && (
        <FormItem>
          <FieldLabel htmlFor={`node-parent-${node.id}`}>{t('parent')}</FieldLabel>
          <NativeSelect
            id={`node-parent-${node.id}`}
            name="parentId"
            value={(() => {
              if (parentValid) return String(parentId);
              const fallback = parentOptions[0]?.id;
              return fallback != null ? String(fallback) : '';
            })()}
            onChange={(e) => setParentId(Number(e.target.value))}
            required
          >
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
          <FieldLabel htmlFor={`node-code-${node.id}`}>{t('code')}</FieldLabel>
          <Input
            id={`node-code-${node.id}`}
            name="code"
            defaultValue={node.code ?? ''}
            required={type === 'button'}
            maxLength={64}
          />
          <FieldDescription>{t('codeEditHint')}</FieldDescription>
        </FormItem>
      )}
      <FormItem>
        <FieldLabel htmlFor={`node-name-${node.id}`}>{tc('name')}</FieldLabel>
        <Input
          id={`node-name-${node.id}`}
          name="name"
          defaultValue={node.name}
          required
          maxLength={128}
        />
      </FormItem>
      {type === 'page' && (
        <>
          <FormItem>
            <FieldLabel htmlFor={`node-path-${node.id}`}>{t('path')}</FieldLabel>
            <Input
              id={`node-path-${node.id}`}
              name="path"
              defaultValue={node.path ?? ''}
              maxLength={255}
            />
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor={`node-icon-${node.id}`}>{t('icon')}</FieldLabel>
            <Input
              id={`node-icon-${node.id}`}
              name="icon"
              defaultValue={node.icon ?? ''}
              maxLength={64}
            />
            <FieldDescription>{t('iconHint')}</FieldDescription>
          </FormItem>
        </>
      )}
      <FormItem>
        <FieldLabel htmlFor={`node-i18n-${node.id}`}>{t('i18nKeyField')}</FieldLabel>
        <Input
          id={`node-i18n-${node.id}`}
          name="i18nKey"
          defaultValue={node.i18nKey ?? ''}
          maxLength={128}
        />
        <FieldDescription>{t('i18nKeyHint')}</FieldDescription>
      </FormItem>
      <FormItem>
        <FieldLabel htmlFor={`node-desc-${node.id}`}>{t('descriptionField')}</FieldLabel>
        <Input
          id={`node-desc-${node.id}`}
          name="description"
          defaultValue={node.description ?? ''}
          maxLength={512}
        />
      </FormItem>
      <FormItem>
        <FieldLabel htmlFor={`node-sort-${node.id}`}>{t('sortOrder')}</FieldLabel>
        <Input
          id={`node-sort-${node.id}`}
          name="sortOrder"
          type="number"
          defaultValue={node.sortOrder}
          min={0}
          max={9999}
        />
      </FormItem>
      <FormItem>
        <FieldLabel htmlFor={`node-status-${node.id}`}>{tc('status')}</FieldLabel>
        <NativeSelect
          id={`node-status-${node.id}`}
          name="status"
          defaultValue={String(node.status)}
        >
          <NativeSelectOption value="0">{tc('enabled')}</NativeSelectOption>
          <NativeSelectOption value="1">{tc('disabled')}</NativeSelectOption>
        </NativeSelect>
        <FieldDescription>{t('statusHint')}</FieldDescription>
      </FormItem>
    </form>
  );
}

/** 编辑弹窗（全字段——含码/类型/父子移动;type 联动父选项与字段显隐,结构校验后端兜底） */
export function NodeEditDialog({
  node,
  nodes,
  open,
  onOpenChange,
}: {
  node: PermissionNode;
  nodes: PermissionNode[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const [type, setType] = useState<NodeType>(node.type);
  const [parentId, setParentId] = useState<number | null>(node.parentId);
  const formId = `node-edit-form-${node.id}`;

  const parentOptions = parentOptionsOf(nodes, type);
  const parentValid = parentId != null && parentOptions.some((o) => o.id === parentId);

  return (
    <FormDialog
      formId={formId}
      open={open}
      onOpenChange={onOpenChange}
      title={t('editTitle', { name: node.name })}
      description={t('editDescription')}
      submitLabel={tc('save')}
    >
      {({ run }) => (
        <NodeEditFormBody
          node={node}
          nodes={nodes}
          formId={formId}
          type={type}
          setType={setType}
          parentId={parentId}
          setParentId={setParentId}
          parentOptions={parentOptions}
          parentValid={parentValid}
          run={run}
          t={t}
          tc={tc}
        />
      )}
    </FormDialog>
  );
}
