/**
 * 动态人机验证（identity Captcha 的集成设置驱动实现——DESIGN §5 D7）。
 * 每次验证严格读快照；未生效返回 unavailable（注册闸门在路由层按快照跳过——
 * 到达本适配器的「已关闭」只可能是闸门后的竞态，fail-closed 方向安全）。
 */
import type { IntegrationSettingsReader } from '@tillgate/control-plane';
import type { Captcha } from '@tillgate/identity';

import { createTurnstileCaptcha } from './turnstile-captcha.js';

/** siteverify 官方端点（原 env CAPTCHA_VERIFY_URL 缺省迁此——单一真相） */
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function createDynamicCaptcha(args: {
  readonly reader: IntegrationSettingsReader;
}): Captcha {
  return {
    async verify(input) {
      const snapshot = await args.reader.resolve();
      const captcha = snapshot.captcha.config;
      if (captcha == null || !snapshot.captcha.effective) {
        return { ok: false, reason: 'unavailable' as const };
      }
      // 无状态 fetch 包装——按次构造成本可忽略（低 QPS 注册闸门）
      return createTurnstileCaptcha({
        secretKey: captcha.secretKey,
        verifyUrl: captcha.verifyUrl ?? TURNSTILE_VERIFY_URL,
      }).verify(input);
    },
  };
}
