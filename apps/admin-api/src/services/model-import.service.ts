/**
 * 模型目录种子导入（审批制）：models.dev 快照 → model_mappings 草稿。
 *
 * 资金铁律：价格属资金语义——导入一律 status=1（下架草稿态），管理员在模型页
 * 逐个复核价格后手动上架；本服务绝不自动启用任何条目。
 * 幂等：externalName+realModel 重复的种子条目跳过（返回 skipped 明细），
 * 不覆盖既有定价（防导入悄悄改价）。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { recordAudit } from '@ai-gateway/http';
import { AppError } from '../http/error-map.js';

export interface SeedModelEntry {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  inputs: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ImportResult {
  created: number;
  skipped: Array<{ externalName: string; realModel: string; reason: 'duplicate' }>;
  /** 单批上界（防误传全量 981 条一次灌入——分批导入） */
  limit: number;
}

/** 单批上界：种子 981 条，按 100 一批导入（curl 分批喂） */
export const IMPORT_BATCH_LIMIT = 100;

function priceOf(v: unknown): string {
  const n = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  return String(n);
}

export function createModelImportService(deps: { db: Db; repos?: Repositories }) {
  const repos = deps.repos ?? createRepositories();

  return {
    /** dryRun=true 只校验与统计，不落库（预览导入效果） */
    async importSeed(
      ctx: RunContext,
      input: { adminId: number; models: SeedModelEntry[]; dryRun?: boolean },
    ): Promise<ImportResult> {
      if (input.models.length === 0) {
        throw new AppError(400, 'invalid_param', '导入列表为空');
      }
      if (input.models.length > IMPORT_BATCH_LIMIT) {
        throw new AppError(400, 'import_batch_too_large', `单批至多 ${IMPORT_BATCH_LIMIT} 条（种子 981 条请分批）`);
      }
      const skipped: ImportResult['skipped'] = [];
      let created = 0;
      for (const m of input.models) {
        if (typeof m.id !== 'string' || m.id === '' || typeof m.provider !== 'string') {
          throw new AppError(400, 'invalid_param', `种子条目缺 id/provider：${JSON.stringify(m).slice(0, 80)}`);
        }
        const externalName = `${m.provider}/${m.id}`;
        const existing = await repos.modelMapping.findByExternalName({ db: deps.db, ...ctx }, externalName);
        if (existing != null) {
          skipped.push({ externalName, realModel: m.id, reason: 'duplicate' });
          continue;
        }
        if (input.dryRun === true) {
          created += 1;
          continue;
        }
        await repos.modelMapping.insertMapping({ db: deps.db, ...ctx }, {
          externalName,
          realModel: m.id,
          contextLength: m.contextWindow > 0 ? m.contextWindow : null,
          // 草稿态：status=1（下架）——价格复核后管理员手动上架
          status: 1,
          inputPrice: priceOf(m.cost?.input),
          outputPrice: priceOf(m.cost?.output),
          cacheInputPrice: priceOf(m.cost?.cacheRead),
          cacheWritePrice: priceOf(m.cost?.cacheWrite),
          isFree: false,
        });
        created += 1;
      }
      if (input.dryRun !== true) {
        await recordAudit(deps.db, {
          actor: 'admin',
          adminId: input.adminId,
          action: 'model.import',
          targetType: 'model_catalog',
          targetId: 0,
          detail: { created, skipped: skipped.length, dryRun: false },
        });
      }
      return { created, skipped, limit: IMPORT_BATCH_LIMIT };
    },
  };
}
