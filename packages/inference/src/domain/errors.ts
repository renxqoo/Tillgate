import { defineErrorCatalog } from '@tokenlens/errors';

/**
 * inference 错误目录（§11 根契约；message 英文、zh 必填，动态事实进 context）。
 * HTTP status 映射归 app face 按 category/码渲染——v1 的 502/503 区分由
 * no_available_channel（渠道面竭尽）与 upstream_failed（上游故障）双码保留。
 */
export const InferenceErrors = defineErrorCatalog('inference', {
  /** 目录无此模型（或候选链为空）——v1 404 model_not_found */
  model_not_found: {
    category: 'not_found',
    message: 'Model not found or deprecated',
    zh: '模型不存在或已下线',
  },
  /** 凭证模型白名单拒绝（App-JWT scope）——v1 403 model_not_allowed */
  model_not_allowed: {
    category: 'forbidden',
    message: 'Model is not allowed for this credential',
    zh: '当前凭证无权使用该模型',
  },
  /** 渠道面竭尽：无渠道/预算耗尽/限流——v1 503 no_available_channel */
  no_available_channel: {
    category: 'unavailable',
    message: 'No channel available for this model, please retry later',
    zh: '该模型暂无可用渠道，请稍后重试',
  },
  /** 上游故障全败（非渠道面）——v1 502 upstream_failed */
  upstream_failed: {
    category: 'unavailable',
    message: 'Upstream request failed',
    zh: '上游请求失败',
  },
  /** 非流式结算重试耗尽：未交付不结算，宁可让用户重试——v1 503 finalize_unavailable */
  finalize_unavailable: {
    category: 'unavailable',
    message: 'Request completed but settlement is temporarily unavailable, please retry',
    zh: '请求已完成但结算暂不可用，请重试',
  },
  /** 生成任务已受理但收据持久化失败：预留保留交 recover 兜底——v1 503 billing_receipt_unavailable */
  billing_receipt_unavailable: {
    category: 'unavailable',
    message: 'Generation task accepted but receipt persistence is temporarily unavailable',
    zh: '生成任务已受理但收据暂不可用',
  },
  /** 生成任务不存在或非属主——v1 404 */
  task_not_found: {
    category: 'not_found',
    message: 'Generation task not found',
    zh: '生成任务不存在',
  },
});
