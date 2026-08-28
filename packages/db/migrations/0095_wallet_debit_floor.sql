-- 受控透支地板：结算超收（actual > 预留）可使用户余额为负，但深度受
-- wallet_accounts.debit_floor 约束——可用敞口（balance + credit_limit −
-- in_flight）不得低于 −debit_floor。0 = 不透支；>0 = 允许受控负余额。
-- 同事务收敛历史部署中 0069 函数替换未生效的漂移（create or replace 幂等）。
alter table wallet_accounts
  add column if not exists debit_floor numeric(38, 18) not null default '0';

alter table wallet_accounts
  drop constraint if exists wallet_accounts_debit_floor_nonnegative_ck;
alter table wallet_accounts
  add constraint wallet_accounts_debit_floor_nonnegative_ck check (debit_floor >= 0);

create or replace function wallet_assert_account_coherent()
returns trigger
language plpgsql
as $$
declare
  target_id uuid;
  account_kind varchar(8);
  stored_balance numeric(38,18);
  stored_in_flight numeric(38,18);
  stored_credit_limit numeric(38,18);
  stored_debit_floor numeric(38,18);
  last_balance numeric(38,18);
  active_total numeric(38,18);
begin
  if tg_table_name = 'wallet_accounts' then
    target_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    target_id := case when tg_op = 'DELETE' then old.account_id else new.account_id end;
  end if;
  select kind, balance, in_flight, credit_limit, debit_floor
    into account_kind, stored_balance, stored_in_flight, stored_credit_limit, stored_debit_floor
    from wallet_accounts where id = target_id;
  if not found then return null; end if;
  select balance_after into last_balance
    from wallet_legs where account_id = target_id order by id desc limit 1;
  last_balance := coalesce(last_balance, 0);
  select coalesce(sum(amount), 0) into active_total
    from wallet_authorizations where account_id = target_id and status = 'active';
  if stored_balance <> last_balance then
    raise exception 'wallet account % balance differs from final leg', target_id using errcode = '23514';
  end if;
  if stored_in_flight <> active_total then
    raise exception 'wallet account % in_flight differs from active authorizations', target_id using errcode = '23514';
  end if;
  -- 受控透支：地板 = credit_limit + debit_floor（新消费准入仍由 authorize 守卫
  -- 按 credit 口径把关；本检查只约束结算后的最终敞口深度）。
  if account_kind = 'user'
     and stored_balance + stored_credit_limit + stored_debit_floor - stored_in_flight < 0 then
    raise exception 'wallet account % available exposure below debit floor', target_id using errcode = '23514';
  end if;
  return null;
end
$$;
