/**
 * http 自有错误目录（http.* 命名空间）——本包机制件的唯一抛出口（ADR-0001 D1、DESIGN §3）。
 * 只登记有机制抛点的边界码（铁律 4：无抛点不登记）；业务码归能力包目录，
 * 由 app face 装配期合成全量目录（composeErrorCatalogs）。
 */
import { defineErrorCatalog } from '@tokenlens/errors';

export const HttpErrors = defineErrorCatalog('http', {
  // ── 请求校验 / 协议边界（invalid_input 族）──
  validation_failed: {
    category: 'invalid_input',
    message: 'Invalid request parameters',
    zh: '请求参数无效',
  },
  invalid_json: {
    category: 'invalid_input',
    message: 'Request body is not valid JSON',
    zh: '请求体不是有效的 JSON',
  },
  invalid_request: { category: 'invalid_input', message: 'Invalid request', zh: '无效请求' },
  invalid_path_param: {
    category: 'invalid_input',
    message: 'Invalid path parameter',
    zh: '路径参数无效',
  },
  invalid_idempotency_key: {
    category: 'invalid_input',
    message: 'idempotency-key must be 1-64 characters of letters, digits, underscores or hyphens',
    zh: 'idempotency-key 必须为 1-64 位的字母、数字、下划线或连字符',
  },
  /** 请求体超限（413）：payload 性质是 invalid_input，出站 status 经修正表升为 413 */
  payload_too_large: {
    category: 'invalid_input',
    message: 'Request body too large',
    zh: '请求体过大',
  },
  /** Content-Type 不在端点支持集（415）：出站 status 经修正表升为 415 */
  unsupported_media_type: {
    category: 'invalid_input',
    message: 'Unsupported Content-Type for this endpoint',
    zh: '该端点不支持此 Content-Type',
  },

  // ── 协议边界鉴权 ──
  /** Bearer 凭证缺失或不匹配（401）：category 走 forbidden，出站 status 经修正表升 401 */
  unauthorized: {
    category: 'forbidden',
    message: 'Missing or invalid bearer credentials',
    zh: '缺少或无效的 Bearer 凭证',
  },

  // ── 路由边界 ──
  not_found: { category: 'not_found', message: 'Path not found', zh: '路径不存在' },

  // ── PG SQLSTATE 边界翻译族（ADR-0002：翻译表归 http，探测函数由 db 注入）──
  pg_unique_violation: {
    category: 'conflict',
    message: 'Record already exists (unique constraint conflict)',
    zh: '记录已存在（唯一约束冲突）',
  },
  pg_fk_violation: {
    category: 'invalid_input',
    message: 'Referenced resource not found',
    zh: '引用的资源不存在',
  },
  pg_check_violation: {
    category: 'invalid_input',
    message: 'Operation violates data constraint',
    zh: '操作违反数据约束',
  },
  pg_value_too_long: {
    category: 'invalid_input',
    message: 'Field value exceeds length limit',
    zh: '字段值超出长度限制',
  },
  pg_invalid_text: {
    category: 'invalid_input',
    message: 'Invalid field value format',
    zh: '字段值格式无效',
  },
  pg_numeric_out_of_range: {
    category: 'invalid_input',
    message: 'Field value out of range',
    zh: '字段值超出范围',
  },
});

/** 出站通用文案（infrastructure/defect 的内外分际：内部诊断不外泄，按 locale 取通用文案） */
export const GENERIC_UNAVAILABLE_MESSAGE = Object.freeze({
  en: 'Service temporarily unavailable',
  zh: '服务暂时不可用',
});
export const GENERIC_INTERNAL_MESSAGE = Object.freeze({
  en: 'Internal server error',
  zh: '服务器内部错误',
});
