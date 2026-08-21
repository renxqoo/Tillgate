/**
 * Key 管理面语义：
 *   - PATCH status 合法枚举落库；非法 99 → 400；不存在 → 404
 *   - q 搜用户邮箱（join 列）→ 200 且计数正确（42P01 500 类防线）
 *   - 列表永不回 keyHash
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiKeys } from '@ai-gateway/db';
import {
  buildTestApp,
  db,
  newAdmin,
  newUserKeyRow,
  newUserRow,
  uid,
} from './helpers.js';

describe('Key 管理面', () => {
  it('PATCH status=1 落库；status=99 → 400；不存在 → 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const keyId = await newUserKeyRow(userId);

    const bad = await request(`/v1/admin-keys/${keyId}`, { method: 'PATCH', token, body: { status: 99 } });
    expect(bad.status).toBe(400);

    const ok = await request(`/v1/admin-keys/${keyId}`, { method: 'PATCH', token, body: { status: 1 } });
    expect(ok.status).toBe(200);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(row!.status).toBe(1);

    const missing = await request('/v1/admin-keys/999999999', { method: 'PATCH', token, body: { status: 1 } });
    expect(missing.status).toBe(404);
  });

  it('q 搜用户邮箱（join 列）→ 200 且 total 正确——不再 42P01 500', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const mail = `${uid('lqjc')}@example.com`;
    const [user] = await db
      .insert((await import('@ai-gateway/db')).users)
      .values({ issuer: 'local', subject: mail, identityProvider: 'local', email: mail })
      .returning({ id: (await import('@ai-gateway/db')).users.id });
    const { trackUser } = await import('./helpers.js');
    trackUser(user!.id);
    await newUserKeyRow(user!.id);

    const res = await request(`/v1/admin-keys?q=${encodeURIComponent(mail)}`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ userEmail: string | null }>; total: number };
    expect(body.total).toBe(1);
    expect(body.rows[0]!.userEmail).toBe(mail);
    // keyHash 不出库
    expect(JSON.stringify(body)).not.toMatch(/keyHash/);
    expect(JSON.stringify(body)).not.toMatch(/[a-f0-9]{64}/);
  });
});
