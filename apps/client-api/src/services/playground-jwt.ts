import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';

/**
 * Playground 网关 JWT 桥（C2）：
 * client-api 替登录用户现签 5 分钟短期 gateway JWT（iss/aud 与网关自签一致），
 * 每请求一枚、独立低限额（RPM 10 / TPM 200k），计费走正常管线（用户余额）。
 * 密钥：GATEWAY_JWT_SECRET（与网关 JWT_SECRET 同值，部署约定）。
 */

const ISSUER = 'ai-gateway';
const AUDIENCE = 'ai-gateway-api';
export const PLAYGROUND_TTL_S = 300;
export const PLAYGROUND_RPM = 10;
export const PLAYGROUND_TPM = 200_000;

export async function signPlaygroundJwt(
  userId: number,
  jwtSecret: string,
  rateCardId: number | null,
): Promise<string> {
  return new SignJWT({
    // 网关载荷契约（apps/gateway jwt.ts）：typ 变体 playground——无 App 绑定
    typ: 'playground',
    appId: null,
    scope: { rpm: PLAYGROUND_RPM, tpm: PLAYGROUND_TPM },
    rateCardId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${PLAYGROUND_TTL_S}s`)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(jwtSecret));
}
