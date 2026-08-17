import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * JWT 签发/验签（jose，HS256，requirements 4.2）。
 *
 * 载荷：sub=user_id, app_id, scope, rate_card_id(费率卡绑定), exp, jti(吊销/审计), iss=ai-gateway
 * 系数按卡实时解析（model>group>global，packages/ledger coefficient.ts 单一真相）；
 * 卡停用时新请求拒绝（resolve 步 rate_card_disabled）。
 * 撤销方式：① 禁用 App（清状态缓存，已签发 JWT 立即失效）
 *           ② 单令牌紧急吊销 → jti 黑名单（Redis，TTL=剩余有效期）
 * 密钥：JWT_SECRET（HS256，≥16 chars）。
 */

const ISSUER = 'ai-gateway';
const AUDIENCE = 'ai-gateway-api';
const ALG = 'HS256';

/** JWT 载荷（验签后用于构建 AuthContext） */
export interface JwtPayload {
  sub: string; // user_id
  /** OAuth App JWT 必填；Playground 桥 JWT（typ='playground'）为 null */
  appId: number | null;
  /** 载荷变体：缺省 = OAuth App token；'playground' = 控制台操练场短期桥 */
  typ?: 'playground';
  scope?: { models?: string[]; rpm?: number; tpm?: number };
  /** 签发时账户绑定的费率卡（null=未绑卡按系数 1） */
  rateCardId: number | null;
  jti: string;
  iss: string;
  exp: number;
}

const payloadSchema = z.object({
  sub: z.string().regex(/^\d+$/),
  appId: z.number().int().positive().nullable(),
  scope: z
    .object({
      models: z.array(z.string().min(1).max(255)).max(500).optional(),
      rpm: z.number().int().positive().optional(),
      tpm: z.number().int().positive().optional(),
    })
    .optional(),
  rateCardId: z.number().int().positive().nullable(),
  jti: z.string().uuid(),
  iss: z.literal(ISSUER),
  exp: z.number().int().positive(),
});

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

export interface SignInput {
  userId: number;
  appId: number | null;
  scope?: { models?: string[]; rpm?: number; tpm?: number };
  rateCardId: number | null;
  /** 载荷变体（playground 桥用）；缺省 = OAuth App token */
  typ?: 'playground';
  /** 有效期秒（默认 7200 = 2h） */
  expiresInSeconds?: number;
}

/** 签发 JWT（企业 Agent 换 token） */
export async function signJwt(input: SignInput, jwtSecret: string): Promise<string> {
  const exp = input.expiresInSeconds ?? 7200;
  return new SignJWT({
    appId: input.appId,
    scope: input.scope,
    rateCardId: input.rateCardId,
    ...(input.typ ? { typ: input.typ } : {}),
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
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

/** 验签 JWT（鉴权服务用） */
export async function verifyJwt(token: string, jwtSecret: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey(jwtSecret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      // 算法白名单：oct 密钥默认还接受 HS384/512——签名族必须显式唯一
      algorithms: ['HS256'],
    });
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: 'invalid_token' };
    return {
      ok: true,
      payload: parsed.data,
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, error: 'token_expired' };
    }
    return { ok: false, error: 'invalid_token' };
  }
}
