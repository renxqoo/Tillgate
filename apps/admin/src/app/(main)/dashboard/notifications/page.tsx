import { BellIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminFetch } from '@ai-gateway/api-client';
import { fmtDateTime } from '@ai-gateway/api-client/formatters';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { StatusPill } from '@ai-gateway/ui/components/status-pill';

import { ChannelForm } from './_components/channel-form';
import { ChannelActions } from './_components/channel-actions';

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
  const t = await getTranslations('notifications');
  const tc = await getTranslations('common');
  const data = await adminFetch<{ rows?: ChannelRow[]; list?: ChannelRow[] }>('/v1/notifications').catch(() => null);

  const columns: DataTableColumn<ChannelRow>[] = [
    { key: 'name', header: tc('name') },
    { key: 'type', header: tc('type'), render: (r) => (r.type === 'webhook' ? 'Webhook' : t('email')) },
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
    { key: 'actions', header: tc('actions'), render: (r) => <ChannelActions id={r.id} status={r.status} /> },
  ];

  return (
    <ListPage
      title={t('title')}
      description={t('description')}
      icon={<BellIcon className="size-5 text-muted-foreground" />}
    >
      <ChannelForm />
      <DataTable rowKey={(r) => r.id} rows={(data?.rows ?? data?.list) ?? []} columns={columns} empty={t('noChannels')} />
    </ListPage>
  );
}
