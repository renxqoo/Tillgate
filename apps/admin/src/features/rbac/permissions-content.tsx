'use client';

import type { PermissionNode } from '@tokenlens/api-client';
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  Input,
  NativeSelect,
  NativeSelectOption,
  RowActions,
} from '@tokenlens/ui';
import { useState } from 'react';
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import {
  createPermissionAction,
  deletePermissionAction,
  updatePermissionAction,
} from '@/server/rbac-actions';

type NodeType = 'group' | 'page' | 'button';

const TYPE_ORDER: Record<NodeType, number> = { group: 0, page: 1, button: 2 };

/** 编辑弹窗（展示字段;code/type/父子恒不可改——码即身份;受控:RowActions 菜单触发） */
function NodeEditDialog({
  node,
  open,
  onOpenChange,
}: {
  node: PermissionNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const formId = `node-edit-form-${node.id}`;

  return (
    <FormDialog
      formId={formId}
      open={open}
      onOpenChange={onOpenChange}
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
                code: String(data.get('code') ?? '').trim() || null,
                status: Number(data.get('status') ?? node.status),
                ...(node.type === 'page'
                  ? {
                      path: String(data.get('path') ?? '') || null,
                      icon: String(data.get('icon') ?? '') || null,
                    }
                  : {}),
                sortOrder: Number(data.get('sortOrder') ?? node.sortOrder),
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

/** 行操作（统一 RowActions 三点菜单）：编辑;删除仅 custom */
function NodeRowActions({
  node,
  onDelete,
}: {
  node: PermissionNode;
  onDelete: (node: PermissionNode) => void;
}) {
  const tc = useTranslations('common');
  const [editOpen, setEditOpen] = useState(false);

  return (
    <>
      <NodeEditDialog node={node} open={editOpen} onOpenChange={setEditOpen} />
      <RowActions label={tc('actions')}>
        <DropdownMenuItem onClick={() => setEditOpen(true)}>
          <PencilIcon className="size-4" />
          {tc('edit')}
        </DropdownMenuItem>
        {node.source === 'custom' && (
          <DropdownMenuItem onClick={() => onDelete(node)}>
            <Trash2Icon className="size-4" />
            {tc('delete')}
          </DropdownMenuItem>
        )}
      </RowActions>
    </>
  );
}

/** 资源清单（通用 DataTable;层级上下文经「父节点」列呈现,排序 目录→页面→按钮） */
export function PermissionsContent({ nodes }: { nodes: PermissionNode[] }) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [deleting, setDeleting] = useState<PermissionNode | null>(null);

  const nameById = new Map(nodes.map((node) => [node.id, node.name]));
  const rows = nodes.toSorted(
    (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.sortOrder - b.sortOrder || a.id - b.id,
  );

  const columns: DataTableColumn<PermissionNode>[] = [
    {
      key: 'name',
      header: tc('name'),
      render: (node) => <span className="font-medium">{node.name}</span>,
    },
    {
      key: 'type',
      header: t('nodeType'),
      render: (node) => <Badge variant="secondary">{t(`type_${node.type}`)}</Badge>,
    },
    {
      key: 'parent',
      header: t('parent'),
      render: (node) => (node.parentId != null ? (nameById.get(node.parentId) ?? '—') : '—'),
    },
    {
      key: 'code',
      header: t('code'),
      render: (node) => (
        <span className="font-mono text-xs text-muted-foreground">{node.code ?? '—'}</span>
      ),
    },
    {
      key: 'path',
      header: t('path'),
      render: (node) => (
        <span className="font-mono text-xs text-muted-foreground">{node.path ?? '—'}</span>
      ),
    },
    {
      key: 'source',
      header: t('sourceColumn'),
      render: (node) =>
        node.source === 'enforced' ? (
          <Badge>{t('enforced')}</Badge>
        ) : (
          <Badge variant="outline">{t('custom')}</Badge>
        ),
    },
    {
      key: 'status',
      header: tc('status'),
      render: (node) =>
        node.status === 0 ? (
          <span className="text-sm text-muted-foreground">{tc('enabled')}</span>
        ) : (
          <Badge variant="destructive">{tc('disabled')}</Badge>
        ),
    },
    {
      key: 'actions',
      header: tc('actions'),
      render: (node) => <NodeRowActions node={node} onDelete={setDeleting} />,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <CreateNodeForm nodes={nodes} />
      </div>
      <DataTable rowKey={(node) => node.id} rows={rows} columns={columns} empty={t('empty')} />
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
