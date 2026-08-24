/**
 * 资金来源解析器桥接件（装配面——仅 assembly.ts 引用，architecture 测试锁定）。
 * DESIGN §5/D2：resolver 唯一消费方是推理授权链（billing.authorize，gateway 面）；
 * admin 面无此路径——显式红灯（禁静默降级），gateway 波的 accounts funding-resolver
 * 落地并提交后如需授权链再按需桥接。
 */
import { InfrastructureError } from '@tillgate/errors';
import type { FundingSourceResolver } from '@tillgate/billing';

export function createAdminFundingResolver(): FundingSourceResolver {
  return {
    resolve() {
      throw new InfrastructureError(
        'admin-api does not resolve funding sources (no inference authorize path on the admin face)',
        'admin.funding_resolver_unavailable',
      );
    },
  };
}
