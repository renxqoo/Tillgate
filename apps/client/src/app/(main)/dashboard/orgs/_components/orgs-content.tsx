'use client';

import { useState, useTransition } from 'react';

import {
  Building2Icon,
  CopyIcon,
  Loader2Icon,
  MailIcon,
  PencilIcon,
  Trash2Icon,
  UserPlusIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@ai-gateway/ui/components/ui/button';
import { Input } from '@ai-gateway/ui/components/ui/input';
import { Progress } from '@ai-gateway/ui/components/ui/progress';
import { Popover, PopoverContent, PopoverTrigger } from '@ai-gateway/ui/components/ui/popover';
import { Avatar, AvatarFallback } from '@ai-gateway/ui/components/ui/avatar';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@ai-gateway/ui/components/ui/empty';
import { formatMoney, formatPoints } from '@ai-gateway/api-client/formatters';

import type { OrgInvitationSummary, OrgMemberRow, OrgRow } from '@ai-gateway/api-client/types';
import { useActionResult } from '@ai-gateway/ui/components/action-toast';
import { ConfirmAction } from '@ai-gateway/ui/components/confirm-action';
import { StatusPill } from '@ai-gateway/ui/components/status-pill';

export interface OrgWithMembers {
  org: OrgRow;
  members: OrgMemberRow[];
  invitations: OrgInvitationSummary[];
}

/** 元展示去尾零：50.0000 → 50（成员日限/月配额按元展示，与 API Key 页口径一致）。 */
function fmtYuan(value: string | null): string {
  if (value === null || value === '') return '不限';
  return `¥${formatMoney(value).replace(/\.?0+$/, '')}`;
}

/** 积分展示去尾零（组织订阅额度按积分展示，与套餐订阅页口径一致）。 */
function fmtQuota(value: string): string {
  return formatPoints(value).replace(/\.?0+$/, '');
}

/** 已用占比（0-100），仅用于进度条展示。 */
function usagePercent(used: string, quota: string): number {
  const u = Number(used);
  const q = Number(quota);
  if (!Number.isFinite(u) || !Number.isFinite(q) || q <= 0) return 0;
  return Math.min(100, Math.max(0, (u / q) * 100));
}

function parseNullableMoney(v: string): string | null {
  const value = v.trim();
  if (value === '') return null;
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('金额格式不正确');
  return value;
}

/** 邀请到期剩余描述；3 天内到期给警示色。 */
function expiresLabel(iso: string): { text: string; soon: boolean } {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: '已过期', soon: true };
  const days = Math.floor(ms / 86_400_000);
  if (days <= 3) return { text: days <= 0 ? '即将到期' : `${days} 天后到期`, soon: true };
  return { text: new Date(iso).toLocaleDateString(), soon: false };
}

function memberLabel(m: OrgMemberRow): string {
  return m.displayName || m.email || `#${m.userId}`;
}

function initials(m: OrgMemberRow): string {
  const label = memberLabel(m);
  const ch = label.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

export function OrgsContent({ orgs }: { readonly orgs: ReadonlyArray<OrgWithMembers> }) {
  if (orgs.length === 0) {
    return (
      <Empty className="border-none">
        <EmptyHeader>
          <EmptyMedia>
            <Building2Icon className="size-8 text-muted-foreground/60" />
          </EmptyMedia>
          <EmptyTitle>尚未加入任何组织</EmptyTitle>
          <EmptyDescription>
            企业购买团队套餐后会自动创建组织，或收到 owner 邀请后加入。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="divide-y">
      {orgs.map(({ org, members, invitations }) => (
        <OrgSection key={org.orgId} org={org} members={members} invitations={invitations} />
      ))}
    </div>
  );
}

function OrgSection({ org, members, invitations }: OrgWithMembers) {
  const isOwner = org.role === 'owner';
  const active = members.filter((m) => m.status === 0);
  const hasSub = org.subscriptionId != null;

  return (
    <section className="space-y-4 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Building2Icon className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold">{org.name}</h3>
              <StatusPill
                tone={isOwner ? 'accent' : 'neutral'}
                label={isOwner ? '所有者' : '成员'}
              />
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {hasSub ? (
                <>
                  {org.planName}
                  {org.quantity != null ? ` · ${org.quantity} 席` : ''}
                  {` · 成员 ${active.length}${org.quantity != null ? `/${org.quantity}` : ''}`}
                </>
              ) : (
                '无有效套餐'
              )}
            </p>
          </div>
        </div>
        {isOwner ? (
          <InviteButton
            org={org}
            seatsLeft={org.quantity != null ? org.quantity - active.length : null}
          />
        ) : null}
      </div>

      {hasSub && org.quotaAmount != null && org.usedAmount != null ? (
        <div>
          <Progress value={usagePercent(org.usedAmount, org.quotaAmount)} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            已用 {fmtQuota(org.usedAmount)} / {fmtQuota(org.quotaAmount)} 积分
            {org.remainingAmount != null ? ` · 剩余 ${fmtQuota(org.remainingAmount)}` : ''}
          </p>
        </div>
      ) : null}

      {isOwner && !hasSub ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          组织暂无有效套餐：邀请成员前需先以组织名义购买团队套餐（席位 = 成员名额）。
        </p>
      ) : null}

      <MemberList org={org} members={active} isOwner={isOwner} />

      {isOwner && invitations.length > 0 ? (
        <PendingInvitations org={org} invitations={invitations} />
      ) : null}
    </section>
  );
}

function InviteButton({ org, seatsLeft }: { org: OrgRow; seatsLeft: number | null }) {
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();

  if (link) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <code className="max-w-72 truncate rounded bg-muted px-2 py-1">{link}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(`${window.location.origin}${link}`);
            toast.success('邀请链接已复制');
          }}
        >
          <CopyIcon className="size-3" /> 复制链接
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setLink(null);
            setEmail('');
          }}
        >
          再邀请一位
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="成员登录邮箱"
        className="h-8 w-52 text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={pending || email.trim() === ''}
        title={seatsLeft != null && seatsLeft <= 0 ? '席位已满' : undefined}
        onClick={() =>
          startTransition(async () => {
            const { inviteMemberAction } = await import('../actions');
            const res = await inviteMemberAction(org.orgId, email.trim());
            if (notify(res, '邀请失败', '已生成邀请链接')) setLink(res.link ?? '');
          })
        }
      >
        {pending ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon className="size-3.5" />}
        邀请成员
      </Button>
    </div>
  );
}

