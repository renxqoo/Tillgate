'use client';

import type { EndpointBindingRow, PermissionNode } from '@tokenlens/api-client';
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  FieldDescription,
  FieldLabel,
  FormItem,
  Input,
  NativeSelect,
  NativeSelectOption,
  RowActions,
} from '@tokenlens/ui';
import { useState } from 'react';
import { PencilIcon, PlusIcon, UnlinkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { createBindingAction, deleteBindingAction, updateBindingAction } from '@/server/binding-actions';

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const METHODS: readonly Method[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

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
            <Input id="binding-path" name="path" placeholder="/v1/example/:id" required maxLength={255} />
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

/** 编辑弹窗（全字段:method/path/permission 部分更新;受控:RowActions 菜单触发） */
function EditBindingDialog({
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
            <FieldLabel htmlFor={`binding-edit-permission-${binding.id}`}>{t('permission')}</FieldLabel>
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

/** 接口绑定清单（DataTable:method/path/权限码/来源/操作;分页/标题在页面层 ListPage） */
export function BindingsContent({
  bindings,
  nodes,
}: {
  bindings: EndpointBindingRow[];
  nodes: PermissionNode[];
}) {
  const t = useTranslations('endpoints');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [editing, setEditing] = useState<EndpointBindingRow | null>(null);
  const [deleting, setDeleting] = useState<EndpointBindingRow | null>(null);

  const codeById = new Map(nodes.map((node) => [node.id, node.code ?? node.name]));
  const rows = bindings.toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

  const columns: DataTableColumn<EndpointBindingRow>[] = [
    {
      key: 'method',
      header: t('method'),
      render: (row) => <Badge variant="secondary">{row.method}</Badge>,
    },
    {
      key: 'path',
      header: t('path'),
      render: (row) => <span className="font-mono text-xs">{row.path}</span>,
    },
    {
      key: 'code',
      header: t('permission'),
      render: (row) => (
        <span className="font-mono text-xs text-muted-foreground">
          {codeById.get(row.permissionId) ?? `#${row.permissionId}`}
        </span>
      ),
    },
    {
      key: 'source',
      header: t('sourceColumn'),
      render: (row) => (
        <Badge variant={row.source === 'enforced' ? 'default' : 'outline'}>
          {row.source === 'enforced' ? t('enforced') : t('custom')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: tc('actions'),
      render: (row) => (
        <>
          {editing?.id === row.id && (
            <EditBindingDialog
              binding={row}
              nodes={nodes}
              open={editing != null}
              onOpenChange={(open) => !open && setEditing(null)}
            />
          )}
          <RowActions label={tc('actions')}>
            <DropdownMenuItem onClick={() => setEditing(row)}>
              <PencilIcon className="size-4" />
              {tc('edit')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDeleting(row)}>
              <UnlinkIcon className="size-4" />
              {t('unbind')}
            </DropdownMenuItem>
          </RowActions>
        </>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <DataTable rowKey={(row) => row.id} rows={rows} columns={columns} empty={t('empty')} />
      <ConfirmDialog
        open={deleting != null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('unbindTitle', { method: deleting?.method ?? '', path: deleting?.path ?? '' })}
        description={t('unbindDescription')}
        confirmLabel={t('unbind')}
        cancelLabel={tc('close')}
        tone="destructive"
        onConfirm={async () => {
          if (deleting == null) return;
          const res = await deleteBindingAction(deleting.id);
          if (res.errorKey) toast.error(t(`errors.${res.errorKey}`));
          else notify(res, t('actionFailed'), t('unbound'));
          setDeleting(null);
        }}
      />
    </div>
  );
}
