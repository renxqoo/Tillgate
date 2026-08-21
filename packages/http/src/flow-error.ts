import { HttpError } from './errors.js';
import type { KnownErrorCode } from './error-codes.js';

/** 失败分支的 HTTP 语义（状态码/默认文案由注册表从 code 推导） */
export interface HttpFailSpec {
  code: KnownErrorCode;
  message?: string;
  headers?: Record<string, string>;
}

/**
 * 应用本地流程错误（有意失败）：领域 kind 供审计消费（auth.<flow>.<kind>），
 * HTTP 语义由 HttpError 基类携带，直达 errorHandler 统一成响应。
 *
 * 使用约定：仅限单协议脸的应用本地 service（admin-api / client-api）在判定处
 * 直接 throw；共享领域包（ledger/ai）不入此模式——同一领域错误要在网关/管理/
 * 用户面渲染成不同协议，翻译留在各自边界。
 */
export class FlowError extends HttpError {
  constructor(
    /** 领域失败分支（如 'captcha_required'），保留机器词汇供审计等非 HTTP 消费方 */
    readonly kind: string,
    spec: HttpFailSpec,
  ) {
    super(spec.code, spec.message, undefined, spec.headers);
  }
}
