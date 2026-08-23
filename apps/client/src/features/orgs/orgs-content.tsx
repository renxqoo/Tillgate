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
import { useLocale, useTranslations } from 'next-intl';

import {
  Avatar,
  AvatarFallback,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  StatusPill,
  toast,
} from '@tokenlens/ui';
import type { OrgInvitationSummary, OrgMemberRow, OrgRow } from '@tokenlens/api-client';

import { actionResult } from '@/features/shared/action-result';
import { formatMoney } from '@/features/shared/format';
import { ConfirmAction } from '@/features/shared/confirm-action';
import {
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  setMemberQuotaAction,
} from '@/server/actions/orgs';

export interface OrgWithMembers {
  org: OrgRow;
  members: OrgMemberRow[];
  invitations: OrgInvitationSummary[];
}

/** 金额展示去尾零（min 2 位保证下安全：整数金额形如 ¥100.00 → ¥100）。 */
function fmtYuan(value: string, locale: string): string {
  return formatMoney(value, locale).replace(/\.?0+$/, '');
}

/** 已用占比（0-100），仅用于进度条展示。 */
function usagePercent(used: string, quota: string): number {
  const u = Number(used);
  const q = Number(quota);
  if (!Number.isFinite(u) || !Number.isFinite(q) || q <= 0) return 0;
  return Math.min(100, Math.max(0, (u / q) * 100));
}

function parseNullableMoney(v: string, invalidMessage: string): string | null {
  const value = v.trim();
  if (value === '') return null;
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(invalidMessage);
  return value;
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
  const t = useTranslations('orgs');
  if (orgs.length === 0) {
    return (
      <Empty className="border-none">
        <EmptyHeader>
          <EmptyMedia>
            <Building2Icon className="size-8 text-muted-foreground/60" />
          </EmptyMedia>
          <EmptyTitle>{t('emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('emptyDesc')}</EmptyDescription>
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
  const t = useTranslations('orgs');
  const locale = useLocale();
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
              <StatusPill tone={isOwner ? 'info' : 'neutral'}>
                {isOwner ? t('roleOwner') : t('roleMember')}
              </StatusPill>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {hasSub ? (
                <>
                  {org.planName}
                  {org.quantity != null ? ` · ${t('seatsShort', { count: org.quantity })}` : ''}
                  {org.quantity != null
                    ? ` · ${t('membersWithQuota', { count: active.length, total: org.quantity })}`
                    : ` · ${t('membersLine', { count: active.length })}`}
                </>
              ) : (
                t('noPlan')
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
            {t('quotaUsed', {
              used: fmtYuan(org.usedAmount, locale),
              quota: fmtYuan(org.quotaAmount, locale),
            })}
            {org.remainingAmount != null
              ? ` · ${t('quotaRemaining', { amount: fmtYuan(org.remainingAmount, locale) })}`
              : ''}
          </p>
        </div>
      ) : null}

      {isOwner && !hasSub ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {t('noPlanHint')}
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
  const t = useTranslations('orgs');
  const tCommon = useTranslations('common');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (link) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <code className="max-w-72 truncate rounded bg-muted px-2 py-1">{link}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(`${window.location.origin}${link}`);
            toast.success(t('inviteLinkCopied'));
          }}
        >
          <CopyIcon className="size-3" /> {tCommon('copyLink')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setLink(null);
            setEmail('');
          }}
        >
          {t('inviteAnother')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t('memberEmailPlaceholder')}
        className="h-8 w-52 text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={pending || email.trim() === ''}
        title={seatsLeft != null && seatsLeft <= 0 ? t('seatsFull') : undefined}
        onClick={() =>
          startTransition(async () => {
            const res = await inviteMemberAction(org.orgId, email.trim());
            if (actionResult(res, t('inviteFailed'), t('inviteLinkGenerated')))
              setLink(res.link ?? '');
          })
        }
      >
        {pending ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon className="size-3.5" />}
        {t('inviteMember')}
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
  const t = useTranslations('orgs');
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('membersLabel', { count: members.length })}
      </p>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noMembers')}</p>
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
  const t = useTranslations('orgs');
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
        <StatusPill tone="info">{t('roleOwner')}</StatusPill>
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
  const t = useTranslations('orgs');
  const tCommon = useTranslations('common');
  const tUi = useTranslations('ui');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [daily, setDaily] = useState(member.dailySpendLimit ?? '');
  const [monthly, setMonthly] = useState(member.monthlyQuota ?? '');
  const [pending, startTransition] = useTransition();

  const fmtLimit = (value: string | null): string => {
    if (value === null || value === '') return tCommon('unlimited');
    return fmtYuan(value, locale);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" />
        }
      >
        {t('quotaSummary', {
          daily: fmtLimit(member.dailySpendLimit),
          monthly: fmtLimit(member.monthlyQuota),
        })}
        <PencilIcon className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('quotaTitle', { name: memberLabel(member) })}</p>
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t('dailyLimitLabel')}</span>
              <Input
                value={daily}
                onChange={(e) => setDaily(e.target.value)}
                inputMode="decimal"
                placeholder={tCommon('unlimited')}
                className="h-8 text-xs"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t('monthlyQuotaLabel')}</span>
              <Input
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
                inputMode="decimal"
                placeholder={tCommon('unlimited')}
                className="h-8 text-xs"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t('quotaNote')}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {tUi('cancel')}
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  let dailyLimit: string | null;
                  let monthlyQuota: string | null;
                  try {
                    dailyLimit = parseNullableMoney(daily, tUi('invalidAmount'));
                    monthlyQuota = parseNullableMoney(monthly, tUi('invalidAmount'));
                  } catch (e) {
                    toast.error((e as Error).message);
                    return;
                  }
                  const res = await setMemberQuotaAction(org.orgId, member.userId, {
                    dailySpendLimit: dailyLimit,
                    monthlyQuota,
                  });
                  if (actionResult(res, tCommon('saveFailed'), t('savedToast'))) setOpen(false);
                })
              }
            >
              {pending && <Loader2Icon className="animate-spin" />} {tCommon('save')}
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
  const t = useTranslations('orgs');
  const [pending, startTransition] = useTransition();

  /** 邀请到期剩余描述；3 天内到期给警示色。 */
  const expiresLabel = (iso: string): { text: string; soon: boolean } => {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return { text: t('expired'), soon: true };
    const days = Math.floor(ms / 86_400_000);
    if (days <= 3) {
      return {
        text: days <= 0 ? t('expiringSoon') : t('expiresInDays', { days }),
        soon: true,
      };
    }
    return { text: new Date(iso).toLocaleDateString('en-US'), soon: false };
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('pendingLabel', { count: invitations.length })}
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
                    const res = await revokeInvitationAction(org.orgId, inv.id);
                    actionResult(res, t('revokeFailed'), t('inviteRevoked'));
                  })
                }
              >
                <Trash2Icon className="size-4" /> {t('revoke')}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RemoveButton({ org, member }: { org: OrgRow; member: OrgMemberRow }) {
  const t = useTranslations('orgs');
  return (
    <ConfirmAction
      confirm={t('removeConfirm', { name: member.displayName || member.email || '' })}
      action={async () => removeMemberAction(org.orgId, member.userId)}
      errorTitle={t('removeFailed')}
      success={t('removedToast')}
    >
      {({ pending, onClick }) => (
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-destructive hover:text-destructive"
          disabled={pending}
          aria-label={t('removeMemberAria')}
          onClick={onClick}
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon className="size-4" />}
        </Button>
      )}
    </ConfirmAction>
  );
}
