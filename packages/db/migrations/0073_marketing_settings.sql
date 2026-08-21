-- 营销参数落库（2026-08-21）：注册赠送/邀请双奖励/佣金比例从 env 迁入管理面。
-- seed 初值 = 迁移时点环境生效值快照（GIFT_AMOUNT 未配=0 / SIGNUP_BONUS=1 / RATE=0.1）
-- ——上线日零行为变化；此后唯一修改入口为管理面（PUT /v1/marketing/settings，全程审计）。
create table if not exists marketing_settings (
  id integer primary key default 1,
  signup_gift_amount numeric(38, 18) not null default '0',
  referral_signup_bonus numeric(38, 18) not null default '0',
  referral_commission_rate numeric(38, 18) not null default '0',
  updated_by bigint references admins(id),
  updated_at timestamptz not null default now(),
  constraint marketing_settings_single_row_ck check (id = 1),
  constraint marketing_settings_gift_ck check (signup_gift_amount >= 0),
  constraint marketing_settings_bonus_ck check (referral_signup_bonus >= 0),
  constraint marketing_settings_rate_ck check (referral_commission_rate >= 0 and referral_commission_rate <= 1)
);

insert into marketing_settings (id, signup_gift_amount, referral_signup_bonus, referral_commission_rate)
values (1, '0', '1', '0.1')
on conflict (id) do nothing;
