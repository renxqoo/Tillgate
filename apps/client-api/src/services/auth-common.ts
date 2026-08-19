import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { FlowError, recordAudit } from '@ai-gateway/http';
import { signSession } from '@ai-gateway/identity';
import { users } from '@ai-gateway/db/schema';
import type { ClientServices } from './index.js';
import type { ClientApiConfig } from '../config.js';

/**
 * 登录/注册流程共用工具：审计收口（audited）与会话签发（issueSession）。
 * 流程本体见 auth-login.ts / auth-register.ts。
 */

/** 验证第二步通过后的会话签发结果（登录/注册共用形状） */
export type VerifySuccess = {
  kind: 'success';
  token: string;
  userId: number;
  email: string;
  gifted: boolean;
};

/** 流程审计规格：动作前缀 + 按需的 detail/targetId 提取（默认 detail {}、targetId null） */
export interface FlowAudit<O extends { kind: string }> {
  action: string;
  detail?: (kind: string) => Record<string, unknown>;
  targetId?: (o: O) => number | null;
}

/**
 * 流程收口：成功记审计（动作名 auth.<flow>.<kind>）后返回；有意失败
 * （FlowError）记审计后原样上抛。基础设施异常不落业务审计，直接上抛 500。
 */
export async function audited<O extends { kind: string }>(
  s: ClientServices,
  spec: FlowAudit<O>,
  flow: () => Promise<O>,
): Promise<O> {
  const record = (kind: string, o?: O) =>
    void recordAudit(s.db, {
      actor: 'user',
      action: `${spec.action}.${kind}`,
      targetType: 'user',
      targetId: o === undefined ? null : spec.targetId?.(o) ?? null,
      detail: spec.detail?.(kind) ?? {},
    });
  try {
    const outcome = await flow();
    record(outcome.kind, outcome);
    return outcome;
  } catch (e) {
    if (e instanceof FlowError) record(e.kind);
    throw e;
  }
}

/** 新用户默认显示名：rx + 6 位随机（去易混字符）；用户可随时自助修改 */
export function defaultDisplayName(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(6);
  return 'rx' + [...bytes].map((b) => alphabet[b % alphabet.length]!).join('');
}

/** 验证通过后的会话签发（登录/注册/OAuth 共用）：赠额（幂等）+ lastLogin + JWT */
export async function issueSession(
  s: ClientServices,
  config: ClientApiConfig,
  userId: number,
): Promise<{ token: string; gifted: boolean }> {
  let gifted = false;
  if (config.giftAmount > 0) {
    const result = await s.promotions.grantSignupGift({
      operationId: `signup-gift:${userId}`,
      userId,
      amount: String(config.giftAmount),
    });
    gifted = result.granted && !result.replayed;
  }
  await s.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  const token = await signSession({ type: 'user', id: userId }, config.jwtSecret);
  return { token, gifted };
}
