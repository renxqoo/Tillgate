-- 0082：动态角色 + 单表权限树（RBAC 重构）。
--   permissions（group/page/button 树,enforced 种子 = 代码注册表导出）+ roles +
--   role_permissions;admins.role varchar → role_id 回填切换（旧列由 0083 在消费方
--   改造完成后 drop——两步迁移,每步门禁可绿;非对外兼容层）。
-- 节点规约：按钮一码一节点（部分唯一索引）;页面可共享域读码（同域多页同权限面,
--   可见性判定走码）;全量 code 唯一性由应用层 create/update 守卫
--   直接引用码（树是绑定 UI 的呈现,不是按钮注册表）。
-- 角色授权种子映射：域:write → 该域全部动词码展开;super_admin = is_super
--   隐式全量,不落授权行;ops:write 无写端点,自然蒸发。

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS permissions (
  id bigserial PRIMARY KEY,
  parent_id bigint REFERENCES permissions(id),
  type varchar(16) NOT NULL,
  code varchar(64),
  name varchar(128) NOT NULL,
  i18n_key varchar(128),
  description varchar(512),
  path varchar(255),
  icon varchar(64),
  sort_order bigint NOT NULL DEFAULT 0,
  status smallint NOT NULL DEFAULT 0,
  source varchar(16) NOT NULL DEFAULT 'custom',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS permissions_code_uq ON permissions (code) WHERE type = 'button';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS permissions_parent_idx ON permissions (parent_id);

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'permissions_type_ck') THEN
    ALTER TABLE permissions ADD CONSTRAINT permissions_type_ck
      CHECK (type IN ('group', 'page', 'button'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'permissions_code_shape_ck') THEN
    ALTER TABLE permissions ADD CONSTRAINT permissions_code_shape_ck CHECK (
      (type = 'group' AND code IS NULL) OR
      (type = 'button' AND code IS NOT NULL) OR
      type = 'page'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'permissions_status_ck') THEN
    ALTER TABLE permissions ADD CONSTRAINT permissions_status_ck CHECK (status IN (0, 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'permissions_source_ck') THEN
    ALTER TABLE permissions ADD CONSTRAINT permissions_source_ck
      CHECK (source IN ('enforced', 'custom'));
  END IF;
END
$$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS roles (
  id bigserial PRIMARY KEY,
  code varchar(64) NOT NULL,
  name varchar(128) NOT NULL,
  description varchar(512),
  status smallint NOT NULL DEFAULT 0,
  is_super boolean NOT NULL DEFAULT false,
  is_builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS roles_code_uq ON roles (code);

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_status_ck') THEN
    ALTER TABLE roles ADD CONSTRAINT roles_status_ck CHECK (status IN (0, 1));
  END IF;
END
$$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id bigint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS role_permissions_permission_idx ON role_permissions (permission_id);

-- ── 种子：角色（5 预置）──────────────────────────────────────────────────────

--> statement-breakpoint
INSERT INTO roles (code, name, description, status, is_super, is_builtin) VALUES
  ('super_admin', '超级管理员', '平台所有者:隐式全量权限（不落授权行）,不可编辑或删除', 0, true, true),
  ('operator',    '运营',       '目录/订阅/观测/增长/设置读写 + 用户管理（v1 矩阵展开）', 0, false, true),
  ('finance',     '财务',       '资金对账与调账,全业务域只读（v1 矩阵展开）', 0, false, true),
  ('support',     '客服',       '用户资料与密钥管理,业务域只读（v1 矩阵展开,无 settings）', 0, false, true),
  ('viewer',      '只读',       '全业务域只读（v1 矩阵展开）', 0, false, true);

-- ── 种子：权限树 ── 目录（group,无码）───────────────────────────────────────

--> statement-breakpoint
INSERT INTO permissions (parent_id, type, code, name, i18n_key, sort_order, source) VALUES
  (NULL, 'group', NULL, '运营总览', 'nav.groupOverview', 1, 'enforced'),
  (NULL, 'group', NULL, '资源管理', 'nav.groupResources', 2, 'enforced'),
  (NULL, 'group', NULL, '模型管理', 'nav.groupModels', 3, 'enforced'),
  (NULL, 'group', NULL, '充值码',   'nav.groupRedeem', 4, 'enforced'),
  (NULL, 'group', NULL, '审计',     'nav.groupAudit', 5, 'enforced'),
  (NULL, 'group', NULL, '系统管理', 'nav.groupSystem', 6, 'enforced');

-- ── 种子：页面（page;dashboard 无码 = 全员可见）────────────────────────────

--> statement-breakpoint
INSERT INTO permissions (parent_id, type, code, name, i18n_key, path, icon, sort_order, source)
SELECT g.id, 'page', v.code, v.name, v.i18n_key, v.path, v.icon, v.sort_order, 'enforced'
FROM (VALUES
  ('nav.groupOverview', NULL,       '概览',     'nav.dashboard',        '/dashboard',                   'ChartBar',    1),
  ('nav.groupResources','users:read','用户',    'nav.users',            '/dashboard/users',             'UsersRound',  1),
  ('nav.groupResources','catalog:read','费率卡','nav.rateCards',        '/dashboard/rate-cards',        'Banknote',    2),
  ('nav.groupResources','users:read','限流',    'nav.rateLimits',       '/dashboard/rate-limits',       'Gauge',       3),
  ('nav.groupResources','plans:read','套餐',    'nav.plans',            '/dashboard/plans',             'Gem',         4),
  ('nav.groupResources','plans:read','订阅',    'nav.subscriptions',    '/dashboard/subscriptions',     'CalendarClock',5),
  ('nav.groupResources','funds:read','渠道资金','nav.channelFunds',     '/dashboard/channel-funds',     'Wallet',      6),
  ('nav.groupResources','growth:read','营销',   'nav.marketing',        '/dashboard/marketing',         'Megaphone',   7),
  ('nav.groupResources','growth:read','邀请',   'nav.referrals',        '/dashboard/referrals',         'UserPlus',    8),
  ('nav.groupResources','funds:read','支付订单','nav.paymentOrders',    '/dashboard/payment-orders',    'CreditCard',  9),
  ('nav.groupModels',   'catalog:read','供应商','nav.providers',        '/dashboard/providers',         'Server',      1),
  ('nav.groupModels',   'catalog:read','渠道',  'nav.channels',         '/dashboard/channels',          'Network',     2),
  ('nav.groupModels',   'catalog:read','模型映射','nav.models',         '/dashboard/models',            'Server',      3),
  ('nav.groupModels',   'catalog:read','模型市场','nav.modelMarket',    '/dashboard/model-market',      'Store',       4),
  ('nav.groupRedeem',   'funds:read','兑换批次', 'nav.redeemBatches',   '/dashboard/redeem-batches',    'Ticket',      1),
  ('nav.groupAudit',    'growth:read','通知',   'nav.notifications',    '/dashboard/notifications',     'Bell',        1),
  ('nav.groupAudit',    'funds:read','计费操作', 'nav.billingOperations','/dashboard/billing-operations','ShieldAlert',2),
  ('nav.groupAudit',    'ops:read','链路追踪',   'nav.tracing',          '/dashboard/tracing',           'Activity',    3),
  ('nav.groupAudit',    'ops:read','请求日志',   'nav.logs',             '/dashboard/logs',              'ScrollText',  4),
  ('nav.groupAudit',    'ops:read','用量日志',   'nav.usageLogs',        '/dashboard/usage-logs',        'Coins',       5),
  ('nav.groupAudit',    'ops:read','审计日志',   'nav.auditLogs',        '/dashboard/audit-logs',        'History',     6),
  ('nav.groupSystem',   'admins:read','管理员',  'nav.admins',           '/dashboard/admins',            'UserCog',     1),
  ('nav.groupSystem',   'admins:read','角色管理','nav.roles',            '/dashboard/roles',             'Users',       2),
  ('nav.groupSystem',   'admins:read','权限资源','nav.permissions',      '/dashboard/permissions',       'ListTree',    3),
  ('nav.groupSystem',   'settings:read','安全设置','nav.settings',       '/dashboard/settings',          'ShieldCheck', 4)
) AS v(group_key, code, name, i18n_key, path, icon, sort_order)
JOIN permissions g ON g.i18n_key = v.group_key AND g.type = 'group';

-- ── 种子：按钮（一码一节点,挂主页面;共用码不重复建节点）─────────────────────

--> statement-breakpoint
INSERT INTO permissions (parent_id, type, code, name, sort_order, source)
SELECT p.id, 'button', v.code, v.name, v.sort_order, 'enforced'
FROM (VALUES
  ('nav.users',             'users:update',      '编辑用户/密钥/限流', 1),
  ('nav.users',             'users:set-password','重置密码',           2),
  ('nav.users',             'funds:gift',        '用户赠送',           3),
  ('nav.channelFunds',      'funds:adjust',      '调账（渠道/用户）',  1),
  ('nav.channelFunds',      'funds:recharge',    '渠道进货',           2),
  ('nav.paymentOrders',     'funds:close',       '手动关单',           1),
  ('nav.redeemBatches',     'funds:create',      '新建兑换批次',       1),
  ('nav.redeemBatches',     'funds:revoke',      '作废兑换码',         2),
  ('nav.billingOperations', 'funds:retry',       '重试死单',           1),
  ('nav.billingOperations', 'funds:abandon',     '放弃死单',           2),
  ('nav.channels',          'catalog:create',    '新建（供应商/渠道/模型/费率卡）', 1),
  ('nav.channels',          'catalog:update',    '编辑（供应商/渠道/模型/费率卡/汇率）', 2),
  ('nav.channels',          'catalog:delete',    '删除（供应商/渠道/模型/费率卡）', 3),
  ('nav.channels',          'catalog:restore',   '恢复（回收站）',     4),
  ('nav.channels',          'catalog:test',      '测试（渠道/模型）',  5),
  ('nav.channels',          'catalog:import',    '批量导入（渠道/目录）',6),
  ('nav.channels',          'catalog:refresh',   '刷新汇率',           7),
  ('nav.models',            'catalog:bind',      '模型绑定渠道',       1),
  ('nav.plans',             'plans:create',      '新建套餐',           1),
  ('nav.plans',             'plans:update',      '编辑套餐',           2),
  ('nav.plans',             'plans:delete',      '删除套餐',           3),
  ('nav.subscriptions',     'plans:renew',       '续订',               1),
  ('nav.subscriptions',     'plans:cancel',      '取消订阅',           2),
  ('nav.subscriptions',     'plans:change',      '变更套餐',           3),
  ('nav.subscriptions',     'plans:grant',       '赠送订阅',           4),
  ('nav.notifications',     'growth:create',     '新建通知渠道',       1),
  ('nav.notifications',     'growth:update',     '编辑（通知/营销/邀请）',2),
  ('nav.notifications',     'growth:delete',     '删除通知渠道',       3),
  ('nav.notifications',     'growth:test',       '测试通知渠道',       4),
  ('nav.roles',             'admins:create',     '新建（管理员/角色/资源）', 1),
  ('nav.roles',             'admins:update',     '编辑/授权（管理员/角色/资源）', 2),
  ('nav.roles',             'admins:delete',     '删除（角色/资源）',  3),
  ('nav.settings',          'settings:update',   '计费时区写入',       1)
) AS v(page_key, code, name, sort_order)
JOIN permissions p ON p.i18n_key = v.page_key AND p.type = 'page';

-- ── 种子：角色授权（域:write → 该域全部动词码）──────────────────

--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT ON (r.id, p.code) r.id, p.id
FROM (VALUES
  ('operator', ARRAY[
    'users:read','funds:read','catalog:read','plans:read','ops:read','growth:read','settings:read',
    'users:update','users:set-password',
    'catalog:create','catalog:update','catalog:delete','catalog:restore','catalog:test','catalog:import','catalog:refresh','catalog:bind',
    'plans:create','plans:update','plans:delete','plans:renew','plans:cancel','plans:change','plans:grant',
    'growth:create','growth:update','growth:delete','growth:test',
    'settings:update'
  ]),
  ('finance', ARRAY[
    'users:read','funds:read','catalog:read','plans:read','ops:read','growth:read','settings:read',
    'funds:adjust','funds:recharge','funds:gift','funds:close','funds:revoke','funds:create','funds:retry','funds:abandon'
  ]),
  ('support', ARRAY[
    'users:read','funds:read','catalog:read','plans:read','ops:read','growth:read',
    'users:update','users:set-password'
  ]),
  ('viewer', ARRAY[
    'users:read','funds:read','catalog:read','plans:read','ops:read','growth:read','settings:read'
  ])
) AS v(role_code, codes)
JOIN roles r ON r.code = v.role_code
JOIN permissions p ON p.code = ANY (v.codes)
ORDER BY r.id, p.code;

-- ── admins.role_id 切换（回填 + NOT NULL;旧 role 列由 0083 drop）───────────

--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role_id bigint REFERENCES roles(id);

--> statement-breakpoint
DO $$
BEGIN
  UPDATE admins a SET role_id = r.id FROM roles r WHERE a.role_id IS NULL AND a.role = r.code;
  IF EXISTS (SELECT 1 FROM admins WHERE role_id IS NULL) THEN
    RAISE EXCEPTION '0082: admins rows without role mapping (unknown role string)';
  END IF;
  ALTER TABLE admins ALTER COLUMN role_id SET NOT NULL;
END
$$;
