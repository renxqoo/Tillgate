/**
 * 压测驱动器（scripts/loadtest/run.ts）
 *
 * 闭模型并发（closed-loop）：维持 concurrency 个在途请求，完成一个补一个，直到 total 完成。
 * 正确处理 SSE 流式：流式请求读取到 [DONE] / 流结束才算完成（而非拿到 response header）。
 *
 * 用法：
 *   单场景：tsx scripts/loadtest/run.ts --concurrency 50 --total 500 --stream
 *   全部场景：tsx scripts/loadtest/run.ts --all
 *
 * 环境变量（或 --flag）：
 *   --gateway http://localhost:8787   网关地址
 *   --key ag_...                      压测 api key（默认 seed 的固定 key）
 *   --model mock-gpt                  模型名
 *   --concurrency N                   并发数
 *   --total N                         总请求数
 *   --stream / --no-stream            流式 / 非流式（默认流式）
 *   --warmup N                        预热请求数（默认 5，不计入统计）
 *   --scenario name                   只跑命名场景（配合 --all）
 *   --all                             跑全部预设场景，出对比表
 */
import { Readable } from 'node:stream';

// ---- 参数 ----
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const GATEWAY = arg('gateway', 'http://localhost:8787')!;
const API_KEY = arg('key', 'ag_loadtest_sk_fixed_do_not_use_in_prod')!;
const MODEL = arg('model', 'mock-gpt')!;

// ---- 单请求：发请求并完整读取响应（SSE 流式 → 读到流结束） ----
interface Sample {
  ok: boolean;
  status: number;
  ttfbMs: number; // 首字节时间
  totalMs: number; // 总耗时（流式=流结束）
  bytes: number;
  stream: boolean;
  error?: string;
}

