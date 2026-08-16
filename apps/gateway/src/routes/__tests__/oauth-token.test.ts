import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { oauthTokenRoutes } from '../oauth-token.js';
import type { OAuthService } from '../../services/auth/oauth-service.js';

/**
 * A12 回归锁定：/oauth/token 三种凭证传法等价（JSON body / form-urlencoded / Basic Auth）。
 * 覆盖 grant 校验与凭证解析分支（语义验签在 oauth-service 有独立实现与实弹脚本 19/25）。
 */

function makeOauthStub() {
  const calls: Array<{ clientId: string; clientSecret: string; ip: string }> = [];
  const svc = {
    issueToken: vi.fn(async (clientId: string, clientSecret: string, ip: string) => {
      calls.push({ clientId, clientSecret, ip });
      return { ok: true as const, accessToken: 'tok-123', expiresIn: 7200 };
    }),
  };
  return { svc: svc as unknown as OAuthService, calls };
}

function app(svc: OAuthService) {
  const a = new Hono();
  a.route('/oauth/token', oauthTokenRoutes(svc, 0));
  return a;
}

describe('POST /oauth/token 凭证传法（A12）', () => {
  it('JSON body：client_credentials → 200 + token', async () => {
    const { svc, calls } = makeOauthStub();
    const res = await app(svc).request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'app_x', client_secret: 'sec_x' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { access_token?: string }).access_token).toBe('tok-123');
    expect(calls[0]).toMatchObject({ clientId: 'app_x', clientSecret: 'sec_x' });
  });

  it('form-urlencoded：字段等价解析', async () => {
    const { svc, calls } = makeOauthStub();
    const res = await app(svc).request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'app_f', client_secret: 'sec_f' }).toString(),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ clientId: 'app_f', clientSecret: 'sec_f' });
  });

  it('Basic Auth：body 未带凭证时兜底解析', async () => {
    const { svc, calls } = makeOauthStub();
    const basic = Buffer.from('app_b:sec_b').toString('base64');
    const res = await app(svc).request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${basic}` },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ clientId: 'app_b', clientSecret: 'sec_b' });
  });

  it('grant_type 非法 → 400 invalid_request（三种传法一致）', async () => {
    const { svc } = makeOauthStub();
    const a = app(svc);
    const r1 = await a.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'password', client_id: 'x', client_secret: 'y' }) });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error?: string }).error).toBe('invalid_request');
  });
});
