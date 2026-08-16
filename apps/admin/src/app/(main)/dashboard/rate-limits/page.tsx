import { GaugeIcon } from "lucide-react";

import type { AdminChannelRow, AdminKeyRow, AdminModelRow, AdminUserRow } from "@ai-gateway/api-client";
import { fetchAdminList } from "@ai-gateway/api-client/list";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { firstParam } from "@ai-gateway/ui/lib/list-query";

import { RateLimitsClient } from "./_components/rate-limits-content";
import type { RateLimitItem } from "./types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RateLimitsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const q = firstParam(sp.q) ?? "";
  // 并发拉取 4 类实体（统一分页接口 + q 搜索）；任一失败不阻塞整页
  const [usersRes, modelsRes, channelsRes, keysRes] = await Promise.allSettled([
    fetchAdminList<AdminUserRow>("/api/admin/users", { pageSize: 100, extra: { q } }),
    fetchAdminList<AdminModelRow>("/api/admin/models", { pageSize: 100, extra: { q } }),
    fetchAdminList<AdminChannelRow>("/api/admin/channels", { pageSize: 100, extra: { q } }),
    fetchAdminList<AdminKeyRow>("/api/admin/keys", { pageSize: 100, extra: { q } }),
  ]);

  const users: RateLimitItem[] =
    usersRes.status === "fulfilled"
      ? usersRes.value.rows.map((u) => ({
          id: u.id,
          label: u.email ?? `用户#${u.id}`,
          sublabel: u.displayName,
          rpmLimit: u.rpmLimit,
          tpmLimit: u.tpmLimit,
          creditLimit: u.creditLimit === null ? null : Number(u.creditLimit),
          dailySpendLimit: u.dailySpendLimit === null ? null : Number(u.dailySpendLimit),
          status: u.status,
        }))
      : [];
  const models: RateLimitItem[] =
    modelsRes.status === "fulfilled"
      ? modelsRes.value.rows.map((m) => ({
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
      ? channelsRes.value.rows.map((c) => ({
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
      ? keysRes.value.rows.map((k) => ({
          id: k.id,
          label: k.name,
          sublabel: `${k.subscriptionId != null ? "套餐" : "余额"} · ${k.keyPreview}`,
          rpmLimit: k.rpmLimit,
          tpmLimit: k.tpmLimit,
          dailySpendLimit: k.dailySpendLimit === null ? null : Number(k.dailySpendLimit),
          status: k.status,
        }))
      : [];

  const error =
    usersRes.status === "rejected" &&
    modelsRes.status === "rejected" &&
    channelsRes.status === "rejected" &&
    keysRes.status === "rejected"
      ? usersRes.reason instanceof Error
        ? usersRes.reason.message
        : "加载失败"
      : null;

  return (
    <ListPage
      title="限流设置"
      icon={<GaugeIcon className="size-5 text-muted-foreground" />}
      description="集中管理 用户 / 模型 / 渠道 / Key 的 RPM·TPM 限额；用户另含透支上限，用户与 Key 另含每日花费上限（改后立即生效）"
      searchPlaceholder="搜索用户 / 模型 / 渠道 / Key"
      q={q}
      searchParams={{ q }}
      error={error}
    >
      <RateLimitsClient users={users} models={models} channels={channels} keys={keys} />
    </ListPage>
  );
}
