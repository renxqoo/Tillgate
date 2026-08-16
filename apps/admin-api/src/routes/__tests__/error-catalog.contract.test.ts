import { describe, expect, it } from 'vitest';
import { LEDGER_HTTP } from '@ai-gateway/ledger';
import { ERROR_REGISTRY } from '@ai-gateway/http';

/**
 * 跨包契约：ledger 错误目录（单一真相）引用的每个 HTTP 错误码必须已登记在
 * packages/http 错误码注册表，且状态码一致——否则调用点的
 * `new HttpError(code)` 编译通过但运行时拿不到注册表状态码。
 */
describe('错误码契约：LEDGER_HTTP ↔ ERROR_REGISTRY', () => {
  it('目录中每个码都已注册且状态码一致', () => {
    for (const [ledgerCode, mapping] of Object.entries(LEDGER_HTTP)) {
      const spec = ERROR_REGISTRY[mapping.code as keyof typeof ERROR_REGISTRY];
      expect(spec, `LEDGER_HTTP[${ledgerCode}].code=${mapping.code} 未登记于 ERROR_REGISTRY`)
        .toBeDefined();
      expect(spec?.status, `${mapping.code} 状态码不一致`).toBe(mapping.status);
    }
  });
});
