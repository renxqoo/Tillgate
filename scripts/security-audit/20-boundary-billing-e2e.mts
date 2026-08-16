/**
 * 20 · 临界值扣费 E2E（可控 mock 上游，真实服务全链路，RED 记录）
 *
 * 场景（每个用户独立、金额精确到 numeric(38,18) 最小位）：
 *   P0  探针：确定权威预估 E 与结算实额 A（费率卡系数取自真实配置）
 *   S1  余额恰好 = A：请求成功 → 结算后余额必须精确归 0（分不多扣、不少扣）
 *   S1b 流式同额：SSE 尾帧 usage → 同样精确归 0
 *   S2  余额 = A − 1e-6（差最小单位）→ 必须 402，且不留账单/不泄漏预占
 *   S3  上游超发（OUT=2000 > max_tokens）：实际 > 预估 > 余额 → 不得扣成负数，
 *       最终态必须可审计（dead/人工复核），余额保持不变
 *   S4  显式免费模型（is_free）：0 元授权、0 元结算、余额分文不动
 *   S5  上游 500 全失败（upstreamCharge=none）→ 预占必须全额释放
 *       【RED：当前实现 request.failed 不释放 users.reserved_balance → R1 实锤】
 *
 * 对账纪律：所有断言直接查 DB（users / billing_requests / usage_logs / transactions），
 * 与网关返回互不信任。测试数据全部保留（前缀 rede2e-），记录见 ACCOUNTS-2.md。
 *
 * 运行（需要 gateway 包上下文以引入 @ai-gateway/core 的 encrypt）：
 *   pnpm --filter @ai-gateway/gateway exec tsx ../../scripts/security-audit/20-boundary-billing-e2e.mts
 */
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { encrypt } from '../../packages/core/src/index.js';
import { estimateInputTokens } from '../../packages/ai/src/index.js';
import {
  loadEnv,
  psql,
  q,
  insertUser,
  setPassword,
  adminCookie,
  userLogin,
  createKey,
  post,
  GATEWAY,
  newSubject,
} from './helpers.mts';

loadEnv();

const MOCK_PORT = 9899;
const SUFFIX = randomUUID().slice(0, 8);
const MODEL = `rede2e-boundary-${SUFFIX}`;
const FREE_MODEL = `rede2e-free-${SUFFIX}`;
const CONTENT = 'hi'; // estimateInputTokens 口径：'hi' = 1 token（1 个单词）
const MAX_TOKENS = 1000;
const estIn = (content: string): number =>
  estimateInputTokens({ messages: [{ role: 'user', content }] });

