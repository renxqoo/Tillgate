import { KeyRoundIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { apiFetch, type CurrentSubscription } from "@ai-gateway/api-client";
import { fetchUserList } from "@ai-gateway/api-client/list";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { firstParam, parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import type { KeyRow } from "@ai-gateway/api-client/types";
import { CreateKeyDialog, KeysTable } from "./_components/keys-content";
import { ExportKeys } from "./_components/export-keys";
import { KeysStatusFilter } from "./_components/keys-filter";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function KeysPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations("keys");
  const tCommon = await getTranslations("common");
  const { page } = parseListSearchParams(sp);
  const q = (firstParam(sp.q) ?? "").trim();
  const status = firstParam(sp.status) ?? "all";

  let keys: KeyRow[] = [];
  let total = 0;
  let error: string | null = null;
  let subscriptions: Array<{ id: number; label: string }> = [];
  if (process.env.DEV_FAKE_ME === "1" && process.env.NODE_ENV !== "production") {
    keys = MOCK_KEYS;
    total = MOCK_KEYS.length;
  } else {
    const result = await fetchUserList<KeyRow>("/v1/keys", {
      page,
      pageSize: PAGE_SIZE,
      extra: { q },
    });
    keys = result.rows;
    total = result.total;
    error = result.error;
    // 计费来源下拉：个人订阅 + 所属组织订阅（含余额选项，由弹窗固定渲染）。
    try {
      const subResult = await apiFetch<{ rows?: CurrentSubscription[] }>("/v1/subscriptions");
      const sub: CurrentSubscription | null = subResult.rows?.[0] ?? null;
      if (sub) subscriptions.push({ id: sub.id, label: sub.planName });
    } catch {
      // 拿不到个人订阅不影响创建
    }
    try {
      const orgs = await apiFetch<{
        rows: Array<{ name: string; subscriptionId: number | null; planName: string | null }>;
      }>("/v1/orgs");
      for (const o of orgs.rows) {
        if (o.subscriptionId != null) {
          subscriptions.push({ id: o.subscriptionId, label: `${o.name} · ${o.planName ?? t("planFallback")}` });
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
      {process.env.DEV_FAKE_ME === "1" && process.env.NODE_ENV !== "production" && (
        <p className="text-xs text-amber-600 bg-amber-500/10 px-3 py-1.5 rounded-md ring-1 ring-amber-500/30">
          ⚠️ {tCommon("devMockNotice")}
        </p>
      )}

      <ListPage
        title={t("title")}
        icon={<KeyRoundIcon className="size-5 text-muted-foreground" />}
        total={total}
        totalUnit={t("totalUnit")}
        searchPlaceholder={t("searchPlaceholder")}
        q={q}
        searchParams={{ q, status: status !== "all" ? status : undefined }}
        filters={
          <>
            <KeysStatusFilter value={status} />
            <ExportKeys keys={keys} />
          </>
        }
        actions={<CreateKeyDialog subscriptions={subscriptions} />}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <KeysTable keys={keys} subscriptionLabels={subscriptionLabels} />
      </ListPage>
    </div>
  );
}

const MOCK_KEYS: KeyRow[] = [
  { id: 1, name: "production", keyPreview: "ag-****-a1b2", remark: "main project", subscriptionId: null, status: 0, rpmLimit: 2000, tpmLimit: 1000000, dailySpendLimit: null, expiresAt: null, lastUsedAt: new Date().toISOString(), createdAt: "2026-07-15T09:21:00.000Z" },
  { id: 2, name: "staging", keyPreview: "ag-****-c3d4", remark: "staging env", subscriptionId: 1, status: 0, rpmLimit: 500, tpmLimit: 200000, dailySpendLimit: "50", expiresAt: null, lastUsedAt: "2026-08-01T14:00:00.000Z", createdAt: "2026-07-10T11:00:00.000Z" },
  { id: 3, name: "legacy-bot", keyPreview: "ag-****-e5f6", remark: null, subscriptionId: null, status: 1, rpmLimit: 100, tpmLimit: 50000, dailySpendLimit: null, expiresAt: null, lastUsedAt: "2025-12-01T08:00:00.000Z", createdAt: "2025-06-04T11:00:00.000Z" },
];

