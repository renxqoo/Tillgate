import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { randomUUID } from 'node:crypto';

/**
 * 控制台会话 JWT（api-contract §5：面板 JWT，HttpOnly Cookie，24h）。
 *
 * 载荷：sub=user_id, role(0普通/1管理员), exp(默认24h), iat, jti, iss=ai-gateway-console。
 * 与 gateway 的企业 Agent JWT 同用 jose 库 + 同一 JWT_SECRET 密钥源，但载荷结构不同（这里无 app_id/scope/coefficient），
 * 两类 token 用途隔离（控制台走 Cookie，Agent 走 Bearer），不互相验签。
 *
 * 撤销：一期靠用户表 status 字段（封禁/注销）+ 中间件每次查库校验；P1 加 jti 黑名单做单会话强制下线。
 */

const ISSUER = 'ai-gateway-console';
const ALG = 'HS256';
/** 默认有效期 24h（api-contract §5） */
export const SESSION_DEFAULT_TTL_S = 24 * 60 * 60;

export interface SessionPayload {
  sub: string; // user_id（字符串化）
  role: number; // 0 普通用户 / 1 管理员
  jti: string;
  iss: string;
  exp: number;
  iat: number;
}

export interface SessionSignInput {
  userId: number;
  role: number;
  expiresInSeconds?: number;
}

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

/** 签发控制台会话 JWT */
export async function signSession(input: SessionSignInput, jwtSecret: string): Promise<string> {
  const ttl = input.expiresInSeconds ?? SESSION_DEFAULT_TTL_S;
  return new SignJWT({ role: input.role })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(String(input.userId))
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(randomUUID())
    .sign(secretKey(jwtSecret));
}

export interface SessionVerifyResult {
  ok: boolean;
  payload?: SessionPayload;
  error?: 'token_expired' | 'invalid_token';
}

/** 验签控制台会话 JWT */
export async function verifySession(token: string, jwtSecret: string): Promise<SessionVerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey(jwtSecret), { issuer: ISSUER });
    return {
      ok: true,
      payload: {
        sub: payload.sub!,
        role: payload.role as number,
        jti: payload.jti!,
        iss: payload.iss!,
        exp: payload.exp!,
        iat: payload.iat!,
      },
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return { ok: false, error: 'token_expired' };
    return { ok: false, error: 'invalid_token' };
  }
}

/** Cookie 名（api-contract 隐含的 HttpOnly Cookie 容器） */
export const SESSION_COOKIE = 'ag_session';