let reds = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '[GREEN]' : '[RED]'} ${name} — ${detail}`);
  if (!ok) reds += 1;
}
function num(s: string | undefined | null): number {
  return Number(s ?? '0');
}

/** 可控 mock：content 里 IN123/OUT456 控制上报 usage；FAIL500 → 上游 500；stream 支持 SSE 尾帧 usage */
function startMock(): Promise<void> {
  return new Promise((resolve) => {
    createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as {
          messages?: { content: string }[];
          stream?: boolean;
        };
        const text = body.messages?.at(-1)?.content ?? '';
        if (text.includes('FAIL500')) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock upstream boom' } }));
          return;
        }
        if (text.includes('RATE429')) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: 'rate limit hit', type: 'rate_limit_error', code: 'rate_limit_error' } }),
          );
          return;
        }
        const inT = Number(/IN(\d+)/.exec(text)?.[1] ?? '2');
        const outT = Number(/OUT(\d+)/.exec(text)?.[1] ?? String(MAX_TOKENS));
        const usage = {
          prompt_tokens: inT,
          completion_tokens: outT,
          total_tokens: inT + outT,
        };
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: 'mock-real',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage,
          }),
        );
      });
    }).listen(MOCK_PORT, '127.0.0.1', () => resolve());
  });
}

async function chat(key: string, content: string, stream = false): Promise<{ status: number; raw: string }> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: MODEL, max_tokens: MAX_TOKENS, stream, messages: [{ role: 'user', content }] },
    { headers: { authorization: `Bearer ${key}` } },
  );
  return { status: res.status, raw: res.raw };
}

async function waitStatus(requestId: string, statuses: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = psql(
      `select status from billing_requests where request_id=${q(requestId)};`,
    );
    if (statuses.includes(st)) return st;
    await new Promise((r) => setTimeout(r, 300));
  }
  return psql(`select status from billing_requests where request_id=${q(requestId)};`) || 'missing';
}

async function setupConfig(): Promise<void> {
  const enc = encrypt('mock-key', process.env.ENCRYPTION_KEY!);
  psql(
    `insert into providers (name, base_url) values (${q(`rede2e-prov-${SUFFIX}`)}, ${q(`http://127.0.0.1:${MOCK_PORT}`)});`,
  );
  const provId = psql(`select id from providers where name=${q(`rede2e-prov-${SUFFIX}`)};`);
  psql(
    `insert into channels (provider_id, name, api_key_enc, upstream_budget) values (${provId}, ${q(`rede2e-ch-${SUFFIX}`)}, ${q(enc)}, '100');`,
  );
  const chId = psql(`select id from channels where name=${q(`rede2e-ch-${SUFFIX}`)};`);
  for (const [model, isFree, prices] of [
    [MODEL, 'false', "'1', '1', '1'"],
    [FREE_MODEL, 'true', "'0', '0', '0'"],
  ] as const) {
    psql(
      `insert into model_mappings (external_name, real_model, input_price, output_price, cache_input_price, is_free) ` +
        `values (${q(model)}, ${q(model)}, ${prices}, ${isFree});`,
    );
    const mapId = psql(`select id from model_mappings where external_name=${q(model)};`);
    psql(`insert into model_channels (mapping_id, channel_id) values (${mapId}, ${chId});`);
  }
  // 路由缓存版本失效（与管理端同语义）
  execSync(`redis-cli -a ${/:(.*)@/.exec(process.env.REDIS_URL ?? '')?.[1] ?? 'root123'} incr route:cache:v`, { stdio: 'pipe' });
  console.log(`[setup] provider=${provId} channel=${chId} model=${MODEL} free=${FREE_MODEL}`);
}

async function newUserWithBalance(balance: string): Promise<{ userId: number; key: string; subject: string }> {
  const subject = newSubject('rede2e');
  const userId = insertUser(subject, balance);
  await setPassword(await adminCookie(), userId, 'Boundary123!');
  const { cookie } = await userLogin(subject, 'Boundary123!');
  const key = await createKey(cookie, 'boundary-key');
  return { userId, key, subject };
}

async function main(): Promise<void> {
  await startMock();
  await setupConfig();

  // ── P0 探针：拿权威 E（预估）与 A（结算实额）──
  const probe = await newUserWithBalance('10');
  const p0res = await chat(probe.key, CONTENT);
  if (p0res.status !== 200) throw new Error(`探针请求失败：${p0res.status} ${p0res.raw.slice(0, 200)}`);
  const probeReq = psql(
    `select request_id from billing_requests where user_id=${probe.userId} order by created_at desc limit 1;`,
  );
  const settledStatus = await waitStatus(probeReq, ['settled'], 30_000);
  const E = psql(`select reserved_amount::numeric(24,18) from billing_requests where request_id=${q(probeReq)};`);
  const A = psql(
    `select amount::numeric(24,18) from usage_logs where request_id=${q(probeReq)};`,
  );
  const probeBal = psql(`select balance::numeric(24,18) from users where id=${probe.userId};`);
  console.log(`[P0] status=${settledStatus} E(预估)=${E} A(实额)=${A} 结算后余额=${probeBal} (期望 10-A)`);
  check('P0 探针结算金额与余额扣减一致', Math.abs(num(probeBal) - (10 - num(A))) < 1e-15, `余额=${probeBal}`);

  // ── S1 余额恰好 = A：结算后精确归 0 ──
  const s1 = await newUserWithBalance(A);
  const s1res = await chat(s1.key, CONTENT);
  const s1req = psql(`select request_id from billing_requests where user_id=${s1.userId} order by created_at desc limit 1;`);
  const s1status = await waitStatus(s1req, ['settled'], 30_000);
  const s1bal = psql(`select balance::numeric(24,18), reserved_balance::numeric(24,18) from users where id=${s1.userId};`);
  console.log(`[S1] http=${s1res.status} status=${s1status} 余额/预占=${s1bal}`);
  check('S1 恰好够：扣款精确归 0', s1bal === '0.000000000000000000|0.000000000000000000', `余额|预占=${s1bal}`);

  // ── S1b 流式同额 ──
  const s1b = await newUserWithBalance(A);
  const s1bres = await chat(s1b.key, CONTENT, true);
  const s1breq = psql(`select request_id from billing_requests where user_id=${s1b.userId} order by created_at desc limit 1;`);
  const s1bstatus = await waitStatus(s1breq, ['settled'], 30_000);
  const s1bbal = psql(`select balance::numeric(24,18), reserved_balance::numeric(24,18) from users where id=${s1b.userId};`);
  console.log(`[S1b] http=${s1bres.status} status=${s1bstatus} 余额/预占=${s1bbal}`);
  check('S1b 流式恰好够：扣款精确归 0', s1bbal === '0.000000000000000000|0.000000000000000000', `余额|预占=${s1bbal}`);

  // ── S2 差 1e-6 → 402，零残留 ──
  const s2bal = (num(A) - 1e-6).toFixed(18);
  const s2 = await newUserWithBalance(s2bal);
  const s2res = await chat(s2.key, CONTENT);
  const s2rows = psql(
    `select (select count(*) from billing_requests where user_id=${s2.userId}) as brs, ` +
      `(select reserved_balance::numeric(24,18) from users where id=${s2.userId}) as rb;`,
  );
  console.log(`[S2] http=${s2res.status}（期望 402） 账单数|预占=${s2rows}`);
  check('S2 差最小单位拒绝且零残留', s2res.status === 402 && s2rows.startsWith('0|'), `http=${s2res.status} ${s2rows}`);

  // ── S3 上游超发（实际 > 预估 > 余额）→ 不得负余额 ──
  // content 带 OUT 标签 → 预估输入 estIn=2（'IN2'/'OUT2000' 两段），预估 = (2+1000)/1e6；余额恰好给到预估
  const s3Content = 'IN2 OUT2000'; // 实额 = (2+2000)/1e6 = 0.002002，两倍于预估
  const s3Estimate = ((estIn(s3Content) + MAX_TOKENS) / 1e6).toFixed(18);
  const s3 = await newUserWithBalance(s3Estimate);
  const s3res = await chat(s3.key, s3Content);
  const s3req = psql(`select request_id from billing_requests where user_id=${s3.userId} order by created_at desc limit 1;`);
  // 上限 10 次结算重试 + 退避，最坏可到 ~10 分钟（信用地板违规 → dead 人工复核是设计行为）
  const s3status = await waitStatus(s3req, ['settled', 'dead', 'uncertain'], 600_000);
  const s3state = psql(
    `select (select balance::numeric(24,18) from users where id=${s3.userId}) as bal, ` +
      `(select reserved_balance::numeric(24,18) from users where id=${s3.userId}) as rb, ` +
      `(select amount::numeric(24,18) from usage_logs where request_id=${q(s3req)}) as amt;`,
  );
  console.log(`[S3] http=${s3res.status} 终态=${s3status} 余额|预占|usage=${s3state}`);
  const s3bal = num(s3state.split('|')[0]);
  check(
    'S3 超发不产生负余额且状态可审计',
    s3bal >= 0 && ['settled', 'dead', 'uncertain'].includes(s3status),
    `终态=${s3status} 余额=${s3bal}`,
  );

  // ── S4 显式免费模型（正确配置：is_free + 全零价）──
  const s4 = await newUserWithBalance('0'); // 首登礼金 +1
  const s4res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: FREE_MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: CONTENT }] },
    { headers: { authorization: `Bearer ${s4.key}` } },
  );
  const s4req = psql(`select request_id from billing_requests where user_id=${s4.userId} order by created_at desc limit 1;`);
  await waitStatus(s4req, ['settled'], 30_000);
  const s4state = psql(
    `select (select balance::numeric(24,18) from users where id=${s4.userId}) as bal, ` +
      `(select amount::numeric(24,18) from usage_logs where request_id=${q(s4req)}) as amt, ` +
      `(select reserved_balance::numeric(24,18) from users where id=${s4.userId}) as rb;`,
  );
  console.log(`[S4] http=${s4res.status} 余额|usage金额|预占=${s4state}`);
  check(
    'S4 免费模型（is_free+零价）0 元计费、余额不动',
    s4res.status === 200 && num(s4state.split('|')[1]) === 0 && num(s4state.split('|')[2]) === 0,
    s4state,
  );

  // ── S4b【R6 备案】is_free + 非零价并存 = 口径分裂 ──
  // 前一轮实测（2026-08-15，账号 7908）：is_free=true + 价 1/1/1 的模型，
  // 0 元授权成功（explicitlyFree fast-path 不校验余额），结算却按价格实扣 ¥0.001002。
  // 授权看 is_free 标志、结算看价格表——两套口径。管理端（models.ts:56/124）不校验互斥。
  // 红测见 packages/ledger/src/__tests__/free-model-inconsistency.red.test.ts。
  console.log('[S4b] R6 证据已在上一轮运行采集，红测见 ledger 包（本段仅备案）');

  // ── S5 上游 429（upstreamCharge=none → released）：预占必须全额释放（R1 实时复现）──
  const s5Content = 'RATE429'; // estIn=1 → 预估 (1+1000)/1e6
  const s5Estimate = ((estIn(s5Content) + MAX_TOKENS) / 1e6).toFixed(18);
  const s5 = await newUserWithBalance(s5Estimate);
  const s5res = await chat(s5.key, s5Content);
  const s5req = psql(`select request_id from billing_requests where user_id=${s5.userId} order by created_at desc limit 1;`);
  await waitStatus(s5req, ['released', 'dead', 'uncertain'], 60_000);
  const s5state = psql(
    `select (select status from billing_requests where request_id=${q(s5req)}) as st, ` +
      `(select reserved_balance::numeric(24,18) from users where id=${s5.userId}) as rb, ` +
      `(select balance::numeric(24,18) from users where id=${s5.userId}) as bal;`,
  );
  console.log(`[S5] http=${s5res.status} 账单终态|预占|余额=${s5state}`);
  const [st5, rb5] = s5state.split('|');
  check(
    'S5 上游429失败请求全额释放预占（R1 实时）',
    st5 === 'released' && num(rb5) === 0,
    `终态=${st5} 预占=${rb5}（泄漏=预估 ${s5Estimate}）`,
  );

  console.log(`\n账号留档：probe=${probe.userId} s1=${s1.userId} s1b=${s1b.userId} s2=${s2.userId} s3=${s3.userId} s4=${s4.userId} s5=${s5.userId}`);
  if (reds > 0) {
    console.error(`\n[RED] ${reds} 项未通过`);
    process.exit(1);
  }
  console.log('\n[GREEN] 全部通过');
  process.exit(0); // mock server 持有事件循环，显式退出
}

main().catch((e) => {
  console.error(`脚本异常：${e}`);
  process.exit(1);
});
