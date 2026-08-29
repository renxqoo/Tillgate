/**
 * 智能路由管理面：策略读写（热配置入口）+ 渠道观测聚合。
 *   - GET  /v1/routing-policy           当前生效策略（未配置 = 200 body { unconfigured: true, policy: 缺省 }）
 *   - PUT  /v1/routing-policy           保存策略（contracts/routing-policy 校验，version 自增，审计留痕）
 *   - GET  /v1/routing/channels-overview 近窗渠道观测（调参依据——观测闭环）
 * 校验单一真相 = @tillgate/inference routingPolicySchema（网关读侧同 schema parse）。
 */
import { Hono } from 'hono';
import { defaultRoutingPolicy } from '@tillgate/inference';
import type { ControlPlane } from '@tillgate/control-plane';
import { jsonBody } from '@tillgate/http';
import type { Context } from 'hono';
import { controlContextOf, type SessionEnv } from '../middleware/session';
import { routingPolicyContracts, type SaveRoutingPolicyRequest } from '../contracts/routing-policy';

export interface RoutingPolicyRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'routingPolicy'>;
}

/** 保存处理器（模块级——路由函数行数预算外提）：note 边界校验 + 落库 + 假成功拒绝 */
async function savePolicyHandler(
  routingPolicy: ControlPlane['routingPolicy'],
  c: Context<SessionEnv>,
  body: SaveRoutingPolicyRequest,
): Promise<Response> {
  const ctx = controlContextOf(c);
  const { policy, note } = body;
  // 用例层：原子 upsert + 审计（策略快照进 audit_logs——旧版本可追溯）
  const saved = await routingPolicy.save({ policy, note, ctx });
  return c.json({ ok: true, version: saved.version, savedAt: saved.savedAt });
}

export function routingPolicyRoutes(deps: RoutingPolicyRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const { routingPolicy } = deps.controlPlane;

  app.get('/v1/routing-policy', async (c) => {
    const record = await routingPolicy.get();
    if (record == null) {
      // 编译期缺省随响应携带（前端表单初值——前端不依赖 inference 运行时）
      return c.json({ unconfigured: true, policy: defaultRoutingPolicy() });
    }
    return c.json({
      version: record.version,
      policy: record.policy,
      note: record.note,
      updatedBy: record.updatedBy,
      updatedAt: record.updatedAt,
    });
  });

  // 契约：{policy, note?}——note 走 body（HTTP 头 latin-1 限制中文，且可边界校验）
  app.put('/v1/routing-policy', jsonBody(routingPolicyContracts.save), async (c) =>
    savePolicyHandler(routingPolicy, c, c.req.valid('json')),
  );

  app.get('/v1/routing/channels-overview', async (c) => {
    const windowMs = Number(c.req.query('windowMs') ?? 3_600_000);
    const rows = await routingPolicy.channelsOverview(
      Number.isFinite(windowMs) && windowMs > 0 && windowMs <= 86_400_000 ? windowMs : 3_600_000,
    );
    return c.json({ rows });
  });

  return app;
}
