/**
 * 价格溯源：某对外名历次目录导入/改价的 provenance 全链
 * （目录价 × fx → 预填 → 提交——任何价格都能回答「从哪来、谁改的」）。
 */
import type { Db } from '@tokenlens/db';
import type { AuditStore } from '../../ports/audit-store';

export interface CatalogPriceHistoryEntry {
  readonly action: string;
  readonly createdAt: string;
  readonly adminId: number | null;
  readonly fx: {
    baseRate: string;
    effectiveRate: string | null;
    source: string | null;
    fetchedAt: string | null;
  } | null;
  readonly catalogPrompt: string | null;
  readonly catalogCompletion: string | null;
  readonly prefillInputCny: string | null;
  readonly submittedInputCny: string;
  readonly submittedOutputCny: string;
}

export interface PriceHistoryDeps {
  readonly db: Db;
  readonly stores: { readonly audit: AuditStore };
}

export async function catalogPriceHistory(
  deps: PriceHistoryDeps,
  input: { externalName: string },
): Promise<CatalogPriceHistoryEntry[]> {
  const rows = await deps.stores.audit.listCatalogPriceHistory(deps.db, input);
  return rows.map((r) => {
    const detail = (r.detail ?? {}) as {
      fx?: {
        baseRate: string;
        effectiveRate: string | null;
        source: string | null;
        fetchedAt: string | null;
      } | null;
      models?: Array<{
        externalName: string;
        catalogPrompt: string | null;
        catalogCompletion: string | null;
        prefillInputCny: string | null;
        submittedInputCny: string;
        submittedOutputCny: string;
      }>;
    };
    const entry = detail.models?.find((m) => m.externalName === input.externalName) ?? null;
    return {
      action: r.action,
      createdAt: r.createdAt.toISOString(),
      adminId: r.adminId,
      fx: detail.fx ?? null,
      catalogPrompt: entry?.catalogPrompt ?? null,
      catalogCompletion: entry?.catalogCompletion ?? null,
      prefillInputCny: entry?.prefillInputCny ?? null,
      submittedInputCny: entry?.submittedInputCny ?? '0',
      submittedOutputCny: entry?.submittedOutputCny ?? '0',
    };
  });
}
