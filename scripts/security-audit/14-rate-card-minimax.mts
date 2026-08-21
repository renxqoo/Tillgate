/**
 * 测试 14：费率卡（rate card）端到端功能——真实 MiniMax-M3。
 *
 * 测什么：
 *   费率卡定价模型「用户价 = 官方价 × 费率卡系数」是否真的贯穿到结算：
 *     1. 管理员建一张系数 2.0 的费率卡（POST /api/admin/rate-cards）
 *     2. 绑到新用户（PATCH /api/admin/users/:id { rateCardId }）
 *     3. 用该用户的 Key 真实调 MiniMax-M3（对照账号用「标准」系数 1.0）
 *     4. 等 worker 结算后核对：
 *        - usage_logs.coefficient 快照正确（测试=2.000，对照=1.000）
 *        - usage_logs.amount 精确 = (input×输入价 + cached×缓存价 + output×输出价)/1e6 × 系数
 *        - transactions 扣费流水金额 = -amount；balance 精确减少；reserved 归 0
 *        - 相同 token 用量下，2.0 卡的实扣金额 ≈ 1.0 卡的 2 倍
 *
 * 报红条件（=费率卡未生效/系数错套/价格错算）：系数快照不是 2.000、amount 与公式不符、
 *   ratio 不≈2、余额对账不符。
 * 真实模型只用 MiniMax-M3（官方价：input 2.1 / output 8.4 / cache 0.42 元/百万）。
 *
 * 运行：pnpm tsx scripts/security-audit/14-rate-card-minimax.mts
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
  cleanupUser,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

const MODEL = 'MiniMax-M3';
const COEFF_TEST = 2.0; // 测试卡系数

function num(s: string): number {
  return Number(s);
}

/** usage_logs 公式复算：amount = (uncached×输入价 + cached×缓存价 + output×输出价)/1e6 × 系数 */
function calcExpected(
  inTok: number,
  cached: number,
  outTok: number,
  inPrice: number,
  cachePrice: number,
  outPrice: number,
  coeff: number,
): number {
  const uncached = Math.max(0, inTok) - Math.min(Math.max(0, cached), Math.max(0, inTok));
  const base = inPrice * uncached + cachePrice * Math.min(Math.max(0, cached), Math.max(0, inTok)) + outPrice * Math.max(0, outTok);
  return (base / 1_000_000) * coeff;
}

async function waitUsage(userId: number, maxSec = 25): Promise<string | null> {
  for (let i = 0; i < maxSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const row = psql(
      `select input_tokens, cached_input_tokens, output_tokens, input_price, output_price, cache_input_price, coefficient, amount, calculated_amount from usage_logs where user_id=${userId} order by id desc limit 1;`,
    );
    if (row) return row;
  }
  return null;
}

