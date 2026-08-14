import { Building2 } from "lucide-react";

import {
  ApiError,
  apiFetch,
  type OrgDetail,
  type OrgRow as ApiOrgRow,
} from "@ai-gateway/api-client";

import { OrgsContent, type OrgWithMembers } from "./_components/orgs-content";
import type { OrgRow } from "./types";

export const dynamic = "force-dynamic";

export default async function OrgsPage() {
  let orgs: OrgWithMembers[] = [];
  let error: string | null = null;

  try {
    const data = await apiFetch<{ list: ApiOrgRow[] }>("/api/orgs");
    orgs = await Promise.all(
      (data.list ?? []).map(async (o) => {
        const org: OrgRow = {
          id: o.id,
          name: o.name,
          role: o.role,
          subscriptionId: o.subscriptionId,
          subscriptionName: o.subscriptionName,
        };
        let members: OrgWithMembers["members"] = [];
        try {
          const detail = await apiFetch<OrgDetail>(`/api/orgs/${o.id}`);
          members = detail.members ?? [];
        } catch {
          members = [];
        }
        return { org, members };
      }),
    );
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Building2 className="size-5 text-muted-foreground" />
          组织
        </h1>
        <p className="text-sm text-muted-foreground">
          加入/管理的组织。企业套餐以组织为单位：owner 邀请成员，成员各自建自己的 Key 走组织额度。
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <OrgsContent orgs={orgs} />
      )}
    </div>
  );
}
