'use client';

import type { PermissionNode } from '@tokenlens/api-client';
import { Badge, Button, Input, NativeSelect, NativeSelectOption } from '@tokenlens/ui';
import { useState } from 'react';
import { LockIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { FormDialog } from '@/components/form-dialog';
import { ConfirmDialog } from '@tokenlens/ui';
import { useActionResult } from '@/components/action-toast';
import {
  createPermissionAction,
  deletePermissionAction,
  updatePermissionAction,
} from '@/server/rbac-actions';

type NodeType = 'group' | 'page' | 'button';

/** 节点编辑（展示字段;code/type/父子恒不可改——码即身份） */
function NodeForm({ node }: { node: PermissionNode }) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const formId = `node-form-${node.id}`;
  return (
    <FormDialog
      formId={formId}
      trigger={
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          title={tc('edit')}
        >
          <PencilIcon className="size-4" />
        </button>
      }
      title={t('editTitle', { name: node.name })}
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
                name: String(data.get('name') ?? '').trim(),
                icon: node.type === 'page' ? String(data.get('icon') ?? '') || null : undefined,
                sortOrder: Number(data.get('sortOrder') ?? node.sortOrder),
                ...(node.source === 'custom' ? { status: Number(data.get('status') ?? 0) } : {}),
              });
              if (res.errorKey) {
                toast.error(t(`errors.${res.errorKey}`));
                return false;
              }
              return notify(res, t('actionFailed'), t('updated'));
            });
          }}
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{tc('name')}</label>
            <Input name="name" defaultValue={node.name} required maxLength={128} />
          </div>
          {node.type === 'page' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('icon')}</label>
              <Input name="icon" defaultValue={node.icon ?? ''} maxLength={64} />
              <p className="text-xs text-muted-foreground">{t('iconHint')}</p>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('sortOrder')}</label>
            <Input
              name="sortOrder"
              type="number"
              defaultValue={node.sortOrder}
              min={0}
              max={9999}
            />
          </div>
          {node.source === 'custom' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{tc('status')}</label>
              <NativeSelect name="status" defaultValue={String(node.status)}>
                <NativeSelectOption value="0">{tc('enabled')}</NativeSelectOption>
                <NativeSelectOption value="1">{tc('disabled')}</NativeSelectOption>
              </NativeSelect>
              <p className="text-xs text-muted-foreground">{t('statusHint')}</p>
            </div>
          )}
          {node.source === 'enforced' && (
            <p className="text-xs text-muted-foreground">{t('enforcedHint')}</p>
          )}
        </form>
      )}
    </FormDialog>
  );
}

/** 新建 custom 节点（type/父子/码在创建时定死） */
function CreateNodeForm({ nodes }: { nodes: PermissionNode[] }) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [type, setType] = useState<NodeType>('button');
  const formId = 'node-form-create';

  const parentOptions =
    type === 'button'
      ? nodes.filter((n) => n.type === 'page')
      : type === 'page'
        ? nodes.filter((n) => n.type === 'group')
        : [];

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
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('nodeType')}</label>
            <NativeSelect
              value={type}
              onChange={(e) => setType(e.target.value as NodeType)}
              name="type"
            >
              <NativeSelectOption value="button">{t('typeButton')}</NativeSelectOption>
              <NativeSelectOption value="page">{t('typePage')}</NativeSelectOption>
              <NativeSelectOption value="group">{t('typeGroup')}</NativeSelectOption>
            </NativeSelect>
          </div>
          {type !== 'group' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('parent')}</label>
              <NativeSelect name="parentId" required>
                {parentOptions.map((option) => (
                  <NativeSelectOption key={option.id} value={String(option.id)}>
                    {option.name}
                    {option.code != null ? `（${option.code}）` : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {type !== 'group' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('code')}</label>
              <Input name="code" placeholder="custom:action" maxLength={64} />
              <p className="text-xs text-muted-foreground">{t('customCodeHint')}</p>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{tc('name')}</label>
            <Input name="name" required maxLength={128} />
          </div>
          {type === 'page' && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('path')}</label>
                <Input name="path" placeholder="/dashboard/xxx" maxLength={255} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('icon')}</label>
                <Input name="icon" maxLength={64} />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('sortOrder')}</label>
            <Input name="sortOrder" type="number" defaultValue={0} min={0} max={9999} />
          </div>
        </form>
      )}
    </FormDialog>
  );
}

export function PermissionsContent({ nodes }: { nodes: PermissionNode[] }) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [deleting, setDeleting] = useState<PermissionNode | null>(null);

  const groups = nodes
    .filter((n) => n.type === 'group')
    .toSorted((a, b) => a.sortOrder - b.sortOrder);
  const pages = nodes.filter((n) => n.type === 'page');
  const buttons = nodes.filter((n) => n.type === 'button');

  const nodeLine = (node: PermissionNode, depth: number) => (
    <div
      key={node.id}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
      style={{ marginLeft: depth * 20 }}
    >
      <span className="min-w-40 text-sm font-medium">{node.name}</span>
      {node.code != null && (
        <span className="font-mono text-xs text-muted-foreground">{node.code}</span>
      )}
      <Badge variant={node.type === 'group' ? 'outline' : 'secondary'}>
        {t(`type_${node.type}`)}
      </Badge>
      {node.source === 'enforced' ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <LockIcon className="size-3" />
          {t('enforced')}
        </span>
      ) : (
        <Badge variant="outline">{t('custom')}</Badge>
      )}
      {node.status === 1 && <Badge variant="destructive">{tc('disabled')}</Badge>}
      {node.type === 'page' && node.path != null && (
        <span className="font-mono text-xs text-muted-foreground">{node.path}</span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <NodeForm node={node} />
        {node.source === 'custom' && (
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            title={tc('delete')}
            onClick={() => setDeleting(node)}
          >
            <Trash2Icon className="size-4" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <CreateNodeForm nodes={nodes} />
      </div>
      <div className="rounded-lg border p-3">
        {groups.map((group) => {
          const groupPages = pages
            .filter((page) => page.parentId === group.id)
            .toSorted((a, b) => a.sortOrder - b.sortOrder);
          return (
            <div key={group.id} className="space-y-1 pb-3">
              {nodeLine(group, 0)}
              {groupPages.map((page) => (
                <div key={page.id} className="space-y-0.5">
                  {nodeLine(page, 1)}
                  {buttons
                    .filter((button) => button.parentId === page.id)
                    .toSorted((a, b) => a.sortOrder - b.sortOrder)
                    .map((button) => nodeLine(button, 2))}
                </div>
              ))}
            </div>
          );
        })}
        {groups.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">{t('empty')}</div>
        )}
      </div>
      <ConfirmDialog
        open={deleting != null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('deleteTitle', { name: deleting?.name ?? '' })}
        description={t('deleteDescription')}
        confirmLabel={tc('delete')}
        cancelLabel={tc('close')}
        tone="destructive"
        onConfirm={async () => {
          if (deleting == null) return;
          const res = await deletePermissionAction(deleting.id);
          if (res.errorKey) toast.error(t(`errors.${res.errorKey}`));
          else notify(res, t('actionFailed'), t('deleted'));
          setDeleting(null);
        }}
      />
    </div>
  );
}
