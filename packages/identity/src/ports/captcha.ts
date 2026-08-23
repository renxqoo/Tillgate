/**
 * 人机验证 port(Turnstile 语义)。结果二分:invalid = 客户端过错(票据缺失/伪造/
 * 过期/重放);unavailable = 其余一切(配置过错/网络失败/非 200/未知码)——
 * fail-closed,防「打瘫验证厂商即免验证」。实现见 adapters/turnstile/captcha.ts。
 */
export interface Captcha {
  verify(input: {
    token: string;
    remoteIp?: string;
  }): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'unavailable' }>;
}