async function main(): Promise<void> {
  console.log('🧪 测试 14：费率卡端到端（真实 MiniMax-M3）');
  console.log(`   gateway: ${GATEWAY} | 模型: ${MODEL}（官方价 input=2.1 / output=8.4 / cache=0.42 元/百万）`);

  const admin = await adminCookie();
  const cardName = `费率卡测试-${COEFF_TEST}x-${Date.now()}`;
  let cardId: number | null = null;
  let ctrlUid: number | null = null;
  let testUid: number | null = null;

  try {
    section('① 管理员创建系数 2.0 费率卡');
    const create = await post(
      `${ADMIN_API}/api/admin/rate-cards`,
      { name: cardName, coefficient: COEFF_TEST, description: 'E2E 费率卡测试' },
      { cookie: admin },
    );
    console.log(`  POST /rate-cards → ${create.status} ${JSON.stringify(create.body)}`);
    if (create.status !== 201) throw new Error(`创建费率卡失败: ${create.status} ${create.raw.slice(0, 300)}`);
    cardId = (create.body as { id: number }).id;
    const createdCoeff = (create.body as { coefficient: string }).coefficient;
    if (createdCoeff !== '2.000') {
      red('费率卡创建后 global 系数不对', `期望 '2.000'，实际 '${createdCoeff}'`);
    }
    green(`费率卡已创建 id=${cardId}，global 系数=${createdCoeff}`);

    section('② 建两个账号：对照（标准 1.0）与测试（2.0 卡）');
    const ctrlSubject = newSubject('ratecard-ctrl');
    const testSubject = newSubject('ratecard-2x');
    const password = 'RateCard123!';
    ctrlUid = insertUser(ctrlSubject, '1');
    testUid = insertUser(testSubject, '1');
    await setPassword(admin, ctrlUid, password);
    await setPassword(admin, testUid, password);

    // 测试账号绑 2.0 卡
    const bind = await patch(
      `${ADMIN_API}/api/admin/users/${testUid}`,
      { rateCardId: cardId },
      { cookie: admin },
    );
    if (bind.status !== 200) throw new Error(`绑定费率卡失败: ${bind.status} ${bind.raw.slice(0, 300)}`);
    const dbRateCardId = psql(`select rate_card_id from users where id=${testUid};`);
    green(`测试账号 (id=${testUid}) 已绑费率卡 id=${dbRateCardId}；对照账号 (id=${ctrlUid}) 保持「标准」1.0`);

    const ctrlLogin = await userLogin(ctrlSubject, password);
    const testLogin = await userLogin(testSubject, password);
    const ctrlKey = await createKey(ctrlLogin.cookie, 'ratecard-ctrl');
    const testKey = await createKey(testLogin.cookie, 'ratecard-2x');

    section('③ 真实调用 MiniMax-M3（两个账号，相同 prompt，max_tokens=8）');
    const prompt = { model: MODEL, messages: [{ role: 'user', content: '只回复两个字：你好' }], max_tokens: 8 };
    const ctrlRes = await post(`${GATEWAY}/v1/chat/completions`, prompt, { headers: { authorization: `Bearer ${ctrlKey}` } });
    const testRes = await post(`${GATEWAY}/v1/chat/completions`, prompt, { headers: { authorization: `Bearer ${testKey}` } });
    console.log(`  对照(1.0) → ${ctrlRes.status}；测试(2.0) → ${testRes.status}`);
    if (ctrlRes.status !== 200) throw new Error(`对照调用失败: ${ctrlRes.status} ${ctrlRes.raw.slice(0, 300)}`);
    if (testRes.status !== 200) throw new Error(`测试调用失败: ${testRes.status} ${testRes.raw.slice(0, 300)}`);

    section('④ 等 worker 结算，核对系数快照与金额公式');
    const ctrlRow = await waitUsage(ctrlUid);
    const testRow = await waitUsage(testUid);
    if (!ctrlRow) red('对照账号 25s 内未结算（usage_logs 缺失）', `user=${ctrlUid} 无 usage_logs`);
    if (!testRow) red('测试账号 25s 内未结算（usage_logs 缺失）', `user=${testUid} 无 usage_logs`);

    const c = ctrlRow!.split('|').map(num);
    const t = testRow!.split('|').map(num);
    // 顺序：input, cached, output, inPrice, outPrice, cachePrice, coeff, amount, calculated
    console.log(`  对照: input=${c[0]} cached=${c[1]} output=${c[2]} coeff=${c[6]} amount=${c[7]}`);
    console.log(`  测试: input=${t[0]} cached=${t[1]} output=${t[2]} coeff=${t[6]} amount=${t[7]}`);

    if (c[6] !== 1.0) red('对照账号系数快照错误', `期望 1.000，实际 ${c[6]}（标准卡）`);
    if (t[6] !== 2.0) red('费率卡未生效：测试账号系数快照不是 2.000', `实际 ${t[6]}。根因：鉴权系数未按绑定卡下发/缓存旧值`);
    green(`系数快照正确：对照=${c[6]}，测试=${t[6]}`);

    // 列序：input,cached,output,inPrice,outPrice,cachePrice,coeff,amount；函数签名 cachePrice 在 outPrice 前
    const cExpected = calcExpected(c[0], c[1], c[2], c[3], c[5], c[4], c[6]);
    const tExpected = calcExpected(t[0], t[1], t[2], t[3], t[5], t[4], t[6]);
    const tDrift = Math.abs(tExpected - t[7]);
    const tRel = tExpected !== 0 ? tDrift / Math.abs(tExpected) : tDrift;
    if (tRel > 1e-9) {
      red(
        '费率卡金额与公式不符',
        `测试账号 amount=${t[7]}，公式复算=${tExpected}（相对误差 ${tRel}）。系数未正确参与计费。`,
      );
    }
    green(`测试账号金额公式复算通过：amount=${t[7]} ≈ 期望 ${tExpected}（input ${t[0]}×${t[3]} + output ${t[2]}×${t[5]}）/1e6 × ${t[6]}`);

    // 比率：token 完全相同时应 ≈ 2.0
    const sameTokens = c[0] === t[0] && c[1] === t[1] && c[2] === t[2];
    if (sameTokens && c[7] !== 0) {
      const ratio = t[7] / c[7];
      console.log(`  金额比率（同 token）: ${t[7]} / ${c[7]} = ${ratio}`);
      if (Math.abs(ratio - COEFF_TEST) > 0.01) {
        red('费率卡系数未等比生效', `同 token 下 2.0 卡 / 1.0 卡金额比=${ratio}，应 ≈ 2.0`);
      }
      green(`比率校验通过：2.0 卡实扣 = 1.0 卡的 ${ratio}×（≈2×）`);
    } else {
      console.log(`  token 用量不同（对照 input=${c[0]}/output=${c[2]} vs 测试 input=${t[0]}/output=${t[2]}），跳过比率断言，改用公式断言`);
    }

    section('⑤ 核对测试账号账本（consume 流水 + 余额）');
    const tx = psql(`select type, amount, balance_before, balance_after from transactions where user_id=${testUid} and type='consume' order by id desc limit 1;`);
    if (!tx) red('测试账号缺 consume 流水', `user=${testUid} usage 已落库但无扣费流水`);
    const [txType, txAmountStr, txBeforeStr, txAfterStr] = tx.split('|');
    const txAmount = num(txAmountStr);
    const txBefore = num(txBeforeStr);
    const txAfter = num(txAfterStr);
    const balance = num(psql(`select balance from users where id=${testUid};`));
    const reserved = num(psql(`select reserved_balance from users where id=${testUid};`));
    console.log(`  transactions: type=${txType} amount=${txAmount} before=${txBefore} after=${txAfter}`);
    console.log(`  余额核对: balance=${balance} reserved=${reserved}`);

    if (Math.abs(txAmount + t[7]) > 1e-9) red('consume 流水与 usage amount 不一致', `流水=${txAmount}，usage=${t[7]}`);
    if (Math.abs(balance - (txBefore - t[7])) > 1e-9) red('余额对账不符', `期望 ${txBefore - t[7]}，实际 ${balance}`);
    if (reserved !== 0) red('预留未释放', `reserved_balance=${reserved}，结算后应归 0`);
    green(`账本对账通过：consume -${t[7]} 元、余额 ${txBefore} → ${balance}、reserved=0`);

    console.log('\n✅ 费率卡功能正常：创建→绑定→鉴权系数→计费公式→结算→账本 全链路正确（2.0 卡按官方价 ×2 计费）');
  } finally {
    // 清理：删测试用户（解除绑卡）→ 删测试费率卡
    if (testUid) {
      cleanupUser(testUid);
      cleanupUser(ctrlUid!);
    }
    if (cardId) {
      const res = await fetch(`${ADMIN_API}/api/admin/rate-cards/${cardId}`, {
        method: 'DELETE',
        headers: { cookie: admin },
      });
      console.log(`  （清理）删除测试费率卡 id=${cardId} → ${res.status}`);
    }
    console.log('（测试账号与费率卡已清理）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
