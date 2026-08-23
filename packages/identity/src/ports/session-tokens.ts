/**
 * 会话令牌机制 port(HS256 签发/验签;契约见 domain/session.ts)。
 * 实现见 adapters/jwt/jose-tokens.ts;测试替身注入同接口。
 */
import type { SessionVerifyResult } from '../domain/session.js';

export interface SessionTokens {
  sign(input: { realm: string; subjectId: number; ttlSec: number }): Promise<string>;
  verify(token: string, realm: string): Promise<SessionVerifyResult>;
}
