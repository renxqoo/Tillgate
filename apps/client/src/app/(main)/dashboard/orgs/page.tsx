import { Building2 } from "lucide-react";

import { apiFetch, type OrgDetail, type OrgRow } from "@ai-gateway/api-client";
import { fetchUserList } from "@ai-gateway/api-client/list";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import { OrgsContent, type OrgWithMembers } from "./_components/orgs-content";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OrgsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchUserList<OrgRow>("/v1/orgs", {
    page,
    pageSize: PAGE_SIZE,
    extra: { q },
  });
  const orgs: OrgWithMembers[] = await Promise.all(
    rows.map(async (org) => {
        let members: OrgWithMembers["members"] = [];
        let invitations: OrgWithMembers["invitations"] = [];
        try {
          const detail = await apiFetch<OrgDetail>(`/v1/orgs/${org.orgId}`);
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
        title="组织"
        icon={<Building2 className="size-5 text-muted-foreground" />}
        description="加入/管理的组织。企业套餐以组织为单位：owner 邀请成员，成员各自建自己的 Key 走组织额度。"
        total={total}
        totalUnit="个组织"
        searchPlaceholder="搜索组织名"
        q={q}
        searchParams={{ q }}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <OrgsContent orgs={orgs} />
      </ListPage>
    </div>
  );
}
