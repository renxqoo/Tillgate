'use client';

import type { PermissionNode } from '@tokenlens/api-client';
import type { EndpointBindingRow } from '@tokenlens/api-client';
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
import { PlusIcon, UnlinkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import { createBindingAction, deleteBindingAction, rebindAction } from '@/server/binding-actions';

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const METHODS: readonly Method[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** 新建绑定 */
function CreateBindingForm({ nodes }: { nodes: PermissionNode[] }) {
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
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('method')}</label>
            <NativeSelect name="method" defaultValue="GET">
              {METHODS.map((method) => (
                <NativeSelectOption key={method} value={method}>
                  {method}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('path')}</label>
            <Input name="path" placeholder="/v1/example/:id" required maxLength={255} />
            <p className="text-xs text-muted-foreground">{t('pathHint')}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('permission')}</label>
            <NativeSelect name="permissionId" required>
              {coded.map((node) => (
                <NativeSelectOption key={node.id} value={String(node.id)}>
                  {node.name}（{node.code}）
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </form>
      )}
    </FormDialog>
  );
}

/** 换绑弹窗（受控:RowActions 菜单触发） */
function RebindDialog({
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
  const formId = `rebind-form-${binding.id}`;
  const coded = nodes.filter((node) => node.code != null && node.status === 0);
  return (
    <FormDialog
      formId={formId}
      open={open}
      onOpenChange={onOpenChange}
      title={t('rebindTitle', { method: binding.method, path: binding.path })}
      description={t('rebindDescription')}
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
              const res = await rebindAction(binding.id, Number(data.get('permissionId')));
              if (res.errorKey) {
                toast.error(t(`errors.${res.errorKey}`));
                return false;
              }
              return notify(res, t('actionFailed'), t('rebound'));
            });
          }}
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('permission')}</label>
            <NativeSelect name="permissionId" defaultValue={String(binding.permissionId)}>
              {coded.map((node) => (
                <NativeSelectOption key={node.id} value={String(node.id)}>
                  {node.name}（{node.code}）
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </form>
      )}
    </FormDialog>
  );
}

/** 接口绑定面板（DataTable:method/path/权限码/来源/操作） */
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
  const [rebinding, setRebinding] = useState<EndpointBindingRow | null>(null);
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
          {rebinding?.id === row.id && (
            <RebindDialog
              binding={row}
              nodes={nodes}
              open={rebinding != null}
              onOpenChange={(open) => !open && setRebinding(null)}
            />
          )}
          <RowActions label={tc('actions')}>
            <DropdownMenuItem onClick={() => setRebinding(row)}>{t('rebind')}</DropdownMenuItem>
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
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{t('title')}</h3>
          <p className="text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <CreateBindingForm nodes={nodes} />
      </div>
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
