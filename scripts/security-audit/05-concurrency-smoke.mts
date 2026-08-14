/**
 * 测试 05：并发鲁棒性 / 容量冒烟（会被并发弄崩溃吗？能支持多少并发？）
 *
 * 这不是「复现某处代码 bug」的报红用例，而是对运行中的单实例 gateway 做并发冒烟：
 *   - 并发打 /v1/models（有效 Key，走鉴权缓存 + 模型列表缓存，不触上游、无真实模型消耗）
 *   - 并发打 /v1/chat/completions（随机无效 Key → 401，压鉴权 + 爆破防护 + 请求日志路径）
 *   - 结束后探测 /readyz 是否仍健康
 *
 * 报红条件（=发现并发/崩溃问题）：
 *   - 任一阶段 5xx 比例 > 1%（网关开始崩/过载）
 *   - 结束后 /readyz 非 200（网关被压垮未恢复）
 * 报告实测吞吐（req/s）、P50/P95/P99 延迟，供「能支持多少并发」参考。
 *
 * 注意：单实例 + 本机开发库，数值是容量下限参考，不等于生产多副本容量。
 * 环境关键参数：GATEWAY_MAX_CONNECTIONS=10000、undici 每源连接池 2048、全局 RPM 默认 2000。
 *
 * 运行：pnpm tsx scripts/security-audit/05-concurrency-smoke.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
  userLogin,
  createKey,
  get,
  GATEWAY,
  newSubject,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

const MODELS_CONCURRENCY = 50;
const MODELS_TOTAL = 600;
const AUTH_CONCURRENCY = 50;
const AUTH_TOTAL = 300;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** 简单并发池：跑完所有 task，返回每项结果 */
async function runPool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  console.log('🧪 测试 05：并发鲁棒性 / 容量冒烟');
  console.log(`   gateway: ${GATEWAY}`);

  const admin = await adminCookie();
  const subject = newSubject('conc');
  const password = 'ConcPass123!';
  let uid: number | null = null;

  try {
    section('准备：创建账号 + 有效 Key');
    uid = insertUser(subject);
    await setPassword(admin, uid, password);
    const { cookie } = await userLogin(subject, password);
    const key = await createKey(cookie);
    green(`账号 ${subject} (id=${uid})，Key=${key.slice(0, 8)}...`);

    // 预热鉴权缓存与模型列表缓存
    await get(`${GATEWAY}/v1/models`, { headers: { authorization: `Bearer ${key}` } });

    section(`阶段 1：并发 ${MODELS_CONCURRENCY} 打 /v1/models 共 ${MODELS_TOTAL} 次`);
    let t0 = Date.now();
    const modelsLat: number[] = [];
    const modelsStatus: Record<string, number> = {};
    await runPool(
      Array.from({ length: MODELS_TOTAL }, () => async () => {
        const s = Date.now();
        const res = await fetch(`${GATEWAY}/v1/models`, {
          headers: { authorization: `Bearer ${key}` },
        });
        modelsLat.push(Date.now() - s);
        const code = String(res.status);
        modelsStatus[code] = (modelsStatus[code] ?? 0) + 1;
        await res.arrayBuffer();
      }),
      MODELS_CONCURRENCY,
    );
    const modelsMs = Date.now() - t0;
    console.log(
      `   /v1/models: 状态=${JSON.stringify(modelsStatus)} 吞吐=${((MODELS_TOTAL / modelsMs) * 1000).toFixed(0)} req/s ` +
        `P50=${percentile(modelsLat.sort((a, b) => a - b), 50)}ms P95=${percentile(modelsLat, 95)}ms P99=${percentile(modelsLat, 99)}ms`,
    );

    section(`阶段 2：并发 ${AUTH_CONCURRENCY} 打 /v1/chat/completions（随机无效 Key → 401）共 ${AUTH_TOTAL} 次`);
    t0 = Date.now();
    const authLat: number[] = [];
    const authStatus: Record<string, number> = {};
    let counter = 0;
    await runPool(
      Array.from({ length: AUTH_TOTAL }, () => async () => {
        const s = Date.now();
        const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ag_invalid_${Date.now()}_${counter++}`,
          },
          body: JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'x' }] }),
        });
        authLat.push(Date.now() - s);
        const code = String(res.status);
        authStatus[code] = (authStatus[code] ?? 0) + 1;
        await res.arrayBuffer();
      }),
      AUTH_CONCURRENCY,
    );
    const authMs = Date.now() - t0;
    console.log(
      `   401 路径: 状态=${JSON.stringify(authStatus)} 吞吐=${((AUTH_TOTAL / authMs) * 1000).toFixed(0)} req/s ` +
        `P50=${percentile(authLat.sort((a, b) => a - b), 50)}ms P95=${percentile(authLat, 95)}ms`,
    );

    section('阶段 3：压测后健康检查');
    const ready = await get(`${GATEWAY}/readyz`);
    console.log(`   /readyz → ${ready.status} ${JSON.stringify(ready.body)}`);

    const fivexx =
      (modelsStatus['500'] ?? 0) +
      (modelsStatus['502'] ?? 0) +
      (modelsStatus['503'] ?? 0) +
      (modelsStatus['504'] ?? 0) +
      (authStatus['500'] ?? 0) +
      (authStatus['502'] ?? 0) +
      (authStatus['503'] ?? 0) +
      (authStatus['504'] ?? 0);
    const total = MODELS_TOTAL + AUTH_TOTAL;

    if (fivexx / total > 0.01 || ready.status !== 200) {
      red(
        '并发压测出现 5xx 超阈值或网关未恢复 → 并发鲁棒性问题',
        `5xx 比例=${((fivexx / total) * 100).toFixed(2)}%（>1%），或 /readyz=${ready.status}。` +
          `说明在 ${MODELS_CONCURRENCY}/${AUTH_CONCURRENCY} 并发下网关出现崩溃/过载迹象。`,
      );
    }
    green(`并发冒烟通过：5xx 比例 ${((fivexx / total) * 100).toFixed(2)}%，压测后 /readyz=${ready.status} 健康`);
    console.log(`\n   📊 单实例容量参考（开发库）：/v1/models 约 ${((MODELS_TOTAL / modelsMs) * 1000).toFixed(0)} req/s，`);
    console.log(`      （真实对话接口受上游 MiniMax 延迟与计费授权支配，吞吐另行压测）`);
  } finally {
    console.log('\n（按指示：已保留本次新建账号与流水，供人工核查——未清理）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
