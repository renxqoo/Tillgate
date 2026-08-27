/**
 * 会话令牌 jose 实现(HS256;realm 参数化——issuer/密钥/TTL 每 realm 独立装配注入)。
 * 验签三重隔离:算法白名单 + issuer 强校验 + 载荷 realm 比对
 * (user/admin 互不认账即使密钥巧合相同)。
 */
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Clock } from '../../ports/clock.js';
import type { SessionTokens } from '../../ports/session-tokens.js';
import type { SessionRealmConfig, SessionVerifyResult } from '../../domain/session.js';

// 模块级验签实现:依赖经参数注入,便于工厂函数保持单一装配职责
async function verifySessionToken(args: {
  token: string;
  realm: string;
  keyOf: (realm: string) => { secret: Uint8Array; issuer: string };
  clock: Clock;
}): Promise<SessionVerifyResult> {
  const { token, realm, keyOf, clock } = args;
  const { secret, issuer } = keyOf(realm);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret, {
      issuer,
      // 算法白名单:oct 密钥默认还接受 HS384/512——签名族必须显式唯一
      algorithms: ['HS256'],
      // 过期判定跟随注入时钟(默认真实时钟会让测试时钟失效)
      currentDate: new Date(clock.now()),
    }));
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) return { ok: false, reason: 'token_expired' };
    return { ok: false, reason: 'invalid_token' };
  }
  // 载荷 realm 必须匹配(双保险:即便 issuer 碰巧相同,realm 不符也拒绝)
  if ((payload as { realm?: string }).realm !== realm) {
    return { ok: false, reason: 'realm_mismatch' };
  }
  // 本实现签发的令牌必含五项标准声明;缺失即非本族令牌,fail-closed 拒绝
  if (
    payload.sub == null ||
    payload.jti == null ||
    payload.iss == null ||
    payload.exp == null ||
    payload.iat == null
  ) {
    return { ok: false, reason: 'invalid_token' };
  }
  return {
    ok: true,
    payload: {
      realm,
      sub: payload.sub,
      jti: payload.jti,
      iss: payload.iss,
      exp: payload.exp,
      iat: payload.iat,
      iatMs: (payload as { iatMs?: number }).iatMs,
    },
  };
}

export function createJoseSessionTokens(
  sessions: Readonly<Record<string, SessionRealmConfig>>,
  clock: Clock,
): SessionTokens {
  const encoders = new Map<string, Uint8Array>();
  const keyOf = (realm: string): { secret: Uint8Array; issuer: string } => {
    const conf = sessions[realm];
    if (conf == null) {
      // realm 白名单已在 domain/config 与用例层双重校验;此处兜底 fail-closed
      throw new Error(`session realm '${realm}' is not configured`);
    }
    let secret = encoders.get(realm);
    if (secret == null) {
      secret = new TextEncoder().encode(conf.secret);
      encoders.set(realm, secret);
    }
    return { secret, issuer: conf.issuer };
  };

  return {
    async sign(input) {
      const { secret, issuer } = keyOf(input.realm);
      const nowMs = clock.now().getTime();
      return new SignJWT({ realm: input.realm, iatMs: nowMs })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(issuer)
        .setSubject(String(input.subjectId))
        .setIssuedAt(Math.floor(nowMs / 1000))
        .setExpirationTime(Math.floor((nowMs + input.ttlSec * 1000) / 1000))
        .setJti(randomUUID())
        .sign(secret);
    },

    async verify(token, realm): Promise<SessionVerifyResult> {
      return verifySessionToken({ token, realm, keyOf, clock });
    },
  };
}
