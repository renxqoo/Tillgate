/**
 * OAuth 回调错误码 → 结构化文案映射回归（2026-08-31）：client-api 回调失败以
 * ?oauth_error=<code> 302 前端错误页。上游换码失败（境内直连 GitHub 间歇
 * 不可用的主路径）必须映射到"引导邮箱登录"文案；state 族映射"重新发起登录"；
 * 白名单外的码一律回落通用文案——错误码永不直接渲染，映射只产出
 * 字面量 key（titleKey/descKey）与错误类别（kind → 图标/色调）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { oauthErrorCopy } from '../src/features/auth/oauth-error';

describe('oauthErrorCopy', () => {
  it('上游换码失败 → 邮箱登录引导文案（service）', () => {
    expect(oauthErrorCopy('identity.oauth_profile_failed')).toEqual({
      kind: 'service',
      titleKey: 'oauthErrorServiceTitle',
      descKey: 'oauthErrorServiceDesc',
    });
  });

  it('state 族（mismatch/invalid/unavailable）→ 重新发起登录文案（state）', () => {
    for (const code of [
      'client.oauth_state_mismatch',
      'identity.oauth_state_invalid',
      'identity.oauth_state_unavailable',
    ]) {
      expect(oauthErrorCopy(code)).toEqual({
        kind: 'state',
        titleKey: 'oauthErrorStateTitle',
        descKey: 'oauthErrorStateDesc',
      });
    }
  });

  it('账户不可用与注册关闭各映射专属文案与类别', () => {
    expect(oauthErrorCopy('client.account_unavailable')).toEqual({
      kind: 'account',
      titleKey: 'oauthErrorAccountTitle',
      descKey: 'oauthErrorAccountDesc',
    });
    expect(oauthErrorCopy('client.register_disabled')).toEqual({
      kind: 'registerClosed',
      titleKey: 'oauthErrorRegisterClosedTitle',
      descKey: 'oauthErrorRegisterClosedDesc',
    });
  });

  it('白名单外/伪造码回落通用文案（generic）', () => {
    for (const code of ['identity.oauth_provider_unconfigured', '<script>alert(1)</script>', '']) {
      expect(oauthErrorCopy(code)).toEqual({
        kind: 'generic',
        titleKey: 'oauthErrorGenericTitle',
        descKey: 'oauthErrorGenericDesc',
      });
    }
  });

  it('错误页消费的全部文案 key 在 zh/en 两语言 messages 中齐备（i18n 同步）', () => {
    // 错误卡片 + 加载卡片实际消费的 key 面；任何一侧缺 key 都会在 UI 上漏出原始 key 名
    const keys = [
      'oauthCompletingDesc',
      'oauthRetryHint',
      'oauthErrorServiceTitle',
      'oauthErrorServiceDesc',
      'oauthErrorStateTitle',
      'oauthErrorStateDesc',
      'oauthErrorAccountTitle',
      'oauthErrorAccountDesc',
      'oauthErrorRegisterClosedTitle',
      'oauthErrorRegisterClosedDesc',
      'oauthErrorGenericTitle',
      'oauthErrorGenericDesc',
    ];
    for (const locale of ['zh', 'en']) {
      const messages = JSON.parse(
        readFileSync(join(import.meta.dirname, '..', 'messages', `${locale}.json`), 'utf8'),
      ) as { auth?: Record<string, unknown> };
      const auth = messages.auth ?? {};
      for (const key of keys) {
        expect(auth[key], `${locale}.auth.${key} 缺失`).toBeTruthy();
      }
    }
  });
});
