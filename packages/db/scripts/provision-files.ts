/**
 * provision-fresh 的前置迁移文件清单（顺序即执行顺序；内容与 journal 内文件同源，
 * 不复制改写）。独立成零依赖模块：CLI 脚本与结构测试共同引用，测试不受脚本的
 * 数据库依赖拖累。
 *
 * 结构不变量（__test__/provision-files.test.ts 强制）：本列表在「空库、journal
 * 全未应用」的前提下先行执行，因此各文件的写操作（INSERT/UPDATE/DELETE/ALTER）
 * 只能引用列表中更早文件 CREATE 的表——引用 journal 后建表（如 0084
 * endpoint_permissions）的语句在这里必然失败，不得加入。
 */
export const PROVISION_FILES = [
  '../migrations/0059_wallet_ledger_operations_convergence.sql',
  '../migrations/0076_identity_tables.sql',
  // 0059 的 create or replace function 是「替换」而非幂等——重放会把
  // wallet_assert_account_coherent 倒回旧版（0069/0095 的后续版本被覆盖，
  // 表现为每次 up -d 后透支地板/负余额结算神秘失效）。provision 末尾必须
  // 追加「最新触发改版迁移」重放函数终态；后续再改此函数时同步更新此处。
  '../migrations/0095_wallet_debit_floor.sql',
] as const;
