-- 0062：供应商厂商档案引用——providers.vendor 指向 ai 包 VENDOR_PROFILES 词表
-- （openai-compatible 协议族的参数怪癖预设：如 openai 的 max_tokens→max_completion_tokens）。
-- 可空：未声明 = 无档案（纯透传）；合法值由 admin-api 按 vendorProfileNames() 校验。
alter table "providers" add column if not exists "vendor" varchar(32)
