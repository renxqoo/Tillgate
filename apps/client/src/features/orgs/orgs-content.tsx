'use client';

// 组织管理外壳：空态 + 组织区块列表（区块/成员/配额/邀请见同目录分域文件）

import { Building2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tillgate/ui';
import { OrgSection } from './orgs-section';
import { type OrgWithMembers } from './orgs-shared';

export type { OrgWithMembers } from './orgs-shared';

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
