import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { HttpError, errorHandler, errorResponseBody } from '../errors.js';
import { localizeMessage, localizedSpecMessage } from '../error-codes.js';
import { parseAcceptLanguage } from '../locale.js';

/**
 * 错误出口双语协商：Accept-Language → en|zh（默认英文）。
 * 原则：英文行为零变化；zh 仅替换与注册表默认逐字一致的静态文案。
 */

describe('parseAcceptLanguage', () => {
  it.each([
    ['zh-CN,zh;q=0.9,en;q=0.8', 'zh'],
    ['en-US,en;q=0.9', 'en'],
    ['zh-TW,zh;q=0.9', 'zh'],
    ['fr-FR,fr;q=0.9,en;q=0.5', 'en'],
    ['en;q=0.3,zh-CN;q=0.9', 'zh'],
    ['', 'en'],
    [undefined, 'en'],
  ])('%s → %s', (header, expected) => {
    expect(parseAcceptLanguage(header)).toBe(expected);
  });
});

describe('localizeMessage', () => {
  it('注册表默认文案：zh 取 zh、en 取 message', () => {
    expect(localizeMessage('USER_NOT_FOUND', 'zh', 'User not found')).toBe('用户不存在');
    expect(localizeMessage('USER_NOT_FOUND', 'en', 'User not found')).toBe('User not found');
  });

  it('码大小写不敏感（wire code 小写 → 注册键大写）', () => {
    expect(localizeMessage('voucher_not_found', 'zh', 'Voucher not found')).toBe('凭证不存在');
  });

  it('调用点自定义/动态文案不翻译（防细节丢失），未登记码原样返回', () => {
    expect(localizeMessage('code_rate_limited', 'zh', 'Verification code sent too frequently, retry in 1 minute')).toBe(
      'Verification code sent too frequently, retry in 1 minute',
    );
    expect(localizeMessage('some_unregistered', 'zh', 'Custom text')).toBe('Custom text');
  });
});

describe('errorResponseBody 协商', () => {
  it('locale=zh：注册表默认出中文；覆盖文案保持调用方原文', () => {
    expect(errorResponseBody(new HttpError('USER_NOT_FOUND'), 'zh').error.message).toBe('用户不存在');
    expect(errorResponseBody(new HttpError('USER_NOT_FOUND', 'User 42 not found'), 'zh').error.message).toBe(
      'User 42 not found',
    );
  });

  it('未传 locale：英文默认（与历史行为一致）', () => {
    expect(errorResponseBody(new HttpError('USER_NOT_FOUND')).error.message).toBe('User not found');
  });
});

describe('errorHandler 协商（端到端）', () => {
  it('Accept-Language: zh → 注册表默认中文；无头 → 英文', async () => {
    const app = new Hono();
    app.onError(errorHandler());
    app.get('/boom', () => {
      throw new HttpError('ORG_FORBIDDEN');
    });
    const zh = await app.request('/boom', { headers: { 'accept-language': 'zh-CN' } });
    expect(await zh.json()).toEqual({ error: { message: '无权访问该组织资源', code: 'ORG_FORBIDDEN' } });
    const en = await app.request('/boom');
    expect(await en.json()).toEqual({ error: { message: 'No permission to access this organization resource', code: 'ORG_FORBIDDEN' } });
  });

  it('localizedSpecMessage：强制按码取词（未登记回落 fallback）', () => {
    expect(localizedSpecMessage('not_found', 'zh', 'x')).toBe('路径不存在');
    expect(localizedSpecMessage('not_found', 'en', 'x')).toBe('Path not found');
    expect(localizedSpecMessage('nope', 'zh', 'fallback')).toBe('fallback');
  });
});
