/**
 * control-plane 错误目录（AGENT.md §11：能力包自有目录，码带命名空间）。
 * 身份码 = `control_plane.<key>`；message 英文、zh 中文，face 按码双语渲染（铁律 18）。
 * 码表封闭性由 __test__/boundary.test.ts 快照锁死；新增码 = 契约变更，须同步 DESIGN §2.3。
 */
import { defineErrorCatalog } from '@tokenlens/errors';

export const controlPlaneErrors = defineErrorCatalog('control_plane', {
  // ── providers ────────────────────────────────────────────────────────────
  invalid_provider_input: {
    category: 'invalid_input',
    message: 'Invalid provider input',
    zh: '供应商参数不合法（名称长度 1-32、baseUrl 须为 http(s) URL、status ∈ {0,1}）',
  },
  invalid_protocol: {
    category: 'invalid_input',
    message: 'Unsupported protocol',
    zh: '协议不在可执行词表内（词表单一真相 = ai 适配器注册表，经装配注入）',
  },
  invalid_vendor: {
    category: 'invalid_input',
    message: 'Unknown vendor profile',
    zh: '厂商档案不在词表内（词表单一真相 = ai VENDOR_PROFILES，经装配注入）',
  },
  provider_not_found: { category: 'not_found', message: 'Provider not found', zh: '供应商不存在' },
  provider_exists: {
    category: 'conflict',
    message: 'Provider name already exists',
    zh: '供应商重名',
  },

  // ── channels ─────────────────────────────────────────────────────────────
  invalid_channel_input: {
    category: 'invalid_input',
    message: 'Invalid channel input',
    zh: '渠道参数不合法（名称/密钥/覆盖地址/限流域）',
  },
  channel_not_found: { category: 'not_found', message: 'Channel not found', zh: '渠道不存在' },
  channel_exists: { category: 'conflict', message: 'Channel name already exists', zh: '渠道重名' },
  import_empty: {
    category: 'invalid_input',
    message: 'Import list cannot be empty',
    zh: '导入清单不能为空',
  },
  import_limit_exceeded: {
    category: 'invalid_input',
    message: 'Import batch exceeds the per-batch limit',
    zh: '单批导入条数超上限',
  },
  insufficient_budget: {
    category: 'quota_exhausted',
    message: 'Adjustment would drive the purchase quota negative',
    zh: '调账金额超出当前进货额度，无法扣减',
  },
  operation_conflict: {
    category: 'conflict',
    message: 'Operation id reused with different parameters',
    zh: '幂等键被不同参数复用',
  },
  invalid_operation_id: {
    category: 'invalid_input',
    message: 'Operation id is malformed',
    zh: '幂等键形状非法',
  },
  invalid_voucher: {
    category: 'invalid_input',
    message: 'Voucher must be a base64 data URL of image/png|jpeg|webp|gif',
    zh: '凭证须为 image/png|jpeg|webp|gif 的 base64 data URL',
  },
  voucher_too_large: {
    category: 'invalid_input',
    message: 'Voucher image exceeds the size limit',
    zh: '凭证图片超过大小上限',
  },

  // ── models ───────────────────────────────────────────────────────────────
  invalid_model_input: {
    category: 'invalid_input',
    message: 'Invalid model mapping input',
    zh: '模型映射参数不合法（价格数值域/计价单位词表/变体配置形状/上下文长度）',
  },
  model_not_found: { category: 'not_found', message: 'Model not found', zh: '模型不存在' },
  model_exists: {
    category: 'conflict',
    message: 'Model mapping already exists',
    zh: '对外模型名已存在（用编辑而非重复创建）',
  },
  free_price_conflict: {
    category: 'invalid_input',
    message: 'Explicitly free model requires all-zero pricing',
    zh: '显式免费模型必须全零价（token 三价 + 缓存写价 + 单位价）',
  },

  // ── rate cards ───────────────────────────────────────────────────────────
  invalid_coefficient: {
    category: 'invalid_input',
    message: 'Coefficient must be a decimal string in (0, 9.999] with at most 3 decimals',
    zh: '系数须为 0.001–9.999 的十进制字符串且最多 3 位小数',
  },
  rate_card_not_found: {
    category: 'not_found',
    message: 'Rate card not found',
    zh: '费率卡不存在',
  },
  rate_card_in_use: {
    category: 'conflict',
    message: 'Rate card still has bound users',
    zh: '费率卡仍有绑定用户，不能删除',
  },

  // ── fx ───────────────────────────────────────────────────────────────────
  invalid_fx_rate: {
    category: 'invalid_input',
    message: 'Exchange rate out of range',
    zh: '汇率越界（0.01–1000）',
  },
  invalid_fx_buffer: {
    category: 'invalid_input',
    message: 'Buffer out of range',
    zh: '点差越界（0–50%）',
  },
  fx_fetch_failed: {
    category: 'unavailable',
    message: 'Exchange rate source failed',
    zh: '汇率源拉取失败',
  },

  // ── catalog ──────────────────────────────────────────────────────────────
  catalog_source_not_found: {
    category: 'not_found',
    message: 'Unknown catalog source',
    zh: '未知目录源',
  },
  catalog_source_unreachable: {
    category: 'unavailable',
    message: 'Failed to fetch catalog source',
    zh: '目录源拉取失败',
  },
  catalog_empty: {
    category: 'invalid_input',
    message: 'At least one model must be selected',
    zh: '至少选择一个模型',
  },
  catalog_api_key_required: {
    category: 'invalid_input',
    message: 'First import from this source requires the platform API key',
    zh: '该源首次导入需要平台 API Key（用于创建渠道）',
  },
  external_name_conflict: {
    category: 'conflict',
    message: 'External name already bound to another real model',
    zh: '对外模型名已被其他真实模型占用',
  },
});

/** control-plane 错误目录身份码类型（码表封闭性的类型面） */
export type ControlPlaneErrorCode = (typeof controlPlaneErrors.codes)[number];