function MemberList({
  org,
  members,
  isOwner,
}: {
  org: OrgRow;
  members: OrgMemberRow[];
  isOwner: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">成员（{members.length}）</p>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无成员</p>
      ) : (
        <ul className="space-y-1.5">
          {members.map((m) => (
            <MemberRow key={m.userId} org={org} member={m} isOwner={isOwner} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MemberRow({
  org,
  member,
  isOwner,
}: {
  org: OrgRow;
  member: OrgMemberRow;
  isOwner: boolean;
}) {
  const isOrgOwner = member.role === 'owner';
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
      <Avatar className="size-7">
        <AvatarFallback className="text-xs">{initials(member)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{memberLabel(member)}</div>
        {member.email && member.email !== memberLabel(member) ? (
          <div className="truncate text-xs text-muted-foreground">{member.email}</div>
        ) : null}
      </div>
      {isOrgOwner ? (
        <StatusPill tone="accent" label="所有者" />
      ) : isOwner ? (
        <>
          <QuotaCell org={org} member={member} />
          <RemoveButton org={org} member={member} />
        </>
      ) : null}
    </li>
  );
}

function QuotaCell({ org, member }: { org: OrgRow; member: OrgMemberRow }) {
  const [open, setOpen] = useState(false);
  const notify = useActionResult();
  const [daily, setDaily] = useState(member.dailySpendLimit ?? '');
  const [monthly, setMonthly] = useState(member.monthlyQuota ?? '');
  const [pending, startTransition] = useTransition();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          日限 {fmtYuan(member.dailySpendLimit)} · 月配额 {fmtYuan(member.monthlyQuota)}
          <PencilIcon className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-3">
          <p className="text-sm font-medium">用量限额 · {memberLabel(member)}</p>
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">日限额（元，留空不限）</span>
              <Input
                value={daily}
                onChange={(e) => setDaily(e.target.value)}
                inputMode="decimal"
                placeholder="不限"
                className="h-8 text-xs"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">月配额（元，留空不限）</span>
              <Input
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
                inputMode="decimal"
                placeholder="不限"
                className="h-8 text-xs"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            成员各自建自己的 Key，额度按组织套餐扣减。
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const { setMemberQuotaAction } = await import('../actions');
                  const res = await setMemberQuotaAction(org.orgId, member.userId, {
                    dailySpendLimit: parseNullableMoney(daily),
                    monthlyQuota: parseNullableMoney(monthly),
                  });
                  if (notify(res, '保存失败', '已保存')) setOpen(false);
                })
              }
            >
              {pending && <Loader2Icon className="animate-spin" />} 保存
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PendingInvitations({
  org,
  invitations,
}: {
  org: OrgRow;
  invitations: OrgInvitationSummary[];
}) {
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        待接受邀请（{invitations.length}）
      </p>
      <ul className="space-y-1.5">
        {invitations.map((inv) => {
          const exp = expiresLabel(inv.expiresAt);
          return (
            <li
              key={inv.id}
              className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm"
            >
              <MailIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{inv.email}</span>
              <span
                className={
                  exp.soon
                    ? 'text-xs text-amber-600 dark:text-amber-400'
                    : 'text-xs text-muted-foreground'
                }
              >
                {exp.text}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const { revokeInvitationAction } = await import('../actions');
                    const res = await revokeInvitationAction(org.orgId, inv.id);
                    notify(res, '撤销失败', '已撤销邀请');
                  })
                }
              >
                <Trash2Icon className="size-4" /> 撤销
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RemoveButton({ org, member }: { org: OrgRow; member: OrgMemberRow }) {
  return (
    <ConfirmAction
      confirm={`确定移除成员 ${member.displayName || member.email}？其历史用量保留。`}
      action={async () => (await import('../actions')).removeMemberAction(org.orgId, member.userId)}
      errorTitle="移除失败"
      success="已移除"
    >
      {({ pending, onClick }) => (
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-destructive hover:text-destructive"
          disabled={pending}
          aria-label="移除成员"
          onClick={onClick}
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon className="size-4" />}
        </Button>
      )}
    </ConfirmAction>
  );
}
