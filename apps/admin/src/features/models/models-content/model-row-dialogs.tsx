'use client';

import { useTranslations } from 'next-intl';

import type { AdminModelRow, ChannelOption } from '@tillgate/api-client';
import { ConfirmAction } from '@/components/confirm-action';
import { BindChannelsDialog } from './bind-channels-dialog';
import { EditModelDialog } from './edit-model-dialog';
import { TestModelDialog } from './test-model-dialog';
import type { ModelDialogKind } from './model-row-item-shared';

/** 行动作弹窗组：从 ModelRowItem 提出的模块级组件（规模/复杂度收敛），行为不变 */
export function ModelRowDialogs({
  model,
  channels,
  dialog,
  onClose,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
  dialog: ModelDialogKind | null;
  onClose: () => void;
}) {
  const t = useTranslations('models');
  const deleted = model.deletedAt != null;
  return (
    <>
      {deleted ? (
        <ConfirmAction
          open={dialog === 'undelete'}
          onOpenChange={(open) => !open && onClose()}
          confirm={t('undeleteConfirm', { name: model.externalName })}
          action={async () =>
            (await import('@/server/models-actions')).undeleteModelAction(model.id)
          }
          success={t('undeleteSuccess')}
          tone="default"
        />
      ) : (
        <>
          {model.status === 0 ? (
            <ConfirmAction
              open={dialog === 'delist'}
              onOpenChange={(open) => !open && onClose()}
              confirm={t('delistConfirm', { name: model.externalName })}
              action={async () =>
                (await import('@/server/models-actions')).delistModelAction(model.id)
              }
              success={t('delistSuccess')}
              tone="default"
            />
          ) : (
            <ConfirmAction
              open={dialog === 'restore'}
              onOpenChange={(open) => !open && onClose()}
              confirm={t('restoreConfirm', { name: model.externalName })}
              action={async () =>
                (await import('@/server/models-actions')).restoreModelAction(model.id)
              }
              success={t('restoreSuccess')}
              tone="default"
            />
          )}
          <ConfirmAction
            open={dialog === 'delete'}
            onOpenChange={(open) => !open && onClose()}
            confirm={t('deleteConfirm', { name: model.externalName })}
            action={async () =>
              (await import('@/server/models-actions')).deleteModelAction(model.id)
            }
            success={t('deleteSuccess')}
          />
          <BindChannelsDialog
            model={model}
            channels={channels}
            trigger={null}
            open={dialog === 'bind'}
            onOpenChange={(open) => !open && onClose()}
          />
          <EditModelDialog
            model={model}
            trigger={null}
            open={dialog === 'edit'}
            onOpenChange={(open) => !open && onClose()}
          />
          <TestModelDialog
            model={model}
            trigger={null}
            open={dialog === 'test'}
            onOpenChange={(open) => !open && onClose()}
          />
        </>
      )}
    </>
  );
}
