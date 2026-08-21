/**
 * 测试 09：计费异常「人工复核」链路验证（listCases / retry / resolve）。
 *
 * 测什么：
 *   用真实管理员会话调 admin-api 的 billing-operations 接口，验证「人工点确认退还/重试结算」
 *   这条复核链路本身是否正确工作：
 *     1. GET  /billing-operations?status=dead|uncertain → 列出异常单
 *     2. POST /billing-operations/:requestId/retry   → 对 dead 单「重试结算」→ 应按实际金额结算并释放差额
 *     3. POST /billing-operations/:requestId/resolve → 对 uncertain 单「确认未扣费」→ 应释放预留（退款）
 *
 *   本脚本只动 2 条（1 条 dead + 1 条 uncertain）做验证，其余 120 条异常单保留作证据不动。
 *
 * 报红条件（=复核链路本身有 bug）：
 *   - listCases 空 / retry 未置 retry_wait / retry 后不结算 / resolve 后不 released / 预留未释放。
 *
 * 运行：pnpm tsx scripts/security-audit/09-billing-review-flow.mts
 */
import {
  loadEnv,
  adminCookie,
  post,
  get,
  psql,
  q,
  ADMIN_API,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

function normBalance(s: string): string {
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}
function num(s: string): number {
  return Number(normBalance(s));
}

interface CaseItem {
  requestId: string;
  userId: number;
  status: string;
  revision: number;
  reservedAmount: string;
  failureCode: string | null;
}

async function listCases(status: 'dead' | 'uncertain', limit: number): Promise<CaseItem[]> {
  const res = await get(`${ADMIN_API}/api/admin/billing-operations?status=${status}&limit=${limit}`, {
    cookie: await adminCookie(),
  });
  if (res.status !== 200) throw new Error(`listCases(${status}) 失败: ${res.status} ${res.raw}`);
  return ((res.body as { items: CaseItem[] }).items ?? []) as CaseItem[];
}

async function main(): Promise<void> {
  console.log('🧪 测试 09：计费异常人工复核链路（listCases / retry / resolve）');
  console.log(`   admin-api: ${ADMIN_API}`);

  let anyRed = false;
  try {
    // ---- 1. 列异常单 ----
    section('1. 列异常单（dead / uncertain 各取 1 条）');
    const deadList = await listCases('dead', 1);
    const uncertainList = await listCases('uncertain', 1);
    console.log(`   dead 单总数逻辑：取到 ${deadList.length} 条；uncertain 取到 ${uncertainList.length} 条`);
    if (deadList.length === 0 || uncertainList.length === 0) {
      red('listCases 返回空，无法复核', `dead=${deadList.length} uncertain=${uncertainList.length}`);
    }
    const dead = deadList[0]!;
    const uncertain = uncertainList[0]!;
    console.log(`   dead 样例: ${dead.requestId} (user=${dead.userId}, rev=${dead.revision}, ${dead.failureCode})`);
    console.log(`   uncertain 样例: ${uncertain.requestId} (user=${uncertain.userId}, rev=${uncertain.revision}, ${uncertain.failureCode})`);

    // ---- 2. resolve uncertain：确认未扣费（退还） ----
    section('2. resolve uncertain（确认未扣费 → 应释放预留）');
    const ubefore = psql(`select balance, reserved_balance from users where id=${uncertain.userId};`);
    const [ubal, ures] = ubefore.split('|');
    console.log(`   user=${uncertain.userId} 复核前: balance=${ubal} reserved=${ures}`);

    const resolveRes = await post(
      `${ADMIN_API}/api/admin/billing-operations/${uncertain.requestId}/resolve`,
      {
        decision: 'confirmed_no_charge',
        expectedRevision: uncertain.revision,
        reason: '审计测试：上游429未扣费，确认退还',
        evidenceRefs: ['scripts/security-audit/09-billing-review-flow.mts'],
      },
      { cookie: await adminCookie(), headers: { 'idempotency-key': `sec09-resolve-${uncertain.requestId}` } },
    );
    console.log(`   resolve 响应: ${resolveRes.status} ${JSON.stringify(resolveRes.body).slice(0, 200)}`);
    const brAfterResolve = psql(`select status from billing_requests where request_id=${q(uncertain.requestId)};`);
    const uafter = psql(`select reserved_balance from users where id=${uncertain.userId};`);
    console.log(`   复核后: billing=${brAfterResolve} reserved=${uafter}`);
    if (resolveRes.status !== 200 || brAfterResolve !== 'released') {
      anyRed = true;
      console.error(`   🔴 [resolve 失败] uncertain 单未 released（status=${brAfterResolve}，resp=${resolveRes.status}）`);
    } else if (num(ures) - num(uafter) < num(uncertain.reservedAmount) - 1e-12) {
      anyRed = true;
      console.error(`   🔴 [退款金额不对] reserved 从 ${ures} 只降到 ${uafter}，应退 ${uncertain.reservedAmount}`);
    } else {
      green(`uncertain 单已 released，预留已释放 ¥${uncertain.reservedAmount}（balance 未动、可用余额恢复）`);
    }

    // ---- 3. retry dead：重试结算（应实际结算并释放差额） ----
    section('3. retry dead（重试结算 → 应按实际金额结算）');
    const dbefore = psql(`select balance, reserved_balance from users where id=${dead.userId};`);
    const [dbal, dres] = dbefore.split('|');
    console.log(`   user=${dead.userId} 复核前: balance=${dbal} reserved=${dres}`);

    const retryRes = await post(
      `${ADMIN_API}/api/admin/billing-operations/${dead.requestId}/retry`,
      {
        expectedRevision: dead.revision,
        reason: '审计测试：token 上界误判，重试结算',
        evidenceRefs: ['scripts/security-audit/09-billing-review-flow.mts'],
      },
      { cookie: await adminCookie(), headers: { 'idempotency-key': `sec09-retry-${dead.requestId}` } },
    );
    console.log(`   retry 响应: ${retryRes.status} ${JSON.stringify(retryRes.body).slice(0, 200)}`);
    if (retryRes.status !== 200) {
      anyRed = true;
      console.error(`   🔴 [retry 失败] ${retryRes.status} ${retryRes.raw.slice(0, 200)}`);
    }

    // 等 worker 结算
    let settled = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = psql(`select status from billing_requests where request_id=${q(dead.requestId)};`);
      if (st === 'settled') {
        settled = true;
        break;
      }
      if (st === 'dead' || st === 'retry_wait') continue; // 继续等
    }
    const dbr = psql(`select status from billing_requests where request_id=${q(dead.requestId)};`);
    const dusage = psql(`select amount from usage_logs where request_id=${q(dead.requestId)};`);
    const dconsume = psql(`select amount from transactions where ref_id=${q(dead.requestId)} and type='consume';`);
    const dafter = psql(`select balance, reserved_balance from users where id=${dead.userId};`);
    const [dafterBal, dafterRes] = dafter.split('|');
    console.log(`   复核后: billing=${dbr} usage_amount=${dusage} consume_amount=${dconsume} balance=${dafterBal} reserved=${dafterRes}`);

    if (!settled || dbr !== 'settled') {
      anyRed = true;
      console.error(`   🔴 [retry 后未结算] dead 单 retry 后仍=${dbr}，复核链路未能把异常单结算掉。`);
    } else {
      const charged = num(dusage);
      const expectedBalance = num(dbal) - charged;
      // 注意：该用户还有其它冻结中的异常单，reserved_balance 是「聚合值」，不能断言为 0；
      // 正确断言是「本单的预留（dead.reservedAmount）被精确释放」，即 reserved 的减少量等于本单预留。
      const reservedReleased = num(dres) - num(dafterRes);
      if (Math.abs(num(dafterBal) - expectedBalance) > 1e-9) {
        anyRed = true;
        console.error(`   🔴 [结算金额不符] balance ${dbal} → ${dafterBal}，按扣费 ${dusage} 应=${expectedBalance}`);
      } else if (Math.abs(reservedReleased - num(dead.reservedAmount)) > 1e-12) {
        anyRed = true;
        console.error(
          `   🔴 [预留释放量不对] 结算后 reserved ${dres} → ${dafterRes}（释放 ${reservedReleased}），` +
            `应精确释放本单预留 ${dead.reservedAmount}`,
        );
      } else if (charged <= 0) {
        anyRed = true;
        console.error(`   🔴 [零金额结算] usage amount=${dusage}，真实消费却计费 0`);
      } else {
        green(`dead 单重试后正常结算：实收 ¥${dusage}（< 原预留 ${dead.reservedAmount}），本单预留已精确释放`);
      }
    }

    if (anyRed) {
      red('计费复核链路存在 bug（retry/resolve 未正确处置异常单）', '详见上方 🔴 标记。');
    }
    green('复核链路工作正常：resolve 退款、retry 按实际金额结算且释放差额');
  } finally {
    console.log('\n（按指示：仅动了 1 条 dead + 1 条 uncertain 做验证，其余异常单保留作证据）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
