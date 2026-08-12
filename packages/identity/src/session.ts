import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { randomUUID } from 'node:crypto';

/**
 * 会话 JWT（双身份物理隔离）。
 *
 * 两种身份各自独立的 token，靠 `type` 载荷字段 + `iss` issuer 区分：
 *   - 用户面（client-api）：type='user', iss='ai-gateway-console', 密钥 JWT_SECRET, Cookie ag_session
 *   - 管理面（admin-api） ：type='admin', iss='ai-gateway-admin',  密钥 ADMIN_JWT_SECRET, Cookie ag_admin_session
 *
 * 验签时强制校验 issuer，两类 token 互不认账（即使密钥泄露巧合相同，issuer 不同也拒绝）。
 * 这是从「一个 users.role bug 波及管理员」根上隔离的核心机制。
 *
 * 与 gateway 的企业 Agent JWT（Bearer，载荷含 app_id/scope）完全不同，用途隔离，不互相验签。
 *
 * 撤销：一期靠 users/admins 表 status 字段（封禁/注销）+ 中间件每次查库校验；
 *      P1 加 jti 黑名单做单会话强制下线。
 */

const USER_ISSUER = 'ai-gateway-console';
const ADMIN_ISSUER = 'ai-gateway-admin';
const ALG = 'HS256';

/** 默认有效期 24h */
export const SESSION_DEFAULT_TTL_S = 24 * 60 * 60;

/** 身份类型：决定载荷语义 + issuer + 校验目标表 */
export type SessionType = 'user' | 'admin';

export interface SessionPayload {
  /** 身份类型（验签后据此回查 users 或 admins 表） */
  type: SessionType;
  /** subject：user_id 或 admin_id（字符串化） */
  sub: string;
  jti: string;
  iss: string;
  exp: number;
  iat: number;
}

export interface SessionSignInput {
  type: SessionType;
  /** user_id（用户面）或 admin_id（管理面） */
  id: number;
  expiresInSeconds?: number;
}

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

function issuerFor(type: SessionType): string {
  return type === 'admin' ? ADMIN_ISSUER : USER_ISSUER;
}

/**
 * 签发会话 JWT。
 *
 *   - 用户面：signSession({ type:'user', id: userId }, jwtSecret)
 *   - 管理面：signSession({ type:'admin', id: adminId }, adminJwtSecret)
 *
 * 密钥由调用方注入（client-api 用 JWT_SECRET，admin-api 用 ADMIN_JWT_SECRET）。
 */
export function signSession(input: SessionSignInput, jwtSecret: string): Promise<string> {
  const ttl = input.expiresInSeconds ?? SESSION_DEFAULT_TTL_S;
  const issuer = issuerFor(input.type);
  return new SignJWT({ type: input.type })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(issuer)
    .setSubject(String(input.id))
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

/**
 * 验签会话 JWT（指定身份类型 + 密钥）。
 *
 * 调用方按身份传入对应密钥与期望类型，issuer 由类型决定并强制校验。
 * 这样用户面密钥签出的 token 无法在管理面验签通过（反之亦然），实现密钥隔离。
 */
export async function verifySession(
  token: string,
  jwtSecret: string,
  expectedType: SessionType,
): Promise<SessionVerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey(jwtSecret), {
      issuer: issuerFor(expectedType),
    });
    // 载荷 type 必须匹配（双保险：即便 issuer 碰巧相同，type 不符也拒绝）
    if ((payload as { type?: string }).type !== expectedType) {
      return { ok: false, error: 'invalid_token' };
    }
    return {
      ok: true,
      payload: {
        type: expectedType,
        sub: payload.sub!,
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
