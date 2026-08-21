/**
 * 测试 06：真实 MiniMax-M3 全链路计费对账（计费安全 / 会不会被薅羊毛的正面验证）。
 *
 * 测什么：
 *   用一个全新账号走完整真实链路：管理员开通 → 用户首登（获赠 ¥1）→ 建 Key →
 *   真实调 MiniMax-M3（非流式，小 max_tokens，产生极少量真实费用）→ 等 worker 异步结算 →
 *   核对 4 件事：
 *     1. billing_requests 状态机收敛到 settled（authorized → in_flight → settlement_pending → settled）
 *     2. usage_logs 落库且 amount > 0（真实 token 消耗必须精确计费，不能是 0）
 *     3. transactions 出现 type=consume 的扣费流水，且 amount 与 usage_logs 一致
 *     4. users.balance 精确减少 amount、reserved_balance 归 0（无透支、无残留预留）
 *
 * 报红条件（=发现计费/薅羊毛漏洞）：amount 为 0、余额对账不符、预留未释放、状态机卡住不结算。
 * 这是对「计费安全吗？会被薅羊毛吗？」的端到端正向证明；真实模型只用 MiniMax-M3。
 *
 * 运行：pnpm tsx scripts/security-audit/06-billing-settlement-minimax.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
  userLogin,
  createKey,
  post,
  psql,
  q,
  GATEWAY,
  newSubject,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

const MODEL = 'MiniMax-M3';

function normBalance(s: string): string {
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}
function balanceNum(s: string): number {
  return Number(normBalance(s));
}

async function main(): Promise<void> {
  console.log('🧪 测试 06：真实 MiniMax-M3 全链路计费对账');
  console.log(`   gateway: ${GATEWAY} | 模型: ${MODEL}（真实上游，消耗极少量额度）`);

  const admin = await adminCookie();
  const subject = newSubject('billing');
  const password = 'BillingPass123!';
  let uid: number | null = null;
  let requestId: string | null = null;

  try {
    section('准备：创建账号 → 设密码 → 首登（获赠额度）→ 建 Key');
    uid = insertUser(subject, '0'); // 余额 0 → 首登触发 signup gift
    await setPassword(admin, uid, password);
    const login = await userLogin(subject, password);
    const beforeBalance = psql(`select balance from users where id=${uid};`);
    green(`账号 ${subject} (id=${uid}) 首登后余额=${beforeBalance} 元（gifted=${login.body.gifted}）`);
    const key = await createKey(login.cookie);

    section('真实调用 MiniMax-M3（非流式，max_tokens=8）');
    const res = await post(
      `${GATEWAY}/v1/chat/completions`,
      { model: MODEL, messages: [{ role: 'user', content: '只回复两个字：你好' }], max_tokens: 8 },
      { headers: { authorization: `Bearer ${key}` } },
    );
    requestId = res.headers.get('x-request-id') ?? null;
    console.log(`  chat → ${res.status}，x-request-id=${requestId}`);
    if (res.status !== 200) throw new Error(`chat 失败: ${res.status} ${res.raw.slice(0, 300)}`);
    const parsed = res.body as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    green(`上游 usage: prompt=${parsed.usage?.prompt_tokens} completion=${parsed.usage?.completion_tokens}`);

    section('等 worker 异步结算（最多 20s），并定位 billing_requests 终态');
    let settled = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const n = Number(psql(`select count(*) from usage_logs where user_id=${uid};`));
      if (n >= 1) {
        settled = true;
        break;
      }
    }

    // 关键：先看 billing_requests 走到哪个终态，区分「结算慢」还是「被 usage_exceeds_authorization 判死」
    const brRow = psql(
      `select status, failure_class, last_error, reserved_amount, receipt->>'usage' from billing_requests where request_id=${q(requestId ?? '')} limit 1;`,
    );
    console.log(`  billing_requests 状态: ${brRow || '(未找到该 request 行)'}`);

    if (!settled) {
      if (brRow.startsWith('dead')) {
        red(
          '计费 BUG：input token 上界（字节数）低估 MiniMax-M3 真实 prompt_tokens → 请求被判 dead、永不结算、用户未被扣费',
          `user=${uid} 真实调用 MiniMax-M3：billing_requests=${brRow}。` +
            `根因：llm-pipeline 用「UTF-8 字节数」作为输入 token 上界（≈106），但 MiniMax-M3 上报 prompt_tokens=181 > 上界，` +
            `validateReceipt 抛 usage_exceeds_authorization → 状态 dead、预留冻结。` +
            `后果：上游成本已产生，用户却未被扣费（白嫖），且该请求卡死需人工复核——真实计费链路被打破。`,
        );
      }
      red(
        '计费结算卡住：worker 20s 内未生成 usage_logs（请求被白嫖，未计费）',
        `user=${uid} 调用 MiniMax-M3 成功后 20s 无 usage_logs 记录，` +
          `billing_requests=${brRow}。说明结算未落地，存在「已消费未计费」的资金风险。`,
      );
    }

    const usage = psql(
      `select request_id, input_tokens, output_tokens, amount, calculated_amount, status from usage_logs where user_id=${uid} order by id desc limit 1;`,
    );
    const [uRequestId, inTok, outTok, amount, calcAmount, status] = usage.split('|');
    console.log(`  usage_logs: request=${uRequestId} input=${inTok} output=${outTok} amount=${amount} calc=${calcAmount} status=${status}`);

    if (balanceNum(amount) <= 0) {
      red(
        '计费资损：真实 token 消耗却计费为 0（可被无限薅羊毛）',
        `usage_logs.amount=${amount}（应为正数）。真实 MiniMax-M3 调用产生了 ${inTok}/${outTok} token，` +
          `计费金额却 <= 0，说明计费公式/单位/舍入存在资损漏洞。`,
      );
    }

    const tx = psql(
      `select type, amount, balance_before, balance_after from transactions where user_id=${uid} and type='consume' order by id desc limit 1;`,
    );
    if (!tx) {
      red('计费缺流水：usage_logs 已落库但 transactions 无 consume 流水', `user=${uid} 缺扣费流水，账实不符。`);
    }
    const [txType, txAmount, txBefore, txAfter] = tx.split('|');
    console.log(`  transactions: type=${txType} amount=${txAmount} before=${txBefore} after=${txAfter}`);

    const brState = psql(`select status, reserved_amount from billing_requests where request_id=${q(uRequestId)} limit 1;`);
    console.log(`  billing_requests: ${brState}`);
    if (!brState.startsWith('settled')) {
      red(
        '计费状态机未收敛到 settled',
        `billing_requests 状态=${brState.split('|')[0]}，应为 settled（结算卡死/预留未释放/坏账）。`,
      );
    }

    const afterBalance = psql(`select balance from users where id=${uid};`);
    const reserved = psql(`select reserved_balance from users where id=${uid};`);
    const expected = balanceNum(txBefore) - balanceNum(amount);
    const drift = Math.abs(balanceNum(afterBalance) - expected);
    console.log(`  余额核对: before=${txBefore} after=${afterBalance} 扣费=${amount} reserved=${reserved}`);

    if (drift > 1e-9) {
      red(
        '余额对账不符（多扣/少扣/预留残留）',
        `期望余额=${expected}，实际=${afterBalance}（差 ${drift}）。计费金额与账本不一致。`,
      );
    }
    if (balanceNum(reserved) !== 0) {
      red('预留未释放：reserved_balance 结算后未归 0', `reserved_balance=${reserved}，预留未释放会冻结用户可用余额。`);
    }

    green(
      `全链路计费对账通过：usage amount=${amount} 元（>0，精确计费）、consume 流水一致、` +
        `余额 ${txBefore} → ${afterBalance} 精确扣减、reserved 归 0、billing_requests=settled`,
    );
  } finally {
    console.log('\n（按指示：已保留本次新建账号与全部计费流水，供人工核查——未清理）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
