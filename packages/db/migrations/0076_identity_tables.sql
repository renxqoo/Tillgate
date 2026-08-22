-- 0076：identity 七表迁入统一迁移链（v1 identity-core provision 链收口，总纲 §3.4/P3）。
-- 全部语句 if not exists 幂等；v1 生产由 provision 链建过 challenges/anchors 两表，
-- 其余五表生产为空（v1 apps 未消费）——本迁移不携带数据变更，revert 无数据回滚。
-- 码哈希口径变化（sha256 → HMAC(pepper)）由 identity 包装配密钥保证；存量 in-flight
-- 挑战（TTL 300s）切换即过期，无需回填（identity MIGRATION §6）。

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_credentials (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  identifier_kind varchar(16) NOT NULL,
  identifier_value varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_credentials_identifier_uq UNIQUE (identifier_kind, identifier_value),
  CONSTRAINT identity_credentials_kind_ck CHECK (identifier_kind IN ('email', 'phone', 'username'))
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_credentials_user_idx ON identity_credentials (user_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_passwords (
  user_id bigint PRIMARY KEY,
  password_hash varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_oauth_links (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  provider varchar(32) NOT NULL,
  subject varchar(255) NOT NULL,
  email varchar(255),
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_oauth_links_provider_subject_uq UNIQUE (provider, subject),
  CONSTRAINT identity_oauth_links_user_provider_uq UNIQUE (user_id, provider)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_oauth_links_user_idx ON identity_oauth_links (user_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_challenges (
  id uuid PRIMARY KEY,
  kind varchar(32) NOT NULL,
  identifier_kind varchar(16),
  identifier_value varchar(255),
  user_id bigint,
  code_hash varchar(64) NOT NULL,
  payload jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  aborted_at timestamptz,
  CONSTRAINT identity_challenges_target_ck CHECK ((identifier_value IS NULL) <> (user_id IS NULL)),
  CONSTRAINT identity_challenges_target_kind_ck CHECK (identifier_value IS NULL OR identifier_kind IS NOT NULL),
  CONSTRAINT identity_challenges_attempts_ck CHECK (attempts BETWEEN 0 AND max_attempts),
  CONSTRAINT identity_challenges_max_attempts_ck CHECK (max_attempts BETWEEN 1 AND 100),
  CONSTRAINT identity_challenges_expiry_ck CHECK (expires_at > issued_at),
  CONSTRAINT identity_challenges_terminal_ck CHECK (consumed_at IS NULL OR aborted_at IS NULL)
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS identity_challenges_live_identifier_uq
  ON identity_challenges (kind, identifier_kind, identifier_value)
  WHERE consumed_at IS NULL AND aborted_at IS NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS identity_challenges_live_user_uq
  ON identity_challenges (kind, user_id)
  WHERE consumed_at IS NULL AND aborted_at IS NULL AND user_id IS NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_challenges_expires_idx ON identity_challenges (expires_at);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_totp (
  user_id bigint PRIMARY KEY,
  secret text NOT NULL,
  confirmed_at timestamptz,
  last_used_step bigint NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_recovery_codes (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  code_hash varchar(64) NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_recovery_codes_hash_uq UNIQUE (user_id, code_hash)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_recovery_codes_user_idx ON identity_recovery_codes (user_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_session_anchors (
  realm varchar(32) NOT NULL DEFAULT 'user',
  user_id bigint NOT NULL,
  invalid_before timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_session_anchors_realm_ck CHECK (realm ~ '^[a-z][a-z0-9_-]{1,31}$'),
  PRIMARY KEY (realm, user_id)
);
