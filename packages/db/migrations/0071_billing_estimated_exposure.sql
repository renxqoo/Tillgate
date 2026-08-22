-- fixed 预扣把“风险预估”与“实际冻结”拆开：日限额继续按完整风险口径统计。
alter table billing_requests
  add column if not exists estimated_exposure_amount numeric(38, 18);

update billing_requests
set estimated_exposure_amount = reserved_amount
where estimated_exposure_amount is null;

alter table billing_requests
  alter column estimated_exposure_amount set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_requests_amounts_nonnegative_ck'
  ) then
    alter table billing_requests
      add constraint billing_requests_amounts_nonnegative_ck
      check (estimated_exposure_amount >= 0 and reserved_amount >= 0);
  end if;
end $$;
