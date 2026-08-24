import { Building2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError, type OrgDetail, type OrgRow, type RowsTotalPage } from '@tillgate/api-client';

import { OrgsContent, type OrgWithMembers } from '@/features/orgs/orgs-content';
import { ListPage } from '@/features/shared/list-page';
import { parseListSearchParams } from '@/server/list-query';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OrgsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('orgs');
  const { page } = parseListSearchParams(sp);
  const api = createClientApi();
  await requireMe(api);

  let rows: OrgRow[] = [];
  let total = 0;
  let loadError: string | null = null;
  try {
    // orgs 列表契约不分页收参（页大小由后端定）——信封 {rows,total}
    const result = await api.get<RowsTotalPage<OrgRow>>('/v1/orgs');
    // catch 形参按 catch-error-name 规则命名为 error，外层改名为 loadError（原写法 error 恒为 null，失败提示不上屏）
    ({ rows, total } = result);
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : null;
  }
  // 逐组织详情（成员+待接受邀请）并发拉取——契约无批量端点（B3/G2 保留并发）
  const orgs: OrgWithMembers[] = await Promise.all(
    rows.map(async (org) => {
      let members: OrgWithMembers['members'] = [];
      let invitations: OrgWithMembers['invitations'] = [];
      try {
        const detail = await api.get<OrgDetail>(`/v1/orgs/${org.orgId}`);
        members = detail.members ?? [];
        invitations = detail.invitations ?? [];
      } catch {
        members = [];
        invitations = [];
      }
      return { org, members, invitations };
    }),
  );

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title={t('title')}
        icon={<Building2 className="size-5 text-muted-foreground" />}
        description={t('description')}
        total={total}
        totalUnit={t('totalUnit')}
        searchParams={{ page: page > 1 ? String(page) : undefined }}
        error={loadError}
      >
        <OrgsContent orgs={orgs} />
      </ListPage>
    </div>
  );
}
