/**
 * 公开模型定价路由（无会话——价格目录是公共信息；登录墙外价格页/Playground 用）。
 * 取数与缓存经 pricing-read（control-plane 只读目录 + Redis 共享缓存——分层铁律：
 * http 层不触 store）；本层只做查询解析、过滤切页与响应形状。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { RateCardCoefficientSnapshot } from '@tillgate/billing';
import { parsePricingQuery } from '../contracts/pricing.js';
import {
  slicePricingCatalog,
  toPersonalPricingRows,
  toPublicPricingRows,
  type BaseCatalog,
} from '../presenters/pricing.js';
import type { SessionEnv } from '../middleware/session.js';

export interface PricingReads {
  /** 基础目录（已缓存）；realModel 仅供内部对账，presenter 不出面 */
  baseCatalog(): Promise<BaseCatalog>;
  /** 用户费率卡系数快照（无绑定 = null） */
  rateCardSnapshot(userId: number): Promise<RateCardCoefficientSnapshot | null>;
  /** 计费时区（时段窗口的墙钟口径——信封级说明字段） */
  billingTimezone(): Promise<string>;
}

export function pricingRoutes(reads: PricingReads, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/pricing', async (c) => {
    const query = parsePricingQuery(new URL(c.req.url));
    const [rows, billingTimezone] = await Promise.all([
      reads.baseCatalog().then(toPublicPricingRows),
      reads.billingTimezone(),
    ]);
    return c.json({ ...slicePricingCatalog(rows, query), billingTimezone });
  });

  // 个性化价格：费率卡系数 × 官方价 = 到手价（基础目录走共享缓存，快照按用户解析）
  app.get('/v1/pricing/personal', session, async (c) => {
    const query = parsePricingQuery(new URL(c.req.url));
    const [catalog, snapshot, billingTimezone] = await Promise.all([
      reads.baseCatalog(),
      reads.rateCardSnapshot(c.get('userId')),
      reads.billingTimezone(),
    ]);
    const rows = toPersonalPricingRows(catalog, snapshot);
    return c.json({ ...slicePricingCatalog(rows, query), billingTimezone });
  });

  return app;
}
