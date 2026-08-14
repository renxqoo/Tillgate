import { KeyRoundIcon, SearchIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";
import { Input } from "@ai-gateway/ui/components/ui/input";
import { ApiError, apiFetch, fmtInt, type CurrentSubscription as ApiCurrentSubscription, type KeyRow as ApiKeyRow, type Paginated } from "@ai-gateway/api-client";

import { type KeyRow } from "./types";
import { CreateKeyDialog, KeysTable } from "./_components/keys-content";
import { ExportKeys } from "./_components/export-keys";
import { KeysStatusFilter } from "./_components/keys-filter";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string; status?: string }>;
}

export default async function KeysPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const pageSize = 20;
  const q = (sp.q ?? "").trim();
  const status = sp.status ?? "all";

  let keys: KeyRow[] = [];
  let total = 0;
  let error: string | null = null;
  let subscriptions: Array<{ id: number; label: string }> = [];
  if (process.env.DEV_FAKE_ME === "1") {
    keys = MOCK_KEYS;
    total = MOCK_KEYS.length;
  } else {
    try {
      const qs = new URLSearchParams({
        page: String(page),
        page_size: String(pageSize),
      });
      if (q) qs.set("q", q);
      const data = await apiFetch<Paginated<ApiKeyRow>>(`/api/keys?${qs.toString()}`);
      keys = data.list;
      total = data.total;
    } catch (e) {
      error = e instanceof ApiError ? e.message : "加载失败";
    }
    // 计费来源下拉：个人订阅 + 所属组织订阅（含余额选项，由弹窗固定渲染）。
    try {
      const sub = await apiFetch<ApiCurrentSubscription | null>("/api/me/subscription");
      if (sub) subscriptions.push({ id: sub.id, label: sub.planName });
    } catch {
      // 拿不到个人订阅不影响创建
    }
    try {
      const orgs = await apiFetch<{
        list: Array<{ name: string; subscriptionId: number | null; subscriptionName: string | null }>;
      }>("/api/orgs");
      for (const o of orgs.list ?? []) {
        if (o.subscriptionId != null) {
          subscriptions.push({ id: o.subscriptionId, label: `${o.name} · ${o.subscriptionName ?? "套餐"}` });
        }
      }
    } catch {
      // 拿不到组织订阅不影响创建
    }
  }

  const subscriptionLabels = new Map<number, string>(
    subscriptions.map((s) => [s.id, s.label]),
  );

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      {/* dev 模式下显示 mock 标识 */}
      {process.env.DEV_FAKE_ME === "1" && (
        <p className="text-xs text-amber-600 bg-amber-500/10 px-3 py-1.5 rounded-md ring-1 ring-amber-500/30">
          ⚠️ DEV_FAKE_ME=1 模式：以下数据为 mock（admin-api 未连接）
        </p>
      )}

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <KeyRoundIcon className="size-5 text-muted-foreground" />
            API Key 管理
          </h1>
          <p className="text-sm text-muted-foreground">
            管理虚拟 API Key（共 {fmtInt(total)} 个）
          </p>
        </div>
        <CreateKeyDialog subscriptions={subscriptions} />
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">Key 列表</CardTitle>
              <CardDescription>所有 API Key，最多显示 {pageSize} 条</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <form method="GET" className="relative">
                <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  name="q"
                  defaultValue={q}
                  placeholder="搜索 Key 名称或备注"
                  className="pl-9 w-56"
                />
                {status !== "all" && <input type="hidden" name="status" value={status} />}
              </form>
              <KeysStatusFilter value={status} />
              <ExportKeys keys={keys} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <KeysTable keys={keys} subscriptionLabels={subscriptionLabels} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const MOCK_KEYS: KeyRow[] = [
  { id: 1, name: "production", keyPreview: "ag-****-a1b2", remark: "主项目", subscriptionId: null, status: 0, rpmLimit: 2000, tpmLimit: 1000000, dailySpendLimit: null, expiresAt: null, lastUsedAt: new Date().toISOString(), createdAt: "2026-07-15T09:21:00.000Z" },
  { id: 2, name: "staging", keyPreview: "ag-****-c3d4", remark: "测试环境", subscriptionId: 1, status: 0, rpmLimit: 500, tpmLimit: 200000, dailySpendLimit: "50", expiresAt: null, lastUsedAt: "2026-08-01T14:00:00.000Z", createdAt: "2026-07-10T11:00:00.000Z" },
  { id: 3, name: "legacy-bot", keyPreview: "ag-****-e5f6", remark: null, subscriptionId: null, status: 1, rpmLimit: 100, tpmLimit: 50000, dailySpendLimit: null, expiresAt: null, lastUsedAt: "2025-12-01T08:00:00.000Z", createdAt: "2025-06-04T11:00:00.000Z" },
];

