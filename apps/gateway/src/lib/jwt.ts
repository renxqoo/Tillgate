import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { randomUUID } from 'node:crypto';

/**
 * JWT 签发/验签（jose，HS256，requirements 4.2）。
 *
 * 载荷：sub=user_id, app_id, scope, coefficient(费率卡快照), exp, jti(吊销/审计), iss=ai-gateway
 * 撤销方式：① 禁用 App（清状态缓存，已签发 JWT 立即失效）
 *           ② 单令牌紧急吊销 → jti 黑名单（Redis，TTL=剩余有效期）— 最小闭环暂不做
 * 密钥：env.JWT_SECRET（HS256，≥16 chars）。
 */

const ISSUER = 'ai-gateway';
const ALG = 'HS256';

/** JWT 载荷（验签后用于构建 AuthContext） */
export interface JwtPayload {
  sub: string; // user_id
  appId: number;
  scope?: { models?: string[]; rpm?: number; tpm?: number };
  coefficient: number; // 费率卡系数快照（如 1.0）
  jti: string;
  iss: string;
  exp: number;
}

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

export interface SignInput {
  userId: number;
  appId: number;
  scope?: { models?: string[]; rpm?: number; tpm?: number };
  coefficient: number;
  /** 有效期秒（默认 7200 = 2h） */
  expiresInSeconds?: number;
}

/** 签发 JWT（企业 Agent 换 token） */
export async function signJwt(input: SignInput, jwtSecret: string): Promise<string> {
  const exp = input.expiresInSeconds ?? 7200;
  return new SignJWT({
    appId: input.appId,
    scope: input.scope,
    coefficient: input.coefficient,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(String(input.userId))
    .setIssuedAt()
    .setExpirationTime(`${exp}s`)
    .setJti(randomUUID())
    .sign(secretKey(jwtSecret));
}

/** 验签结果 */
export interface VerifyResult {
  ok: boolean;
  payload?: JwtPayload;
  /** ok=false 时的错误码 */
  error?: 'token_expired' | 'invalid_token';
}

/** 验签 JWT（鉴权中间件用） */
export async function verifyJwt(token: string, jwtSecret: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey(jwtSecret), {
      issuer: ISSUER,
    });
    return {
      ok: true,
      payload: {
        sub: payload.sub!,
        appId: payload.appId as number,
        scope: payload.scope as JwtPayload['scope'],
        coefficient: payload.coefficient as number,
        jti: payload.jti!,
        iss: payload.iss!,
        exp: payload.exp!,
      },
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, error: 'token_expired' };
    }
    return { ok: false, error: 'invalid_token' };
  }
}
