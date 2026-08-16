ALTER TABLE "providers" ALTER COLUMN "protocol" SET DEFAULT 'openai-compatible';

--> statement-breakpoint
-- 协议词表一次性收敛：providers.protocol 统一为适配器注册表键 'openai-compatible'
-- （原值 'openai_compatible' 为 snake_case 旧词表；读时翻译函数 toProtocol 已随本变更删除，
--  存量数据在此一次性迁移，不留运行时兼容分支）。执行前已核查：存量仅 'openai_compatible' 一种值。
UPDATE "providers" SET "protocol" = 'openai-compatible' WHERE "protocol" = 'openai_compatible';
