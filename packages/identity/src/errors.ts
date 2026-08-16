/**
 * identity 领域错误家谱（与 ledger 的 LedgerError 同模式）。
 *
 * 约定：
 *   - 失败以抛类表达（调用方 instanceof 分支/上冒），不再返回 ok/reason 联合
 *   - 类 + reason 字段而非逐 reason 子类：消费方的真实分支是「单reason单独处理、
 *     其余合并」（如验码把 EXHAUSTED 并入 CHALLENGE_INVALID），字段合并是一行
 *     !==，子类合并是一串 instanceof；且 identity 失败载荷只有 reason 一个词
 *   - IdentityError 不得裸冒到 HTTP——消费方在边界 catch 后翻译成
 *     FlowError/HttpError（errorHandler 不认识领域错误，冒出即 500）
 */

/** identity 领域错误基类 */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 同一主体冷却期内重复签发（边界映射 429 CODE_RATE_LIMITED + retry-after） */
export class LoginCodeCooldownError extends IdentityError {
  constructor(readonly cooldownSec: number) {
    super(`验证码发送过于频繁，请 ${cooldownSec} 秒后再试`);
  }
}

/** 验码失败：票据无效/错码/错满作废（EXHAUSTED 后正确码也无效） */
export class CodeVerifyError extends IdentityError {
  constructor(
    readonly reason: 'CHALLENGE_INVALID' | 'CHALLENGE_EXHAUSTED' | 'CODE_INVALID',
  ) {
    super(`登录验证码校验失败：${reason}`);
  }
}

/**
 * 人机验证失败：
 *   - invalid     → 票据缺失/伪造/过期/重放：客户端过错，可换新票重试（400）
 *   - unavailable → 厂商 API 不可达/我方配置过错：fail-closed 绝不放行（503），
 *                   防「打瘫厂商即可免验证」的旁路
 */
export class CaptchaError extends IdentityError {
  constructor(readonly reason: 'invalid' | 'unavailable') {
    super(`人机验证未通过：${reason}`);
  }
}

/** 会话 JWT 验签失败：过期或无效（中间件统一 401，不区分对外的错误文案） */
export class SessionVerifyError extends IdentityError {
  constructor(readonly reason: 'invalid_token' | 'token_expired') {
    super(`会话令牌验签失败：${reason}`);
  }
}
