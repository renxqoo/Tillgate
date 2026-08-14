/**
 * 测试 13：Key 级每日花费上限（团队团员单 Key 封顶）。
 *
 * 场景：
 *   1) 给某把 Key 设 dailySpendLimit=0 → 任意请求应 402 daily_spend_limit_exceeded（scope=key）。
 *   2) 恢复 null（不限）→ 请求正常 200（证明 null=不限，非误伤）。
 *
 * 真实 deepseek-v4-flash（成本极低）。新建账号，全部走真实登录 + 真实接口。
 * 按指示保留账号与流水，不清理。
 *
 * 运行：pnpm tsx scripts/security-audit/13-key-daily-spend-limit.mts
 */
import { createHash } from 'node:crypto';
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

const MODEL = 'deepseek-v4-flash';

async function chat(key: string): Promise<{ http: number; body: any; requestId: string | null }> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: MODEL, messages: [{ role: 'user', content: '只回复两个字：你好' }], max_tokens: 8 },
    { headers: { authorization: `Bearer ${key}` } },
  );
  return { http: res.status, body: res.body, requestId: res.headers.get('x-request-id') };
}

/** 明文 Key → api_keys.id（key_hash = SHA-256(完整 Key)） */
function keyIdByHash(plainKey: string): number {
  const hash = createHash('sha256').update(plainKey).digest('hex');
  const id = psql(`select id from api_keys where key_hash=${q(hash)};`);
  if (!id) throw new Error(`未找到 key（hash=${hash}）`);
  return Number(id.split('|')[0]);
}

async function main(): Promise<void> {
  console.log('🧪 测试 13：Key 级每日花费上限（团队团员单 Key 封顶）');
  console.log(`   gateway: ${GATEWAY} | 模型: ${MODEL}（真实）`);

  const admin = await adminCookie();
  const subject = newSubject('key-dailyspend');
  const password = 'KeyDaily123!';

  try {
    section('准备：建账号（余额 ¥5）→ 设密码 → 登录 → 建 Key');
    const uid = insertUser(subject, '5');
    await setPassword(admin, uid, password);
    const { cookie } = await userLogin(subject, password);
    const key = await createKey(cookie, 'team-member');
    const keyId = keyIdByHash(key);
    green(`账号 ${subject} (id=${uid})，Key id=${keyId}`);

    // ============ 场景 1：dailySpendLimit=0 → 402（scope=key） ============
    section('场景 1：Key dailySpendLimit=0 → 任意请求 402');
    const set0 = await patch(
      `${ADMIN_API}/api/admin/keys/${keyId}`,
      { dailySpendLimit: 0 },
      { cookie: admin },
    );
    if (set0.status !== 200) throw new Error(`设 Key dailySpendLimit=0 失败: ${set0.status}`);
    green('已通过 admin-api PATCH /keys/:id 设 dailySpendLimit=0');

    const r0 = await chat(key);
    console.log(`   chat → HTTP ${r0.http}，body=${JSON.stringify(r0.body)}`);
    const err0 = (r0.body as any)?.error as Record<string, any> | undefined;
    if (r0.http !== 402 || err0?.code !== 'daily_spend_limit_exceeded') {
      red('Key 每日花费上限未生效', `HTTP ${r0.http}（应为 402 daily_spend_limit_exceeded）`);
    }
    const msg0 = String(err0?.message ?? '');
    if (!msg0.includes('该 Key')) {
      red('402 消息未区分 Key 维度', `message=${msg0}（应包含「该 Key」）`);
    }
    green(`402 拦截正确，消息区分 Key 维度：${msg0}`);

    // ============ 场景 2：恢复 null → 200 ============
    section('场景 2：恢复 dailySpendLimit=null（不限）→ 200');
    const setNull = await patch(
      `${ADMIN_API}/api/admin/keys/${keyId}`,
      { dailySpendLimit: null },
      { cookie: admin },
    );
    if (setNull.status !== 200) throw new Error(`恢复 dailySpendLimit=null 失败: ${setNull.status}`);
    const r1 = await chat(key);
    console.log(`   chat → HTTP ${r1.http}`);
    if (r1.http !== 200) {
      red('恢复 null 后仍被拦截', `HTTP ${r1.http}（应为 200）`);
    }
    green('恢复 null 后正常放行');

    // 校验 admin-api 列表回显 dailySpendLimit
    const list = await import('./helpers.mts').then((h) =>
      h.get(`${ADMIN_API}/api/admin/keys?page_size=100`, { cookie: admin }),
    );
    const row = ((list.body as any)?.list ?? []).find((k: any) => k.id === keyId);
    console.log(
      `   admin keys 列表回显: dailySpendLimit=${'dailySpendLimit' in (row ?? {}) ? String(row.dailySpendLimit) : '(缺字段)'}`,
    );
    if (row && 'dailySpendLimit' in row === false) {
      red('admin keys 列表缺少 dailySpendLimit 字段', JSON.stringify(row));
    }
    if (row && row.dailySpendLimit !== null) {
      red('admin keys 列表 dailySpendLimit 回显错误', `=${row.dailySpendLimit}（应为 null）`);
    }
    green('Key 级每日花费上限 E2E 全部通过');
  } finally {
    console.log('\n（按指示：已保留本次新建账号与 Key，未清理）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
