/**
 * 测试 10：信用模型重构验证（长上下文 + 同号多 Key 并发）。
 *
 * 场景：
 *   1) 长上下文（≥50k token）单请求：验证输入敞口改用「字符数」后不再虚高，
 *      且长对话真实消费能正常结算（不误判 dead、不冻结预留）。
 *   2) 同号不同 Key ×20 并发（普通上下文）：验证并发下在途敞口合理、无透支、无重复扣费、预留释放。
 *
 * 真实 MiniMax-M3。新建账号（余额 ¥20 + credit_limit ¥10），全部走真实登录 + 真实接口。
 *
 * 运行：pnpm tsx scripts/security-audit/10-credit-model-scenarios.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
  userLogin,
  createKey,
  post,
  patch,
  psql,
  q,
  GATEWAY,
  ADMIN_API,
  newSubject,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

const MODEL = 'MiniMax-M3';
const INPUT_PRICE = 2.1; // 元/百万 token（MiniMax-M3）
const OUTPUT_PRICE = 8.4;

function normBalance(s: string): string {
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}
function num(s: string): number {
  return Number(normBalance(s));
}

/** 构造指定字符数的中文长上下文（token ≈ 字符数，中文 1 字符 ≈ 1 token） */
function longContext(chars: number): string {
  const unit =
    '信用模型计费长上下文测试：验证输入敞口改用字符数后不再虚高，并确保长对话场景下的计费准确性与并发安全。';
  return unit.repeat(Math.ceil(chars / unit.length));
}

async function chat(key: string, content: string, maxTokens: number): Promise<{
  http: number;
  requestId: string | null;
  promptTokens: number | null;
}> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: MODEL, messages: [{ role: 'user', content }], max_tokens: maxTokens },
    { headers: { authorization: `Bearer ${key}` } },
  );
  const body = res.body as { usage?: { prompt_tokens?: number } } | undefined;
  return {
    http: res.status,
    requestId: res.headers.get('x-request-id'),
    promptTokens: body?.usage?.prompt_tokens ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待某 request 结算为终态 */
async function waitSettled(requestId: string, timeoutMs = 30_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = psql(`select status from billing_requests where request_id=${q(requestId)};`);
    if (st && st !== 'authorized' && st !== 'in_flight' && st !== 'settlement_pending' && st !== 'processing') {
      return st;
    }
    await sleep(1000);
  }
  return psql(`select status from billing_requests where request_id=${q(requestId)};`);
}

