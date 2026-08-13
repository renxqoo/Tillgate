import { GaugeIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type AdminChannelRow,
  type AdminKeyRow,
  type AdminModelRow,
  type AdminUserRow,
  type ListResult,
} from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";

import { RateLimitsClient } from "./_components/rate-limits-content";
import type { RateLimitItem } from "./types";

export const dynamic = "force-dynamic";

const PS = "page_size=100";

export default async function RateLimitsPage() {
  // 并发拉取 4 类实体（复用现有 GET + 新 keys GET）；任一失败不阻塞整页
  const [usersRes, modelsRes, channelsRes, keysRes] = await Promise.allSettled([
    adminFetch<ListResult<AdminUserRow>>(`/api/admin/users?${PS}`),
    adminFetch<{ list: AdminModelRow[] }>(`/api/admin/models`),
    adminFetch<{ list: AdminChannelRow[] }>(`/api/admin/channels?${PS}`),
    adminFetch<ListResult<AdminKeyRow>>(`/api/admin/keys?${PS}`),
  ]);

  const users: RateLimitItem[] =
    usersRes.status === "fulfilled"
      ? (usersRes.value.list ?? []).map((u) => ({
          id: u.id,
          label: u.email ?? `用户#${u.id}`,
          sublabel: u.displayName,
          rpmLimit: u.rpmLimit,
          tpmLimit: u.tpmLimit,
          status: u.status,
        }))
      : [];
  const models: RateLimitItem[] =
    modelsRes.status === "fulfilled"
      ? (modelsRes.value.list ?? []).map((m) => ({
          id: m.id,
          label: m.externalName,
          sublabel: m.realModel,
          rpmLimit: m.rpmLimit,
          tpmLimit: m.tpmLimit,
          status: m.status,
        }))
      : [];
  const channels: RateLimitItem[] =
    channelsRes.status === "fulfilled"
      ? (channelsRes.value.list ?? []).map((c) => ({
          id: c.id,
          label: c.name,
          sublabel: c.providerName,
          rpmLimit: c.rpmLimit,
          tpmLimit: c.tpmLimit,
          status: c.status,
        }))
      : [];
  const keys: RateLimitItem[] =
    keysRes.status === "fulfilled"
      ? (keysRes.value.list ?? []).map((k) => ({
          id: k.id,
          label: k.name,
          sublabel: k.keyPreview,
          rpmLimit: k.rpmLimit,
          tpmLimit: k.tpmLimit,
          status: k.status,
        }))
      : [];

  const allFailed =
    usersRes.status === "rejected" &&
    modelsRes.status === "rejected" &&
    channelsRes.status === "rejected" &&
    keysRes.status === "rejected";

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GaugeIcon className="size-5 text-muted-foreground" />
          限流设置
        </h1>
        <p className="text-sm text-muted-foreground">
          集中管理 用户 / 模型 / 渠道 / Key 的 RPM·TPM 限额（改后立即生效）
        </p>
      </div>

      {allFailed ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {usersRes.status === "rejected" && usersRes.reason instanceof ApiError
              ? usersRes.reason.message
              : "加载失败"}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="px-0">
          <RateLimitsClient users={users} models={models} channels={channels} keys={keys} />
        </CardContent>
      </Card>
    </div>
  );
}
