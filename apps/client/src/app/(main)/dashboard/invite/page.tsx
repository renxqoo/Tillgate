import { CoinsIcon, PercentIcon, UsersIcon } from 'lucide-react';

import { apiFetch } from '@ai-gateway/api-client';
import { formatMoney } from '@ai-gateway/api-client/formatters';
import { CopyButton } from '@ai-gateway/ui/components/shell/copy-button';
import { KpiCard } from '@ai-gateway/ui/components/kpi-card';
import { ListPage } from '@ai-gateway/ui/components/list-page';

export const dynamic = 'force-dynamic';

interface InviteData {
  affCode: string;
  inviteUrl: string;
  signupBonus: string;
  commissionRate: string;
  invited: Array<{ inviteeId: number; inviteeName: string | null; createdAt: string; status: number }>;
  totalCommission: string;
}

export default async function InvitePage() {
  // v2：GET /v1/referrals —— 邀请码/链接、已邀名单、累计佣金（后端不可达时空态展示）
  const [data, config] = await Promise.all([
    apiFetch<InviteData>('/v1/referrals').catch(() => null),
    apiFetch<{ enabled: boolean }>('/v1/referrals/config').catch(() => null),
  ]);
  // 营销参数全 0 = 功能关闭：直达 URL 也给空态（入口已由 sidebar 隐藏）
  if (config && !config.enabled) {
    return (
      <ListPage
        title="邀请返利"
        description="邀请好友注册，双方得奖励；好友每日消费按比例返佣"
        icon={<UsersIcon className="size-5 text-muted-foreground" />}
        unbordered
      >
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">邀请功能暂未开放</div>
      </ListPage>
    );
  }

  return (
    <ListPage
      title="邀请返利"
      description="邀请好友注册，双方得奖励；好友每日消费按比例返佣"
      icon={<UsersIcon className="size-5 text-muted-foreground" />}
      unbordered
    >
      {data ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard icon={<CoinsIcon className="size-4" />} title="累计佣金（元）" value={formatMoney(data.totalCommission)} />
            <KpiCard icon={<UsersIcon className="size-4" />} title="已邀请人数" value={String(data.invited.length)} />
            <KpiCard
              icon={<PercentIcon className="size-4" />}
              title="佣金比例"
              value={`${(Number(data.commissionRate) * 100).toFixed(1)}%`}
              sub="按被邀请人每日实际消费日结"
            />
          </div>
          <div className="rounded-lg border p-4">
            <p className="mb-2 text-sm font-medium">我的邀请链接（复制发给好友）</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-3 py-2 text-xs">{data.inviteUrl}</code>
              <CopyButton text={data.inviteUrl} />
            </div>
            {Number(data.signupBonus) > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                好友通过链接注册，双方各得 ¥{data.signupBonus} 奖励
              </p>
            ) : null}
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">好友</th>
                  <th className="px-4 py-2 font-medium">注册时间</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {data.invited.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                      还没有邀请记录，分享链接开始赚取佣金
                    </td>
                  </tr>
                ) : (
                  data.invited.map((r) => (
                    <tr key={r.inviteeId} className="border-t">
                      <td className="px-4 py-2">{r.inviteeName ?? `用户 #${r.inviteeId}`}</td>
                      <td className="px-4 py-2">{new Date(r.createdAt).toLocaleDateString('zh-CN')}</td>
                      <td className="px-4 py-2">
                        {r.status === 0 ? '正常' : '已停止返佣'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">邀请服务暂不可用</p>
      )}
    </ListPage>
  );
}
