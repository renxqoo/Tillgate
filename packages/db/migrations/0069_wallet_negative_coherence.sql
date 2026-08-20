-- 负余额仍必须满足“余额等于最后一条腿、在途等于 active authorization 总和”；
-- 仅移除 available exposure 非负限制。准入守卫留在 wallet.authorize，已发生消费可全额结算。
create or replace function wallet_assert_account_coherent()
returns trigger
language plpgsql
as $$
declare
  target_id uuid;
  stored_balance numeric(38,18);
  stored_in_flight numeric(38,18);
  last_balance numeric(38,18);
  active_total numeric(38,18);
begin
  if tg_table_name = 'wallet_accounts' then
    target_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    target_id := case when tg_op = 'DELETE' then old.account_id else new.account_id end;
  end if;
  select balance, in_flight
    into stored_balance, stored_in_flight
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
  return null;
end
$$;
