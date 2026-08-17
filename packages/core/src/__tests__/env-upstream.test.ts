import { describe, expect, it } from 'vitest';

/**
 * 上游调用面 env 解析回归（ALLOW_LOCAL_UPSTREAM / UPSTREAM_HOST_ALLOWLIST）：
 * env 值恒为字符串——worker schema 曾误用 z.boolean()/z.array() 导致
 * ALLOW_LOCAL_UPSTREAM=true 启动即崩（2026-08-16 dev 实况）。解析现收为
 * gateway/worker 共用 schema（单一真相），此测试钉死字符串语义不再漂移。
 */

/** 真实 env 形态：一切值都是字符串（dotenv/process.env 无类型） */
const stringEnv = {
  ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789abcdef',
  JWT_SECRET: 'unit-test-jwt-secret-16-chars',
  ALLOW_LOCAL_UPSTREAM: 'true',
  UPSTREAM_HOST_ALLOWLIST: 'Api.Openai.com, api.minimaxi.com ,,',
};

describe('core env — 上游调用面（gateway/worker 单一真相）', () => {
  it('worker：字符串 true → 布尔；白名单字符串 → 数组（小写、去空白项）', async () => {
    const { loadWorkerEnv } = await import('../env.js');
    const env = loadWorkerEnv(stringEnv);
    expect(env.ALLOW_LOCAL_UPSTREAM).toBe(true);
    expect(env.UPSTREAM_HOST_ALLOWLIST).toEqual(['api.openai.com', 'api.minimaxi.com']);
  });

  it('gateway 与 worker 同输入同解析（同源语义不漂移）', async () => {
    const { loadGatewayEnv, loadWorkerEnv } = await import('../env.js');
    expect(loadGatewayEnv(stringEnv).ALLOW_LOCAL_UPSTREAM).toBe(
      loadWorkerEnv(stringEnv).ALLOW_LOCAL_UPSTREAM,
    );
  });

  it("拼错值（'yes'）启动即失败——拒绝猜测式布尔转换（'false' 会被静默当 true）", async () => {
    const { loadWorkerEnv } = await import('../env.js');
    expect(() => loadWorkerEnv({ ...stringEnv, ALLOW_LOCAL_UPSTREAM: 'yes' })).toThrow();
  });

  it('缺省：false + 生产默认白名单', async () => {
    const { loadWorkerEnv } = await import('../env.js');
    const { ALLOW_LOCAL_UPSTREAM, UPSTREAM_HOST_ALLOWLIST } = loadWorkerEnv({
      ENCRYPTION_KEY: stringEnv.ENCRYPTION_KEY,
    });
    expect(ALLOW_LOCAL_UPSTREAM).toBe(false);
    expect(UPSTREAM_HOST_ALLOWLIST).toContain('api.openai.com');
  });
});
