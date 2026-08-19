import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { modelMappings, users } from '@ai-gateway/db/schema';
import { loadRateCardCoefficients, pickCoefficient } from '@ai-gateway/ledger';
import { Decimal } from '@ai-gateway/wallet/metering';
import type { ClientEnv } from '@ai-gateway/identity';

/**
 * 定价数据（口径单一真相）：
 *   GET /api/public/pricing —— 公开：官方价 + 系数 1（未登录定价页）
 *   GET /api/pricing        —— 会话：按用户费率卡解析到手价（model>group>global）
 * 官方价来自 model_mappings；单位计费模型（按次/张/秒/字符）同表 pricing_unit/unit_price。
 */

interface PricingModel {
  id: number;
  externalName: string;
  contextLength: number | null;
  pricingUnit: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  unitPrice: string;
  isFree: boolean;
  effective: { inputPrice: string; outputPrice: string; cacheInputPrice: string; unitPrice: string };
  coefficient: string;
}

function toPricingModels(
  rows: Array<typeof modelMappings.$inferSelect>,
  snapshot: Awaited<ReturnType<typeof loadRateCardCoefficients>>,
): PricingModel[] {
  return rows.map((m) => {
    const coefficient = pickCoefficient(snapshot, { modelMappingId: m.id, pricingGroup: m.pricingGroup });
    const coeff = new Decimal(coefficient);
    const mul = (price: string): string => new Decimal(price).times(coeff).toString();
    return {
      id: m.id,
      externalName: m.externalName,
      contextLength: m.contextLength,
      pricingUnit: m.pricingUnit,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      cacheInputPrice: m.cacheInputPrice,
      unitPrice: m.unitPrice,
      isFree: m.isFree,
      effective: {
        inputPrice: mul(m.inputPrice),
        outputPrice: mul(m.outputPrice),
        cacheInputPrice: mul(m.cacheInputPrice),
        unitPrice: mul(m.unitPrice),
      },
      coefficient,
    };
  });
}

export function publicPricingRoutes(db: Db): Hono {
  return new Hono().get('/pricing', async (c) => {
    const rows = await db.query.modelMappings.findMany({
      where: eq(modelMappings.status, 0),
    });
    return c.json({ models: toPricingModels(rows, null), personalized: false });
  });
}

export function pricingRoutes(db: Db): Hono<ClientEnv> {
  return new Hono<ClientEnv>().get('/', async (c) => {
    const rows = await db.query.modelMappings.findMany({
      where: eq(modelMappings.status, 0),
    });
    const user = await db.query.users.findFirst({
      where: eq(users.id, c.var.session.userId),
      columns: { rateCardId: true },
    });
    const snapshot = user?.rateCardId != null ? await loadRateCardCoefficients(db, user.rateCardId) : null;
    return c.json({
      models: toPricingModels(rows, snapshot),
      personalized: snapshot !== null,
      rateCardStatus: snapshot?.status ?? null,
    });
  });
}
