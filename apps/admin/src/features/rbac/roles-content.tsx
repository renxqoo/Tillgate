'use client';

import type { PermissionNode, RoleRow } from '@tokenlens/api-client';
import { Badge, Button, Checkbox } from '@tokenlens/ui';
import { useState } from 'react';
import { Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
import type { DataTableColumn } from '@/components/data-table';
import { FormDialog } from '@/components/form-dialog';
import { ConfirmDialog } from '@tokenlens/ui';
import { useActionResult } from '@/components/action-toast';
import { Input } from '@tokenlens/ui';
import { createRoleAction, deleteRoleAction, updateRoleAction } from '@/server/rbac-actions';

interface RoleRowWithGrants extends RoleRow {
  adminCount: number;
  codes: string[];
}

/** 授权树勾选（page+button;勾按钮自动勾页面 read——纯 UI 便利非后端不变量） */
function GrantTree({
  nodes,
  selected,
  onToggle,
}: {
  nodes: PermissionNode[];
  selected: Set<string>;
  onToggle: (code: string, next: boolean) => void;
}) {
  const t = useTranslations('permissions');
  const groups = nodes
    .filter((n) => n.type === 'group')
    .toSorted((a, b) => a.sortOrder - b.sortOrder);
  const pages = nodes.filter((n) => n.type === 'page');
  const buttons = nodes.filter((n) => n.type === 'button');

  return (
    <div className="max-h-80 space-y-3 overflow-y-auto rounded-md border p-3">
      {groups.map((group) => {
        const groupPages = pages
          .filter((page) => page.parentId === group.id)
          .toSorted((a, b) => a.sortOrder - b.sortOrder);
        if (groupPages.length === 0) return null;
        return (
          <div key={group.id} className="space-y-1.5">
            <div className="text-xs font-semibold text-muted-foreground">{group.name}</div>
            {groupPages.map((page) => {
              const pageButtons = buttons
                .filter((button) => button.parentId === page.id)
                .toSorted((a, b) => a.sortOrder - b.sortOrder);
              return (
                <div key={page.id} className="space-y-1 rounded-md bg-muted/40 px-2.5 py-2">
                  {page.code != null ? (
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <Checkbox
                        checked={selected.has(page.code)}
                        onCheckedChange={(checked) => onToggle(page.code!, checked === true)}
                      />
                      {page.name}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {page.code}
                      </span>
                    </label>
                  ) : (
                    <div className="text-sm font-medium">{page.name}</div>
                  )}
                  {pageButtons.length > 0 && (
                    <div className="ml-6 flex flex-col gap-1">
                      {pageButtons.map((button) => (
                        <label key={button.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={selected.has(button.code ?? '')}
                            onCheckedChange={(checked) =>
                              onToggle(button.code ?? '', checked === true)
                            }
                          />
                          {button.name}
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {button.code}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {groups.length === 0 && <div className="text-sm text-muted-foreground">{t('empty')}</div>}
    </div>
  );
}

/** 角色编辑/创建表单（码树勾选 = 授权全量替换） */
function RoleForm({
  role,
  nodes,
  trigger,
}: {
  role?: RoleRowWithGrants;
  nodes: PermissionNode[];
  trigger: React.ReactElement;
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

  const formId = role ? `role-form-${role.id}` : 'role-form-create';

  return (
    <FormDialog
      formId={formId}
      trigger={trigger}
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
                ? await updateRoleAction(role.id, { name, permissions: [...selected] })
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
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="role-code">
                {t('code')}
              </label>
              <Input id="role-code" name="code" required maxLength={64} />
              <p className="text-xs text-muted-foreground">{t('codeHint')}</p>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={`role-name-${role?.id ?? 'new'}`}>
              {tc('name')}
            </label>
            <Input
              id={`role-name-${role?.id ?? 'new'}`}
              name="name"
              defaultValue={role?.name}
              required
              maxLength={128}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t('grants')}</span>
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
          </div>
          {pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
        </form>
      )}
    </FormDialog>
  );
}

export function RolesContent({
  roles,
  total,
  tree,
}: {
  roles: RoleRowWithGrants[];
  total: number;
  tree: PermissionNode[];
}) {
  const t = useTranslations('roles');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [deleting, setDeleting] = useState<RoleRowWithGrants | null>(null);

  const columns: DataTableColumn<RoleRowWithGrants>[] = [
    {
      key: 'code',
      header: t('code'),
      render: (r) => <span className="font-mono text-sm">{r.code}</span>,
    },
    {
      key: 'name',
      header: tc('name'),
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: 'flags',
      header: t('flags'),
      render: (r) => (
        <div className="flex gap-1">
          {r.isSuper ? <Badge>{t('superFlag')}</Badge> : null}
          {r.isBuiltin ? <Badge variant="secondary">{t('builtinFlag')}</Badge> : null}
          {r.status === 1 ? <Badge variant="destructive">{tc('disabled')}</Badge> : null}
        </div>
      ),
    },
    { key: 'adminCount', header: t('adminCount'), render: (r) => r.adminCount },
    {
      key: 'codes',
      header: t('grants'),
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {r.isSuper ? t('implicitAll') : `${r.codes.length}`}
        </span>
      ),
    },
    {
      key: 'actions',
      header: tc('actions'),
      render: (r) =>
        r.isSuper ? (
          <span className="text-xs text-muted-foreground">{t('superLocked')}</span>
        ) : (
          <div className="flex items-center gap-1">
            <RoleForm
              role={r}
              nodes={tree}
              trigger={
                <button
                  type="button"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                  title={tc('edit')}
                >
                  <PencilIcon className="size-4" />
                </button>
              }
            />
            {!r.isBuiltin && (
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                title={tc('delete')}
                onClick={() => setDeleting(r)}
              >
                <Trash2Icon className="size-4" />
              </button>
            )}
          </div>
        ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <RoleForm
          nodes={tree}
          trigger={
            <Button size="sm">
              <PlusIcon className="size-4" />
              {t('create')}
            </Button>
          }
        />
      </div>
      <DataTable
        rowKey={(r) => r.id}
        rows={roles}
        columns={columns}
        empty={t('empty', { count: total })}
      />
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
          const res = await deleteRoleAction(deleting.id);
          if (res.errorKey) toast.error(t(`errors.${res.errorKey}`));
          else notify(res, t('actionFailed'), t('deleted'));
          setDeleting(null);
        }}
      />
    </div>
  );
}
