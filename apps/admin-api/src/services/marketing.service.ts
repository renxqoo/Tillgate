/**
 * 营销配置 + 邀请管理服务：marketing_settings 读写（管理面唯一入口，全程审计）、
 * 邀请关系列表/封禁、三类返利流水投影。
 */
import { recordAudit } from '@ai-gateway/http';
import { createRepositories, type Db, type Repositories, type MarketingSettings } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';

export function createMarketingService(deps: { db: Db; repos?: Repositories }) {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();

  return {
    async getSettings(ctx: RunContext): Promise<MarketingSettings> {
      return repos.marketing.getSettings({ db, ...ctx });
    },

    async updateSettings(
      ctx: RunContext,
      input: { adminId: number; signupGiftAmount: string; referralSignupBonus: string; referralCommissionRate: string },
    ) {
      const { adminId, ...values } = input;
      const settings = await repos.marketing.updateSettings({ db, ...ctx }, { ...values, updatedBy: adminId });
      await recordAudit(db, {
        actor: 'admin',
        adminId,
        action: 'marketing.settings.update',
        targetType: 'marketing_settings',
        targetId: '1',
        detail: { ...values },
      });
      return settings;
    },

    async listRelations(ctx: RunContext, input: { q?: string; limit: number; offset: number }) {
      return repos.marketing.listRelations({ db, ...ctx }, input);
    },

    async setRelationStatus(ctx: RunContext, input: { adminId: number; relationId: number; status: 0 | 1 }) {
      const { adminId, ...rest } = input;
      const ok = await repos.marketing.setRelationStatus({ db, ...ctx }, rest);
      if (!ok) throw new AppError(404, 'relation_not_found', 'Referral relation not found');
      await recordAudit(db, {
        actor: 'admin',
        adminId,
        action: 'referral.relation.update',
        targetType: 'referral',
        targetId: String(rest.relationId),
        detail: { status: rest.status },
      });
      return { ok: true as const, ...rest };
    },

    async listPayouts(ctx: RunContext, input: { kind: 'commission' | 'referral_signup' | 'gift'; limit: number; offset: number }) {
      return repos.marketing.listPayouts({ db, ...ctx }, input);
    },
  };
}

export type MarketingService = ReturnType<typeof createMarketingService>;