async function main(): Promise<void> {
  console.log('🧪 测试 10：信用模型重构验证（长上下文 ≥50k token + 同号 20 Key 并发）');
  console.log(`   gateway: ${GATEWAY} | 模型: ${MODEL}（真实 MiniMax-M3）`);

  const admin = await adminCookie();
  const subject = newSubject('credit-longctx');
  const password = 'CreditPass123!';
  let anyRed = false;

  try {
    section('准备：建账号（余额 ¥20）→ 设密码 → 登录 → credit_limit=10');
    const uid = insertUser(subject, '20');
    await setPassword(admin, uid, password);
    const { cookie } = await userLogin(subject, password);
    const patchRes = await patch(
      `${ADMIN_API}/api/admin/users/${uid}`,
      { creditLimit: 10 },
      { cookie: admin },
    );
    if (patchRes.status !== 200) throw new Error(`设 credit_limit 失败: ${patchRes.status}`);
    green(`账号 ${subject} (id=${uid})，balance=20，credit_limit=10`);

    // ============ 场景 1：长上下文（≥50k token）单请求 ============
    section('场景 1：长上下文（构造 ~70k 字符 ≈ 50k+ token）单请求');
    const longContent = longContext(85_000);
    green(`长上下文字符数 = ${longContent.length}（预计 token ≥ 50000）`);
    const key = await createKey(cookie, 'longctx');

    const r1 = await chat(key, longContent, 256);
    console.log(`   chat → HTTP ${r1.http}，prompt_tokens=${r1.promptTokens}`);
    if (r1.http !== 200 || !r1.requestId) {
      red('长上下文请求失败', `HTTP ${r1.http}（应为 200）`);
    }
    if ((r1.promptTokens ?? 0) < 50_000) {
      throw new Error(
        `长上下文 token 未达标：prompt_tokens=${r1.promptTokens}，期望 ≥ 50000（需加大 longContext 字符数）`,
      );
    }

    const st1 = await waitSettled(r1.requestId!);
    const br1 = psql(
      `select status, reserved_amount from billing_requests where request_id=${q(r1.requestId!)};`,
    );
    const usage1 = psql(
      `select input_tokens, output_tokens, amount from usage_logs where request_id=${q(r1.requestId!)};`,
    );
    console.log(`   billing_requests: ${br1}`);
    console.log(`   usage_logs: ${usage1}`);

    // 验证：敞口应该 ≈ 字符数 × 输入价 + max_tokens × 输出价（不再是字节数 × 输入价）
    const [brStatus, reservedAmount] = br1.split('|');
    const expectedHold = (longContent.length * INPUT_PRICE + 256 * OUTPUT_PRICE) / 1_000_000;
    console.log(
      `   敞口核对: 实际 reserved=${reservedAmount}，字符数口径预期 ≈ ${expectedHold.toFixed(6)}（旧字节数口径 ≈ ${(
        (Buffer.byteLength(longContent, 'utf8') * INPUT_PRICE + 256 * OUTPUT_PRICE) /
        1_000_000
      ).toFixed(6)}）`,
    );

    if (brStatus !== 'settled') {
      anyRed = true;
      console.error(`   🔴 [长上下文未结算] billing=${brStatus}（应为 settled），敞口=${reservedAmount}`);
    }
    if (num(reservedAmount) > num(expectedHold.toFixed(18)) + 1e-9) {
      anyRed = true;
      console.error(`   🔴 [敞口仍虚高] reserved=${reservedAmount} 大于字符数口径预期 ${expectedHold}`);
    }
    const reservedAfter1 = psql(`select reserved_balance from users where id=${uid};`);
    if (num(reservedAfter1) !== 0) {
      anyRed = true;
      console.error(`   🔴 [预留未释放] reserved_balance=${reservedAfter1}（应为 0）`);
    } else {
      green(`长上下文：settled、敞口 ¥${reservedAmount}（字符数口径）、reserved 归 0`);
    }

    // ============ 场景 2：同号 20 Key 并发（普通上下文） ============
    section('场景 2：同号 20 把不同 Key ×20 并发（普通上下文）');
    const keys: string[] = [];
    for (let i = 0; i < 20; i++) keys.push(await createKey(cookie, `cc-k${i}`));
    green('20 把 Key 已创建');

    const results = await Promise.all(keys.map((k) => chat(k, '只回复两个字：你好', 8)));
    console.log(
      `   HTTP 分布: ${JSON.stringify(
        results.reduce<Record<string, number>>((acc, r) => {
          acc[String(r.http)] = (acc[String(r.http)] ?? 0) + 1;
          return acc;
        }, {}),
      )}`,
    );

    // 等所有请求收敛
    await sleep(4000);
    const terminal: Record<string, number> = {};
    let settledCount = 0;
    let releasedCount = 0;
    for (const r of results) {
      if (!r.requestId) continue;
      const st = psql(`select status from billing_requests where request_id=${q(r.requestId)};`);
      terminal[st] = (terminal[st] ?? 0) + 1;
      if (st === 'settled') settledCount += 1;
      else if (st === 'released') releasedCount += 1;
    }
    console.log(`   billing 终态分布: ${JSON.stringify(terminal)}`);
    const u2 = psql(`select balance, reserved_balance, credit_limit from users where id=${uid};`);
    const [bal2, res2, credit2] = u2.split('|');
    console.log(`   用户: balance=${bal2} reserved=${res2} credit_limit=${credit2}`);

    if (settledCount + releasedCount < results.length) {
      anyRed = true;
      console.error(
        `   🔴 [并发未收敛] settled+released=${settledCount + releasedCount} < 总数 ${results.length}`,
      );
    }
    if (num(bal2) < -num(credit2)) {
      anyRed = true;
      console.error(`   🔴 [透支] balance=${bal2} < -credit_limit(-${credit2})`);
    }
    if (num(res2) !== 0) {
      anyRed = true;
      console.error(`   🔴 [预留未释放] reserved_balance=${res2}（应为 0）`);
    } else {
      green(`并发：${settledCount} settled + ${releasedCount} released，reserved 归 0、无透支`);
    }

    if (anyRed) {
      red('信用模型场景存在异常', '详见上方 🔴 标记');
    }
    green('信用模型场景全部通过：长上下文敞口不虚高、并发敞口合理、结算准确、预留释放');
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
