'use client';

import type { PermissionNode, RoleRow } from '@tokenlens/api-client';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  FieldDescription,
  FieldLabel,
  FormItem,
  Input,
  RowActions,
} from '@tokenlens/ui';
import { useState } from 'react';
import { Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
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

/** 角色编辑/创建表单（码树勾选 = 授权全量替换;trigger 创建用,受控 open 行内编辑用） */
function RoleFormDialog({
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

/** 新建角色入口（页头 actions 插槽） */
export function RoleCreateForm({ nodes }: { nodes: PermissionNode[] }) {
  const t = useTranslations('roles');
  return (
    <RoleFormDialog
      nodes={nodes}
      trigger={
        <Button size="sm">
          <PlusIcon className="size-4" />
          {t('create')}
        </Button>
      }
    />
  );
}

/** 行操作（统一 RowActions 三点菜单）：编辑;删除仅非内置角色 */
function RoleRowActions({
  role,
  nodes,
  onDelete,
}: {
  role: RoleRowWithGrants;
  nodes: PermissionNode[];
  onDelete: (role: RoleRowWithGrants) => void;
}) {
  const tc = useTranslations('common');
  const [editOpen, setEditOpen] = useState(false);

  return (
    <>
      <RoleFormDialog role={role} nodes={nodes} open={editOpen} onOpenChange={setEditOpen} />
      <RowActions label={tc('actions')}>
        <DropdownMenuItem onClick={() => setEditOpen(true)}>
          <PencilIcon className="size-4" />
          {tc('edit')}
        </DropdownMenuItem>
        {!role.isBuiltin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(role)}>
              <Trash2Icon className="size-4" />
              {tc('delete')}
            </DropdownMenuItem>
          </>
        )}
      </RowActions>
    </>
  );
}

/** 角色清单（通用 DataTable;分页/搜索在页面层 ListPage） */
export function RolesContent({
  roles,
  tree,
}: {
  roles: RoleRowWithGrants[];
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
          <RoleRowActions role={r} nodes={tree} onDelete={setDeleting} />
        ),
    },
  ];

  return (
    <div className="space-y-3">
      <DataTable
        rowKey={(r) => r.id}
        rows={roles}
        columns={columns}
        empty={t('empty')}
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