async function oneRequest(stream: boolean, timeoutMs: number): Promise<Sample> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('client timeout')), timeoutMs);
  let ttfbMs = 0;
  let bytes = 0;
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream,
      }),
      signal: controller.signal,
    });
    ttfbMs = Date.now() - start;
    if (!res.body) {
      // 无 body（通常是错误响应）
      const text = await res.text().catch(() => '');
      return {
        ok: res.ok,
        status: res.status,
        ttfbMs,
        totalMs: Date.now() - start,
        bytes: text.length,
        stream,
        error: res.ok ? undefined : text.slice(0, 200),
      };
    }
    // 完整读取流（流式：读 [DONE]；非流式：一次读完）
    // 用 node 的 Readable.fromWeb 把 web stream 转 node stream，逐 chunk 统计字节
    const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream);
    for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
      bytes += chunk.length;
    }
    const totalMs = Date.now() - start;
    return {
      ok: res.ok,
      status: res.status,
      ttfbMs,
      totalMs,
      bytes,
      stream,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (e) {
    const err = e as Error;
    const aborted = err.name === 'AbortError' || /aborted/i.test(err.message);
    return {
      ok: false,
      status: 0,
      ttfbMs: ttfbMs || Date.now() - start,
      totalMs: Date.now() - start,
      bytes,
      stream,
      error: aborted ? 'client_timeout' : err.message.slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 统计工具 ----
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}
function fmtMs(n: number): string {
  return `${n.toFixed(0)}ms`;
}

interface ScenarioResult {
  name: string;
  concurrency: number;
  total: number;
  stream: boolean;
  wallMs: number;
  samples: Sample[];
}

async function runScenario(opts: {
  name: string;
  concurrency: number;
  total: number;
  stream: boolean;
  warmup?: number;
  perRequestTimeoutMs?: number;
}): Promise<ScenarioResult> {
  const { name, concurrency, total, stream } = opts;
  const warmup = opts.warmup ?? 3;
  const timeout = opts.perRequestTimeoutMs ?? 60_000;
  console.log(
    `\n▶ [${name}] concurrency=${concurrency} total=${total} stream=${stream} warmup=${warmup}`,
  );

  // 预热（不计入）
  if (warmup > 0) {
    process.stdout.write(`  warmup (${warmup})...`);
    await Promise.all(Array.from({ length: warmup }, () => oneRequest(stream, timeout)));
    process.stdout.write(' done\n');
  }

  const samples: Sample[] = [];
  let dispatched = 0;
  let completed = 0;
  const wallStart = Date.now();
  const lastProgress = { at: Date.now() };

  // closed-loop worker：完成一个补一个
  async function worker(): Promise<void> {
    while (dispatched < total) {
      const myId = dispatched++;
      const s = await oneRequest(stream, timeout);
      samples[myId] = s;
      completed++;
      if (completed % Math.max(1, Math.floor(total / 10)) === 0 || completed === total) {
        const now = Date.now();
        const rate = completed / ((now - wallStart) / 1000);
        process.stdout.write(`  progress ${completed}/${total} (${rate.toFixed(1)} rps)\n`);
        lastProgress.at = now;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const wallMs = Date.now() - wallStart;
  return { name, concurrency, total, stream, wallMs, samples };
}

function report(r: ScenarioResult): void {
  const ok = r.samples.filter((s) => s.ok);
  const fail = r.samples.filter((s) => !s.ok);
  const totalMs = ok.map((s) => s.totalMs).sort((a, b) => a - b);
  const ttfbMs = ok.map((s) => s.ttfbMs).sort((a, b) => a - b);
  const rps = ok.length / (r.wallMs / 1000);
  const avgBytes = ok.length ? ok.reduce((a, s) => a + s.bytes, 0) / ok.length : 0;

  // 错误分布
  const errDist: Record<string, number> = {};
  for (const s of fail) {
    const k = s.error || `status_${s.status}`;
    errDist[k] = (errDist[k] ?? 0) + 1;
  }

  console.log(`\n┌─ [${r.name}] 结果 ────────────────────────────`);
  console.log(`│ 并发 ${r.concurrency} · ${r.stream ? '流式' : '非流式'} · 总计 ${r.total}`);
  console.log(
    `│ 吞吐      : ${rps.toFixed(1)} rps（${ok.length}/${r.total} 成功，${(r.wallMs / 1000).toFixed(1)}s）`,
  );
  if (ok.length > 0) {
    console.log(
      `│ TTFB      : p50=${fmtMs(percentile(ttfbMs, 50))} p90=${fmtMs(percentile(ttfbMs, 90))} p99=${fmtMs(percentile(ttfbMs, 99))} max=${fmtMs(ttfbMs[ttfbMs.length - 1]!)}`,
    );
    console.log(
      `│ 总耗时    : p50=${fmtMs(percentile(totalMs, 50))} p90=${fmtMs(percentile(totalMs, 90))} p99=${fmtMs(percentile(totalMs, 99))} max=${fmtMs(totalMs[totalMs.length - 1]!)}`,
    );
    console.log(`│ 平均字节  : ${avgBytes.toFixed(0)}`);
  }
  if (fail.length > 0) {
    console.log(`│ ✗ 失败 ${fail.length}（${((fail.length / r.total) * 100).toFixed(1)}%）:`);
    for (const [k, v] of Object.entries(errDist)) {
      console.log(`│    ${k}: ${v}`);
    }
  } else {
    console.log(`│ ✓ 全部成功`);
  }
  console.log(`└─────────────────────────────────────────────`);
}

// ---- 场景编排 ----
interface ScenarioDef {
  name: string;
  concurrency: number;
  total: number;
  stream: boolean;
}
const ALL_SCENARIOS: ScenarioDef[] = [
  { name: 'stream-C10', concurrency: 10, total: 100, stream: true },
  { name: 'stream-C30', concurrency: 30, total: 300, stream: true },
  { name: 'stream-C50', concurrency: 50, total: 500, stream: true },
  { name: 'stream-C100', concurrency: 100, total: 800, stream: true },
  { name: 'nostream-C50', concurrency: 50, total: 500, stream: false },
  { name: 'nostream-C100', concurrency: 100, total: 800, stream: false },
  { name: 'nostream-C200', concurrency: 200, total: 1000, stream: false },
];

async function preflight(): Promise<void> {
  console.log(`preflight: 探活 ${GATEWAY}/healthz ...`);
  try {
    const res = await fetch(`${GATEWAY}/healthz`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    console.log('preflight: gateway ✓');
  } catch (e) {
    console.error(`preflight: gateway ✗ - ${(e as Error).message}`);
    console.error('  请确认 gateway 已启动且 ALLOW_LOCAL_UPSTREAM=true（重启后生效）');
    process.exit(1);
  }
  // 探活 mock 上游
  try {
    // mock-llm 没有直接探活地址，用一次真实请求验证整链
    const s = await oneRequest(false, 15_000);
    if (!s.ok) {
      console.error(`preflight: 整链验证失败 - ${s.error ?? 'HTTP ' + s.status}`);
      console.error(
        '  请确认：1) mock-llm-server 在跑  2) seed-loadtest 已执行  3) gateway 已重启加载 ALLOW_LOCAL_UPSTREAM',
      );
      process.exit(1);
    }
    console.log(`preflight: 整链 ✓ (${s.ttfbMs}ms ttfb, ${s.totalMs}ms total)`);
  } catch (e) {
    console.error(`preflight: 整链异常 - ${(e as Error).message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await preflight();

  if (hasFlag('all')) {
    // 全部场景 + 对比表
    const results: ScenarioResult[] = [];
    let filter = arg('scenario');
    const scenarios = filter ? ALL_SCENARIOS.filter((s) => s.name === filter) : ALL_SCENARIOS;
    if (scenarios.length === 0) {
      console.error(
        `未找到场景：${filter}（可选：${ALL_SCENARIOS.map((s) => s.name).join(', ')}）`,
      );
      process.exit(1);
    }
    for (const sc of scenarios) {
      // 场景间冷却 2s（让限流窗口/熔断器恢复）
      if (results.length > 0) await sleep(2000);
      const r = await runScenario({ ...sc, warmup: 3, perRequestTimeoutMs: 60_000 });
      report(r);
      results.push(r);
    }
    // 汇总对比表
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  并发能力对比汇总');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('场景             | 并发 | 吞吐(rps) | 成功率   | p50    | p90    | p99    | max');
    console.log(
      '-----------------|------|-----------|----------|--------|--------|--------|--------',
    );
    for (const r of results) {
      const ok = r.samples.filter((s) => s.ok);
      const totalMs = ok.map((s) => s.totalMs).sort((a, b) => a - b);
      const rps = ok.length / (r.wallMs / 1000);
      const successRate = ((ok.length / r.total) * 100).toFixed(1) + '%';
      const p50 = ok.length ? fmtMs(percentile(totalMs, 50)) : '-';
      const p90 = ok.length ? fmtMs(percentile(totalMs, 90)) : '-';
      const p99 = ok.length ? fmtMs(percentile(totalMs, 99)) : '-';
      const mx = ok.length ? fmtMs(totalMs[totalMs.length - 1]!) : '-';
      console.log(
        `${r.name.padEnd(16)} | ${String(r.concurrency).padStart(4)} | ${rps.toFixed(1).padStart(9)} | ${successRate.padStart(8)} | ${p50.padEnd(6)} | ${p90.padEnd(6)} | ${p99.padEnd(6)} | ${mx}`,
      );
    }
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(
      '提示：观察 mock-llm-server 终端的「★ 最大并发 in-flight」=网关真实打到上游的并发数',
    );
    return;
  }

  // 单场景
  const concurrency = Number(arg('concurrency', '50'));
  const total = Number(arg('total', '200'));
  const stream = !hasFlag('no-stream');
  const r = await runScenario({
    name: `${stream ? 'stream' : 'nostream'}-C${concurrency}`,
    concurrency,
    total,
    stream,
    warmup: Number(arg('warmup', '5')),
    perRequestTimeoutMs: Number(arg('timeout', '60000')),
  });
  report(r);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('压测失败:', e);
  process.exit(1);
});
