'use client';

// 模型表格行项：计价展示单元格 + 状态徽章 + 行操作菜单与行级弹窗组（弹窗挂菜单外受控）

import { StatusPill } from '@/components/status-pill';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
  TableCell,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@tillgate/ui';
import { useState } from 'react';

import {
  ArrowDownIcon,
  FlaskConicalIcon,
  NetworkIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import type { AdminModelRow, ChannelOption } from '@tillgate/api-client';
import { ConfirmAction } from '@/components/confirm-action';
import { fmtPrice, fmtDateTime, unitWord } from '@/lib/formatters';
import { tierLabelFor, tierPricesOf } from './model-pricing';
import { BindChannelsDialog } from './bind-channels-dialog';
import { EditModelDialog } from './edit-model-dialog';
import { TestModelDialog } from './test-model-dialog';

/** 上下文窗口 token 数展示：65536 → 64K，1000000 → 1M，未知 → — */
function fmtContext(tokens: number | null): string {
  if (tokens == null || tokens <= 0) return '—';
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/**
 * 列表「输出价」列（单位计价）：有差价档位时显示最低价（起），
 * hover 悬浮展示全部档位价（预设档位名 + 参数值）与统一单价回落。
 */
function UnitPriceCell({ model, locale }: { model: AdminModelRow; locale: 'en' | 'zh' }) {
  const t = useTranslations('models');
  const unit = model.pricingUnit ?? 'request';
  const word = unitWord(unit, locale);
  const tiers = tierPricesOf(model);
  const flat = model.unitPrice ?? '';
  // 展示最低价：档位价与统一单价一起取最小（未命中档位的请求按统一单价计费）
  const candidates = [...tiers.map((x) => x.price), ...(flat !== '' ? [flat] : [])];
  const min = candidates.reduce<string | null>(
    (acc, p) => (acc === null || Number(p) < Number(acc) ? p : acc),
    null,
  );
  if (min === null) return <span>¥0/{word}</span>;
  if (candidates.length < 2) {
    return (
      <span>
        ¥{fmtPrice(min)}/{word}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-help underline decoration-dotted underline-offset-4">
            {t('listFromPrice', { min: fmtPrice(min), unit: word })}
          </span>
        }
      />
      <TooltipContent side="top" className="flex-col items-stretch gap-1 px-3 py-2 text-left">
        <p className="font-medium">{t('tiersTitle')}</p>
        {model.billingConfig?.params?.selector ? (
          <p className="opacity-70">
            {t('listSelectorLine', { selector: model.billingConfig.params.selector })}
          </p>
        ) : null}
        {tiers.map((tr) => {
          const label = tierLabelFor(unit, tr.value);
          return (
            <div key={tr.value} className="flex justify-between gap-6">
              <span>{label === tr.value ? tr.value : `${label} · ${tr.value}`}</span>
              <span>
                ¥{fmtPrice(tr.price)}/{word}
              </span>
            </div>
          );
        })}
        {flat !== '' ? (
          <div className="flex justify-between gap-6 border-t border-background/20 pt-1 opacity-70">
            <span>{t('tierFlatHint')}</span>
            <span>
              ¥{fmtPrice(flat)}/{word}
            </span>
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** 行级弹窗种类（受控 open：菜单点选写入，弹窗关闭置 null） */
type ModelDialogKind = 'bind' | 'edit' | 'test' | 'delist' | 'restore' | 'delete' | 'undelete';

/** 行动作弹窗组：从 ModelRowItem 提出的模块级组件（规模/复杂度收敛），行为不变 */
function ModelRowDialogs({
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

export function ModelRowItem({
  model,
  channels,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  const locale = useLocale() as 'en' | 'zh';
  const [dialog, setDialog] = useState<ModelDialogKind | null>(null);
  // 回收站行（deletedAt 非空）：只读——仅「恢复记录」，其余动作不可达
  const deleted = model.deletedAt != null;
  let status = <StatusPill tone="neutral" label={t('delisted')} />;
  if (deleted) {
    status = (
      <div className="flex flex-col">
        <StatusPill tone="danger" label={t('deleted')} />
        <span className="mt-0.5 text-[10px] text-muted-foreground">
          {fmtDateTime(model.deletedAt)}
        </span>
      </div>
    );
  } else if (model.status === 0) {
    status = <StatusPill tone="success" label={tc('enabled')} />;
  }
  return (
    <TableRow className={deleted ? 'opacity-60' : undefined}>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{model.externalName}</code>
        {model.isFree && <StatusPill className="ml-2" tone="info" label={tc('free')} />}
      </TableCell>
      <TableCell className="font-medium">{model.realModel}</TableCell>
      <TableCell className="text-right tabular-nums">
        {model.pricingUnit && model.pricingUnit !== 'token' ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>¥{fmtPrice(model.inputPrice)}/M</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {model.pricingUnit && model.pricingUnit !== 'token' ? (
          <UnitPriceCell model={model} locale={locale} />
        ) : (
          <span>¥{fmtPrice(model.outputPrice)}/M</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {model.pricingUnit && model.pricingUnit !== 'token' ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>¥{fmtPrice(model.cacheInputPrice)}/M</span>
        )}
      </TableCell>
      <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
        {model.fallbackModels ?? '—'}
      </TableCell>
      <TableCell>{status}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtContext(model.contextLength)}</TableCell>
      <TableCell className="w-16 text-center">
        <RowActions label={tc('actions')}>
          {deleted ? (
            <DropdownMenuItem onClick={() => setDialog('undelete')}>
              <RotateCcwIcon className="size-4" /> {t('undelete')}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onClick={() => setDialog('bind')}>
                <NetworkIcon /> {t('bindChannels')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDialog('edit')}>
                <PencilIcon /> {tc('edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDialog('test')}>
                <FlaskConicalIcon /> {t('test')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {model.status === 0 ? (
                <DropdownMenuItem onClick={() => setDialog('delist')}>
                  <ArrowDownIcon className="size-4" /> {t('delist')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setDialog('restore')}>
                  <RotateCcwIcon className="size-4" /> {t('restore')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => setDialog('delete')}>
                <Trash2Icon /> {t('delete')}
              </DropdownMenuItem>
            </>
          )}
        </RowActions>
        {/* 确认弹窗挂在菜单外(受控 open):菜单点选关闭时会卸载整个 content,放里面会连弹窗一起卸掉 */}
        <ModelRowDialogs
          model={model}
          channels={channels}
          dialog={dialog}
          onClose={() => setDialog(null)}
        />
      </TableCell>
    </TableRow>
  );
}
