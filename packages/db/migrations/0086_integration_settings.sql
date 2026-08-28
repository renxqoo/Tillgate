-- 0086：第三方集成动态配置。
-- OAuth/SMTP/Turnstile/易支付/Stripe 凭据从 env 装配期注入迁入本表：
-- secret 字段以 enc:v1 密文内嵌 config jsonb（根密钥 = 渠道 Key 同一部署契约）；
-- previous_secrets 承载支付验签密钥轮换双读窗（96h 自愈，仅 rotatable 字段进入）。
-- 绑定种子 = 新 settings 集成端点 2 条（数据化执行面，fail-closed）。

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS integration_settings (
  key varchar(64) PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_secrets jsonb,
  rotated_at timestamptz,
  updated_by_admin_id bigint REFERENCES admins(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_settings_key_ck CHECK (key IN ('oauth.base','oauth.github','oauth.google','smtp','captcha.turnstile','payment.epay','payment.stripe'))
);

--> statement-breakpoint
INSERT INTO endpoint_permissions (method, path, permission_id, source)
SELECT v.method, v.path, v.permission_id, 'enforced'
FROM (VALUES
  ('GET', '/v1/settings/integrations', (SELECT id FROM permissions WHERE code = 'settings:read' LIMIT 1)),
  ('PUT', '/v1/settings/integrations/:key', (SELECT id FROM permissions WHERE code = 'settings:update' LIMIT 1))
) AS v(method, path, permission_id)
ON CONFLICT (method, path) DO NOTHING;
