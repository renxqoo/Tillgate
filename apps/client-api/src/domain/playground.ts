/**
 * 操练场网关 JWT 桥（v1 同款语义）：
 * client-api 替登录用户现签 5 分钟短期网关 JWT（typ playground——独立低限额），
 * 每请求一枚、计费走正常管线（用户余额）。密钥与网关 JWT_SECRET 同值（部署约定）。
 */
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

const ISSUER = 'ai-gateway';
const AUDIENCE = 'ai-gateway-api';
export const PLAYGROUND_TTL_S = 300;
export const PLAYGROUND_RPM = 10;
export const PLAYGROUND_TPM = 200_000;

export async function signPlaygroundJwt(
  userId: number,
  gatewayJwtSecret: string,
): Promise<string> {
  return new SignJWT({
    typ: 'playground',
    appId: null,
    scope: { rpm: PLAYGROUND_RPM, tpm: PLAYGROUND_TPM },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${PLAYGROUND_TTL_S}s`)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(gatewayJwtSecret));
}

/** 测试辅助：验证签名与载荷（不查库） */
export async function verifyPlaygroundJwt(
  token: string,
  gatewayJwtSecret: string,
): Promise<{ sub: string; typ: string } | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(gatewayJwtSecret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return { sub: String(payload.sub ?? ''), typ: String(payload.typ ?? '') };
  } catch {
    return null;
  }
}
