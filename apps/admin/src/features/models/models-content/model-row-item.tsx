'use client';

// 模型表格行项：计价展示单元格 + 状态徽章 + 行操作菜单与行级弹窗组（弹窗挂菜单外受控）

import { StatusPill } from '@/components/status-pill';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
  TableCell,
  TableRow,
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
import { fmtPrice, fmtDateTime } from '@/lib/formatters';
import { ModelRowDialogs } from './model-row-dialogs';
import type { ModelDialogKind } from './model-row-item-shared';
import { UnitPriceCell } from './unit-price-cell';

/** 上下文窗口 token 数展示：65536 → 64K，1000000 → 1M，未知 → — */
function fmtContext(tokens: number | null): string {
  if (tokens == null || tokens <= 0) return '—';
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
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
