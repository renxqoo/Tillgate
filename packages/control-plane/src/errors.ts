/**
 * control-plane 错误目录（能力包自有目录，码带命名空间）。
 * 身份码 = `control_plane.<key>`；message 英文、zh 中文，face 按码双语渲染。
 * 码表封闭性由 __test__/boundary.test.ts 快照锁死；新增码 = 契约变更。
 */
import { defineErrorCatalog } from '@tillgate/errors';

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
  /** 删除守卫：供应商名下仍有在册渠道（须先删除/迁移渠道，回收站渠道不阻塞） */
  provider_has_channels: {
    category: 'conflict',
    message: 'Provider still has active channels',
    zh: '供应商名下仍有在册渠道，须先删除或迁移渠道',
  },

  // ── channels ─────────────────────────────────────────────────────────────
  invalid_channel_input: {
    category: 'invalid_input',
    message: 'Invalid channel input',
    zh: '渠道参数不合法（名称/密钥/覆盖地址/限流域）',
  },
  channel_not_found: { category: 'not_found', message: 'Channel not found', zh: '渠道不存在' },
  channel_exists: { category: 'conflict', message: 'Channel name already exists', zh: '渠道重名' },
  /** 删除守卫：仍有在册模型映射绑定该渠道（须先解绑/删除映射，回收站映射不阻塞） */
  channel_has_models: {
    category: 'conflict',
    message: 'Channel still has bound model mappings',
    zh: '仍有在册模型映射绑定该渠道，须先解绑或删除映射',
  },
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

  // ── settings ─────────────────────────────────────────────────────────────
  invalid_billing_timezone: {
    category: 'invalid_input',
    message: 'Billing timezone must be a valid IANA timezone name',
    zh: '计费时区必须是合法的 IANA 时区名',
  },
  invalid_debit_floor: {
    category: 'invalid_input',
    message: 'Debit floor default must be a non-negative decimal amount',
    zh: '透支地板默认必须为非负十进制金额',
  },
  invalid_reservation_policy: {
    category: 'invalid_input',
    message: 'Reservation policy must be full or fixed with a positive amount',
    zh: '预扣策略必须为 full，或 fixed 且金额为正数',
  },
  invalid_reservation_limit: {
    category: 'invalid_input',
    message: 'Reservation limit must be a positive decimal amount',
    zh: '单笔预估敞口上限必须为正十进制金额',
  },
  invalid_platform_currency: {
    category: 'invalid_input',
    message: 'Platform currency must be a 3-letter uppercase ISO 4217 code',
    zh: '平台币种必须为 3 位大写 ISO 4217 码',
  },
  platform_currency_locked: {
    category: 'conflict',
    message: 'Platform currency is locked once ledger, channel funds or usage exists',
    zh: '存在账本/渠道资金/用量记录后平台币种已锁定（换币需显式迁移）',
  },

  // ── integrations（第三方集成动态配置） ──
  integration_unknown: {
    category: 'not_found',
    message: 'Unknown integration key',
    zh: '集成键不在封闭词表内',
  },
  integration_config_incomplete: {
    category: 'invalid_input',
    message: 'Integration config incomplete for enablement',
    zh: '必填字段缺失，无法启用该集成',
  },
  integration_field_invalid: {
    category: 'invalid_input',
    message: 'Integration field name or value invalid',
    zh: '集成字段名不在规格内或值不合法（URL/端口/词表/长度）',
  },
  integration_secret_encrypted: {
    category: 'invalid_input',
    message: 'Secret field must be plaintext, not ciphertext',
    zh: 'secret 字段只收明文，禁止提交 enc: 密文',
  },

  // ── rate cards ───────────────────────────────────────────────────────────
  invalid_coefficient: {
    category: 'invalid_input',
    message: 'Coefficient must be a decimal string in (0, 9.999] with at most 3 decimals',
    zh: '系数须为 0.001–9.999 的十进制字符串且最多 3 位小数',
  },
  /** 绑定卡停用：网关报价读拒绝新请求（403 语义；热路径消费方抛出） */
  rate_card_disabled: {
    category: 'forbidden',
    message: 'The rate card bound to this account is disabled, please contact the administrator',
    zh: '账户绑定的费率卡已停用，请联系管理员',
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

  // ── admins（RBAC）────────────────────────
  /** 管理员邮箱已被占用（admins_email_uq 兜底,23505 翻译;identity 凭据冲突同码） */
  admin_email_taken: {
    category: 'conflict',
    message: 'Admin email already exists',
    zh: '管理员邮箱已被占用',
  },
  /** 角色不在封闭词表内（词表单一真相 = domain/rbac ADMIN_ROLES） */
  invalid_admin_role: {
    category: 'invalid_input',
    message: 'Invalid admin role',
    zh: '角色不在词表内（super_admin/operator/finance/support/viewer）',
  },

  // ── 动态 RBAC（动态角色 + 权限树）─────────────────────────────────
  /** 角色 code 已被占用 */
  role_exists: {
    category: 'conflict',
    message: 'Role code already exists',
    zh: '角色 code 已被占用',
  },
  /** 角色不存在 */
  role_not_found: { category: 'not_found', message: 'Role not found', zh: '角色不存在' },
  /** super/内置角色的不可变面被触碰（super 全锁;内置不可删） */
  role_immutable: {
    category: 'forbidden',
    message: 'Built-in role cannot be modified this way',
    zh: '内置角色不可如此修改（超管角色完全锁定，预置角色不可删除）',
  },
  /** 角色名下仍有管理员（删除守卫） */
  role_in_use: {
    category: 'conflict',
    message: 'Role still has assigned admins',
    zh: '角色名下仍有管理员，须先迁移',
  },
  /** 角色输入非法（code 形状/名称为空/status 词表外） */
  invalid_role_input: {
    category: 'invalid_input',
    message: 'Invalid role input',
    zh: '角色参数不合法',
  },
  /** 授权码不在活动权限集内 */
  invalid_permission_code: {
    category: 'invalid_input',
    message: 'Unknown or inactive permission code',
    zh: '权限码不存在或已停用',
  },
  /** 资源节点输入非法（码形状/父子类型/层级） */
  invalid_permission_input: {
    category: 'invalid_input',
    message: 'Invalid permission node input',
    zh: '资源节点参数不合法（码形状/父子类型/层级）',
  },
  /** 权限码已被占用（全量唯一性应用层守卫） */
  permission_code_taken: {
    category: 'conflict',
    message: 'Permission code already exists',
    zh: '权限码已被占用',
  },
  /** 资源节点不存在 */
  permission_not_found: {
    category: 'not_found',
    message: 'Permission node not found',
    zh: '资源节点不存在',
  },
  /** 节点仍有子节点（删除守卫） */
  permission_has_children: {
    category: 'conflict',
    message: 'Permission node still has children',
    zh: '节点仍有子节点，须先处理子节点',
  },
  /** 节点仍被接口绑定（删除守卫——先解绑/换绑,避免整片接口默认拒绝） */
  permission_in_use: {
    category: 'conflict',
    message: 'Permission node still guards endpoints',
    zh: '权限仍守护接口，须先解绑或换绑',
  },
  /** 接口绑定输入非法（method 词表/path 形状） */
  invalid_endpoint_input: {
    category: 'invalid_input',
    message: 'Invalid endpoint binding input',
    zh: '接口绑定参数不合法',
  },
  /** method+path 已有绑定 */
  endpoint_bound: {
    category: 'conflict',
    message: 'Endpoint already bound',
    zh: '该接口已有绑定，请换绑而非新建',
  },
  /** 绑定不存在 */
  endpoint_not_found: {
    category: 'not_found',
    message: 'Endpoint binding not found',
    zh: '接口绑定不存在',
  },
});

/** control-plane 错误目录身份码类型（码表封闭性的类型面） */
export type ControlPlaneErrorCode = (typeof controlPlaneErrors.codes)[number];
