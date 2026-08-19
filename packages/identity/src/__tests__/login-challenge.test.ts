/** 登录验证码挑战适配层：identity-core PG 挑战之上的 app 面契约——
 *  冷却/计错/一次性消费/投递失败作废/归属校验/kind 分桶，错误翻译回
 *  LoginCodeCooldownError 与 CodeVerifyError 三态（apps 的 HTTP 映射零改动）。 */
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createLoginCodeChallenger } from '../login-challenge.js';
import { CodeVerifyError, LoginCodeCooldownError } from '../errors.js';
import type { Mailer } from '../mailer.js';
import { DeliveryFailedError } from '@ai-gateway/identity-core';

const schema = process.env.IDENTITY_PKG_TEST_SCHEMA;
if (!schema) throw new Error('IDENTITY_PKG_TEST_SCHEMA missing — vitest globalSetup 未执行?');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  options: `-c search_path=${schema}`,
  max: 3,
});
afterAll(async () => {
  await pool.end();
});

/** 捕获验证码的 stub mailer（sendLoginCode 语义与生产 mailer 相同） */
function stubMailer(): Mailer & { sent: Array<{ to: string; code: string; ip: string }> } {
  const m = { sent: [] as Array<{ to: string; code: string; ip: string }> };
  return Object.assign(m, {
    sendLoginCode: async (to: string, code: string, ctx: { ip: string }) => {
      m.sent.push({ to, code, ip: ctx.ip });
    },
    send: async () => undefined,
  });
}

function failingMailer(): Mailer {
  return {
    sendLoginCode: async () => Promise.reject(new Error('SMTP down')),
    send: async () => Promise.reject(new Error('SMTP down')),
  };
}

let seq = 0;
const nextEmail = () => `login-challenge-${process.pid}-${(seq += 1)}@test.local`;

describe('createLoginCodeChallenger（PG 挑战适配层）', () => {
  it('发码 → 验码成功：subjectId 归一化、payload 原样返回、mailer 收到码与 ip', async () => {
    const mailer = stubMailer();
    const challenger = createLoginCodeChallenger(drizzle(pool), { mailer });
    const email = nextEmail();
    const challengeId = await challenger.issue('user', {
      email: email.toUpperCase(), // 大写变体 → 归一化后仍是同一目标
      purpose: 'register',
      payload: { passwordHash: 'scrypt:32768:8:1:ab:cd' },
      ip: '1.2.3.4',
    });
    expect(challengeId).toBeTruthy();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(email);
    expect(mailer.sent[0]!.code).toMatch(/^\d{6}$/);
    expect(mailer.sent[0]!.ip).toBe('1.2.3.4');

    const verified = await challenger.verify('user', {
      challengeId,
      code: mailer.sent[0]!.code,
    });
    expect(verified.subjectId).toBe(email);
    expect(verified.data?.passwordHash).toBe('scrypt:32768:8:1:ab:cd');
  });

  it('冷却：同目标立即重发 → LoginCodeCooldownError（约 60s）', async () => {
    const challenger = createLoginCodeChallenger(drizzle(pool), { mailer: stubMailer() });
    const email = nextEmail();
    await challenger.issue('user', { email, ip: '1.1.1.1' });
    await expect(challenger.issue('user', { email, ip: '1.1.1.1' })).rejects.toThrow(
      LoginCodeCooldownError,
    );
    await expect(challenger.issue('user', { email, ip: '1.1.1.1' })).rejects.toMatchObject({
      cooldownSec: expect.any(Number),
    });
  });

  it('kind 分桶：admin 与 user 的同邮箱挑战互不占冷却（双身份隔离）', async () => {
    const challenger = createLoginCodeChallenger(drizzle(pool), { mailer: stubMailer() });
    const email = nextEmail();
    await challenger.issue('admin', { email, ip: '1.1.1.1' });
    await expect(challenger.issue('user', { email, ip: '1.1.1.1' })).resolves.toBeTruthy();
  });

  it('错码计错：第 1-4 次 CODE_INVALID（剩余次数递减），第 5 次后正确码也 CHALLENGE_INVALID', async () => {
    const mailer = stubMailer();
    const challenger = createLoginCodeChallenger(drizzle(pool), { mailer });
    const challengeId = await challenger.issue('user', { email: nextEmail(), ip: '1.1.1.1' });
    for (let i = 0; i < 4; i += 1) {
      await expect(challenger.verify('user', { challengeId, code: '000000' })).rejects.toMatchObject({
        reason: 'CODE_INVALID',
      });
    }
    // 第 5 次错误 → 错满作废（EXHAUSTED 语义在 remaining=0 的那次之后）
    await expect(challenger.verify('user', { challengeId, code: '000000' })).rejects.toMatchObject({
      reason: 'CHALLENGE_EXHAUSTED',
    });
    await expect(
      challenger.verify('user', { challengeId, code: mailer.sent[0]!.code }),
    ).rejects.toMatchObject({ reason: 'CHALLENGE_INVALID' });
  });

  it('一次性消费：同码第二次验证 → CHALLENGE_INVALID（防截屏重放）', async () => {
    const mailer = stubMailer();
    const challenger = createLoginCodeChallenger(drizzle(pool), { mailer });
    const challengeId = await challenger.issue('user', { email: nextEmail(), ip: '1.1.1.1' });
    const code = mailer.sent[0]!.code;
    await expect(challenger.verify('user', { challengeId, code })).resolves.toBeTruthy();
    await expect(challenger.verify('user', { challengeId, code })).rejects.toMatchObject({
      reason: 'CHALLENGE_INVALID',
    });
  });

  it('投递失败 → DeliveryFailedError 且挑战已作废（冷却让位，可立即重发）', async () => {
    const failing = createLoginCodeChallenger(drizzle(pool), { mailer: failingMailer() });
    const email = nextEmail();
    await expect(failing.issue('user', { email, ip: '1.1.1.1' })).rejects.toThrow(
      DeliveryFailedError,
    );
    // SMTP 恢复后无需等待冷却
    const recovered = createLoginCodeChallenger(drizzle(pool), { mailer: stubMailer() });
    await expect(recovered.issue('user', { email, ip: '1.1.1.1' })).resolves.toBeTruthy();
  });

  it('归属校验：expectEmail 与挑战目标不符 → CHALLENGE_INVALID（防跨主体重放）', async () => {
    const mailer = stubMailer();
    const challenger = createLoginCodeChallenger(drizzle(pool), { mailer });
    const challengeId = await challenger.issue('user', { email: nextEmail(), ip: '1.1.1.1' });
    await expect(
      challenger.verify('user', {
        challengeId,
        code: mailer.sent[0]!.code,
        expectEmail: 'someone-else@test.local',
      }),
    ).rejects.toMatchObject({ reason: 'CHALLENGE_INVALID' });
  });

  it('abort 幂等；abort 后验码 → CHALLENGE_INVALID', async () => {
    const mailer = stubMailer();
    const challenger = createLoginCodeChallenger(drizzle(pool), { mailer });
    const challengeId = await challenger.issue('user', { email: nextEmail(), ip: '1.1.1.1' });
    await challenger.abort(challengeId);
    await challenger.abort(challengeId);
    await expect(
      challenger.verify('user', { challengeId, code: mailer.sent[0]!.code }),
    ).rejects.toBeInstanceOf(CodeVerifyError);
  });
});
