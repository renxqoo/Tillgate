import { describe, expect, it } from 'vitest';
import { ERROR_REGISTRY, errorSpec } from '../error-codes.js';

/**
 * 网关错误码分区分级测试（原则 6 的编译外护栏）：
 *
 * 网关对外码（小写蛇形命名空间）受两条结构纪律约束——
 *   1) 只有 internal_error 允许 500：任何其他码把服务端故障伪装成客户端问题的
 *      提交都会在此红灯；
 *   2) 命名纪律：网关区必须小写蛇形（与 admin/user 面大写蛇形区分命名空间）。
 *
 * 注册表是全网关对外错误码的唯一真相（2026-08 统一错误体系），
 * 新码必须登记后使用（HttpError 构造参数为 KnownErrorCode，编译期强制）。
 */

const GATEWAY_CODES = Object.keys(ERROR_REGISTRY).filter((code) => /^[a-z][a-z0-9_]*$/.test(code));

describe('ERROR_REGISTRY 网关分区分级', () => {
  it('网关码集合非空且包含关键码', () => {
    expect(GATEWAY_CODES.length).toBeGreaterThan(20);
    for (const code of [
      'internal_error',
      'rate_limit_exceeded',
      'insufficient_balance',
      'no_available_channel',
      'model_not_allowed',
      'invalid_api_key',
    ]) {
      expect(GATEWAY_CODES).toContain(code);
    }
  });

  it('网关区只有 internal_error 允许 500（错误语义分级）', () => {
    for (const code of GATEWAY_CODES) {
      const status = ERROR_REGISTRY[code as keyof typeof ERROR_REGISTRY].status;
      if (status === 500) {
        expect(code).toBe('internal_error');
      }
      // 502/503 是合法的可用性语义（上游不可用/平台状态），不算伪装 500
      if (code === 'internal_error') {
        expect(status).toBe(500);
      }
    }
  });

  it('资金拒绝码必须是 402', () => {
    for (const code of [
      'insufficient_balance',
      'daily_spend_limit_exceeded',
      'member_daily_limit',
      'member_quota_exceeded',
      'subscription_required',
      'subscription_quota_exhausted',
      'subscription_forbidden',
    ]) {
      expect(errorSpec(code)?.status).toBe(402);
    }
  });

  it('限流码必须是 429', () => {
    for (const code of [
      'rate_limit_exceeded',
      'free_model_daily_limit_exceeded',
      'auth_failure_rate_limited',
      'key_locked',
    ]) {
      expect(errorSpec(code)?.status).toBe(429);
    }
  });

  it('每个码都有非空默认文案', () => {
    for (const [code, spec] of Object.entries(ERROR_REGISTRY)) {
      expect(spec.message.length, code).toBeGreaterThan(0);
      expect(spec.status, code).toBeGreaterThanOrEqual(400);
      expect(spec.status, code).toBeLessThan(600);
    }
  });
});
