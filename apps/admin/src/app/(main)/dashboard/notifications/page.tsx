import { requirePermission } from '@/server/get-admin';
import type { DataTableColumn } from '@/components/data-table';

import { DataTable } from '@/components/data-table';
import { StatusPill } from '@/components/status-pill';
import { BellIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminApi } from '@/server/admin-api';
import { fmtDateTime } from '@/lib/formatters';
import { ListPage } from '@/components/list-page';

import { ChannelForm } from '@/features/notifications/channel-form';
import { ChannelActions } from '@/features/notifications/channel-actions';

export const dynamic = 'force-dynamic';

interface ChannelRow {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  events: string[];
  status: number;
  createdAt: string;
}

export default async function NotificationsPage() {
  await requirePermission('growth:read');
  const t = await getTranslations('notifications');
  const tc = await getTranslations('common');
  // GET /v1/notifications 返回裸数组（openapi 锁定），不是 {rows}/{list} 信封——
  // 曾按信封误读导致创建成功但列表恒空（R-9）
  const data = await adminApi()
    .get<ChannelRow[]>('/v1/notifications')
    .catch(() => null);

  const columns: DataTableColumn<ChannelRow>[] = [
    { key: 'name', header: tc('name') },
    {
      key: 'type',
      header: tc('type'),
      render: (r) => (r.type === 'webhook' ? 'Webhook' : t('email')),
    },
    {
      key: 'target',
      header: t('target'),
      render: (r) =>
        r.type === 'webhook'
          ? String(r.config?.url ?? '')
          : ((r.config?.recipients as string[]) ?? []).join(', '),
    },
    {
      key: 'events',
      header: t('events'),
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.events.join(', ')}</span>
      ),
    },
    { key: 'createdAt', header: tc('createdAt'), render: (r) => fmtDateTime(r.createdAt) },
    {
      key: 'status',
      header: tc('status'),
      render: (r) => (
        <StatusPill tone={r.status === 0 ? 'success' : 'neutral'}>
          {r.status === 0 ? tc('enabled') : t('disable')}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: tc('actions'),
      render: (r) => <ChannelActions id={r.id} status={r.status} />,
    },
  ];

  return (
    <ListPage
      title={t('title')}
      description={t('description')}
      icon={<BellIcon className="size-5 text-muted-foreground" />}
    >
      <ChannelForm />
      <DataTable rowKey={(r) => r.id} rows={data ?? []} columns={columns} empty={t('noChannels')} />
    </ListPage>
  );
}
