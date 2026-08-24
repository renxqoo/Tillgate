'use client';

import type { PermissionNode } from '@tokenlens/api-client';
import {
  Button,
  FieldDescription,
  FieldLabel,
  FormItem,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@tokenlens/ui';
import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { createPermissionAction, updatePermissionAction } from '@/server/rbac-actions';

type NodeType = 'group' | 'page' | 'button';

/** 按节点类型取合法父选项(button→页面页,page→分组,group→无) */
function parentOptionsOf(nodes: PermissionNode[], type: NodeType): PermissionNode[] {
  if (type === 'button') return nodes.filter((n) => n.type === 'page');
  if (type === 'page') return nodes.filter((n) => n.type === 'group');
  return [];
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
  const notify = useActionResult();
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
        <form
          id={formId}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const res = await updatePermissionAction(node.id, {
                type,
                parentId: type === 'group' ? null : (parentId ?? node.parentId),
                code: type === 'group' ? null : String(data.get('code') ?? '').trim() || null,
                name: String(data.get('name') ?? '').trim(),
                path: type === 'page' ? String(data.get('path') ?? '').trim() || null : null,
                icon: type === 'page' ? String(data.get('icon') ?? '').trim() || null : null,
                i18nKey: String(data.get('i18nKey') ?? '').trim() || null,
                description: String(data.get('description') ?? '').trim() || null,
                sortOrder: Number(data.get('sortOrder') ?? node.sortOrder),
                status: Number(data.get('status') ?? node.status),
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
      )}
    </FormDialog>
  );
}

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
