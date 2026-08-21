import { BellIcon } from 'lucide-react';

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
  const data = await adminFetch<{ rows?: ChannelRow[]; list?: ChannelRow[] }>('/v1/notifications').catch(() => null);

  const columns: DataTableColumn<ChannelRow>[] = [
    { key: 'name', header: '名称' },
    { key: 'type', header: '类型', render: (r) => (r.type === 'webhook' ? 'Webhook' : '邮件') },
    {
      key: 'target',
      header: '投递目标',
      render: (r) =>
        r.type === 'webhook'
          ? String(r.config?.url ?? '')
          : ((r.config?.recipients as string[]) ?? []).join(', '),
    },
    {
      key: 'events',
      header: '订阅事件',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.events.join(', ')}</span>
      ),
    },
    { key: 'createdAt', header: '创建时间', render: (r) => fmtDateTime(r.createdAt) },
    {
      key: 'status',
      header: '状态',
      render: (r) => (
        <StatusPill tone={r.status === 0 ? 'success' : 'neutral'}>
          {r.status === 0 ? '启用' : '停用'}
        </StatusPill>
      ),
    },
    { key: 'actions', header: '操作', render: (r) => <ChannelActions id={r.id} status={r.status} /> },
  ];

  return (
    <ListPage
      title="告警通知"
      description="渠道禁用 / 计费死单等事件推送到 webhook（HMAC 签名）或邮箱"
      icon={<BellIcon className="size-5 text-muted-foreground" />}
    >
      <ChannelForm />
      <DataTable rowKey={(r) => r.id} rows={(data?.rows ?? data?.list) ?? []} columns={columns} empty="暂无通知渠道" />
    </ListPage>
  );
}
