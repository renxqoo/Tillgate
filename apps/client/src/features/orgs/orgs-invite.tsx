'use client';

// 邀请生命周期：发起（邮箱 → 邀请链接复制）+ 待处理邀请的到期展示与撤销

import { useState, useTransition } from 'react';
import { CopyIcon, Loader2Icon, UserPlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Input, toast } from '@tillgate/ui';
import type { OrgRow } from '@tillgate/api-client';
import { actionResult } from '@/features/shared/action-result';
import { inviteMemberAction } from '@/server/actions/orgs';

export { PendingInvitations } from './pending-invitations';

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
