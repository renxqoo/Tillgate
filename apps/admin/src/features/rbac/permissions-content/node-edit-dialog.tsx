'use client';

// 权限节点编辑弹窗：全字段（码/类型/父子移动;type 联动父选项与字段显隐,结构校验后端兜底）

import type { PermissionNode } from '@tillgate/api-client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { FormDialog } from '@/components/form-dialog';
import { type NodeType, parentOptionsOf } from './node-shared';
import { NodeEditFormBody } from './node-edit-form-body';

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
