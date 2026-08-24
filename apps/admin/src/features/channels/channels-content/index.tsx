'use client';

// 渠道管理：表格 + 行项（探测/编辑/删除/恢复）；弹窗在 channel-dialogs、批量导入在 import-channels-dialog

import {
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tillgate/ui';
import { defineStatusMeta } from '@/components/status-pill';
import { StatusPill } from '@/components/status-pill';
import { useState } from 'react';
import { Loader2Icon, PencilIcon, RotateCcwIcon, Trash2Icon, WifiIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { formatMoney, fmtDateTime } from '@/lib/formatters';
import type { AdminChannelRow, ProviderOption } from '@tillgate/api-client';
import { EditChannelDialog } from './edit-channel-dialog';

export { CreateChannelDialog } from './create-channel-dialog';
export { ImportChannelsDialog } from './import-channels-dialog';

// 状态 tone 映射留模块级；label 是 channels 命名空间的 i18n key，渲染处用 t 解析
const STATUS_META = defineStatusMeta(
  {
    0: { label: 'statusEnabled', tone: 'success' },
    1: { label: 'statusDegraded', tone: 'warning' },
    2: { label: 'statusDisabled', tone: 'neutral' },
    3: { label: 'statusCooldown', tone: 'warning' },
    // 4 = 凭据无效（worker 连续 401/403 标记；换 Key 保存时复位为 0）
    4: { label: 'statusDead', tone: 'danger' },
  },
  // fallback 也走目录键——默认字面量 Unknown 会以 channels.Unknown 原样漏到 UI
  { label: 'statusUnknown', tone: 'neutral' },
);

export function ChannelsTable({
  channels,
  providers,
}: {
  readonly channels: ReadonlyArray<AdminChannelRow>;
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead>{t('provider')}</TableHead>
          <TableHead>Base URL</TableHead>
          <TableHead>{t('models')}</TableHead>
          <TableHead className="text-right">{t('weightPriority')}</TableHead>
          <TableHead className="text-right">{t('budget')}</TableHead>
          <TableHead>{tc('status')}</TableHead>
          <TableHead className="text-right">{t('failCount')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              {t('noChannels')}
            </TableCell>
          </TableRow>
        ) : (
          channels.map((c) => <ChannelRowItem key={c.id} channel={c} providers={providers} />)
        )}
      </TableBody>
    </Table>
  );
}

function ChannelRowItem({
  channel,
  providers,
}: {
  channel: AdminChannelRow;
  providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const meta = STATUS_META.get(channel.status);
  // 回收站行（deletedAt 非空）：只读——仅「恢复记录」，其余动作不可达
  const deleted = channel.deletedAt != null;

  async function runTest() {
    setTesting(true);
    const { testChannelAction } = await import('@/server/channels-actions');
    const res = await testChannelAction(channel.id);
    setTesting(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(t('connected', { ms: res.durationMs ?? 0 }));
  }

  async function runDelete() {
    setDeleting(true);
    const { deleteChannelAction } = await import('@/server/channels-actions');
    const res = await deleteChannelAction(channel.id);
    setDeleting(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(tc('deleted'));
  }

  async function runUndelete() {
    setRestoring(true);
    const { undeleteChannelAction } = await import('@/server/channels-actions');
    const res = await undeleteChannelAction(channel.id);
    setRestoring(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(t('undeleteSuccess'));
  }

  return (
    <TableRow className={deleted ? 'opacity-60' : undefined}>
      <TableCell className="font-medium">{channel.name}</TableCell>
      <TableCell className="text-muted-foreground">{channel.providerName}</TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {channel.baseUrlOverride ?? channel.providerBaseUrl}
        </code>
      </TableCell>
      <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
        {channel.boundModels && channel.boundModels.length > 0
          ? channel.boundModels.map((m) => m.externalName).join(', ')
          : '—'}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {channel.weight} / {channel.priority}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="font-medium">{formatMoney(channel.upstreamBudget)}</span>
      </TableCell>
      <TableCell>
        {deleted ? (
          <div className="flex flex-col">
            <StatusPill tone="danger" label={t('deleted')} />
            <span className="mt-0.5 text-[10px] text-muted-foreground">
              {fmtDateTime(channel.deletedAt)}
            </span>
          </div>
        ) : (
          <StatusPill dot tone={meta.tone} label={t(meta.label)}>
            {channel.cooldownUntil ? (
              <span className="text-muted-foreground" title={channel.cooldownUntil}>
                {t('cooling')}
              </span>
            ) : null}
          </StatusPill>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
        {channel.failCount}
      </TableCell>
      <TableCell className="w-16 text-center">
        {/* 行操作走全站统一的 RowActions 菜单项范式（勿在菜单面板里放独立 Button 竖排） */}
        {deleted ? (
          <RowActions label={tc('actions')}>
            <DropdownMenuItem disabled={restoring} onClick={runUndelete}>
              {restoring ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <RotateCcwIcon className="size-4" />
              )}
              {t('undelete')}
            </DropdownMenuItem>
          </RowActions>
        ) : (
          <>
            <RowActions label={tc('actions')}>
              <DropdownMenuItem disabled={testing} onClick={runTest}>
                {testing ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <WifiIcon className="size-4" />
                )}
                {t('test')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <PencilIcon className="size-4" />
                {tc('edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
                {deleting ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <Trash2Icon className="size-4" />
                )}
                {tc('delete')}
              </DropdownMenuItem>
            </RowActions>
            <EditChannelDialog
              channel={channel}
              providers={providers}
              open={editOpen}
              onOpenChange={setEditOpen}
            />
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={tc('delete')}
              description={t('deleteConfirm', { name: channel.name })}
              confirmLabel={tc('delete')}
              cancelLabel={tUi('cancel')}
              tone="destructive"
              onConfirm={runDelete}
              onError={(e) => toast.error(e instanceof Error ? e.message : String(e))}
            />
          </>
        )}
      </TableCell>
    </TableRow>
  );
}
