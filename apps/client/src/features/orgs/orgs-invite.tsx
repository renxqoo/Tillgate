'use client';

// 邀请生命周期：发起（邮箱 → 邀请链接复制）+ 待处理邀请的到期展示与撤销

import { useState, useTransition } from 'react';
import { CopyIcon, Loader2Icon, MailIcon, Trash2Icon, UserPlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Input, toast } from '@tillgate/ui';
import type { OrgInvitationSummary, OrgRow } from '@tillgate/api-client';
import { actionResult } from '@/features/shared/action-result';
import { inviteMemberAction, revokeInvitationAction } from '@/server/actions/orgs';

export function InviteButton({ org, seatsLeft }: { org: OrgRow; seatsLeft: number | null }) {
  const t = useTranslations('orgs');
  const tCommon = useTranslations('common');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const copyInviteLink = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}${link}`);
    toast.success(t('inviteLinkCopied'));
  };

  if (link) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <code className="max-w-72 truncate rounded bg-muted px-2 py-1">{link}</code>
        <Button size="sm" variant="outline" onClick={copyInviteLink}>
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
            if (actionResult(res, t('inviteFailed'), t('inviteLinkGenerated'))) {
              setLink(res.link ?? '');
            }
          })
        }
      >
        {pending ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon className="size-3.5" />}
        {t('inviteMember')}
      </Button>
    </div>
  );
}

export function PendingInvitations({
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
    // eslint-disable-next-line react/purity -- 展示用相对到期时间：渲染期取当前时刻即期望语义（每次渲染重算倒计时），非精确数据派生
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
