/**
 * live-fire 测试装置核心:用例注册与断言、HTTP/SSE 助手、轮询、报告汇总。
 * 目标是「攻击者视角的红队报告」:pass = 防守成立;fail = 发现(潜在缺陷);
 * skip = 环境依赖未满足而跳过。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from '@tillgate/billing';

export class CaseFail extends Error {}

export function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new CaseFail(msg);
}

export function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new CaseFail(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function eqDec(actual: string | number, expected: string | number, msg: string) {
  if (!new Decimal(String(actual)).eq(new Decimal(String(expected)))) {
    throw new CaseFail(`${msg}: expected ${expected}, got ${actual}`);
  }
}

export function between(x: number, lo: number, hi: number, msg: string) {
  if (!(x >= lo && x <= hi)) throw new CaseFail(`${msg}: ${x} not in [${lo}, ${hi}]`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回非 null;超时抛错(label 进消息) */
export async function poll<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
  intervalMs = 250,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v != null) return v;
    if (Date.now() - start > timeoutMs) throw new CaseFail(`poll timeout: ${label}`);
    await sleep(intervalMs);
  }
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json<T = any>(): T;
  elapsedMs: number;
}

export async function http(
  url: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
    raw?: boolean;
  } = {},
): Promise<HttpResult> {
  const start = Date.now();
  const res = await fetch(url, {
    method: opts.method ?? (opts.body != null ? 'POST' : 'GET'),
    headers: {
      ...(opts.body != null ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.raw
      ? (opts.body as string)
      : opts.body != null
        ? JSON.stringify(opts.body)
        : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    json<T = any>(): T {
      return JSON.parse(text) as T;
    },
    elapsedMs: Date.now() - start,
  };
}

export interface SseHandle {
  ready: Promise<{ status: number; headers: Headers }>;
  /** 每帧解析后的 data JSON(非 [DONE]);garbage 帧记为字符串 */
  chunks: any[];
  /**
   * 流终结判定——必须等 reader 真实收尾,防空断言恒真:
   * done=干净 EOF;aborted=主动断开;network-error=读失败;http-error=非 200;
   * stalled=超 stallMs 未收尾(服务端悬挂——用例据此失败而非挂死套件)。
   */
  done: Promise<'done' | 'aborted' | 'network-error' | 'http-error' | 'stalled'>;
  text: string;
  firstChunkAt: number | null;
  abort(): void;
  requestAt: number;
}

/** 拉起一条流式请求,后台收集帧;abort() 主动断开 */
export function sse(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  opts: { stallMs?: number } = {},
): SseHandle {
  const stallMs = opts.stallMs ?? 30_000;
  const ctrl = new AbortController();
  const handle = {
    chunks: [] as any[],
    text: '',
    firstChunkAt: null as number | null,
    requestAt: Date.now(),
    abort: () => ctrl.abort(),
    ready: null as never,
    done: null as never,
  } as SseHandle;
  let settle: (v: 'done' | 'aborted' | 'network-error') => void = () => {};
  const settled = new Promise<'done' | 'aborted' | 'network-error'>((resolve) => {
    settle = resolve;
  });
  handle.ready = (async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    // 异步消费 body:不 await 进 ready
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // 每个 chunk 只 decode 一次:TextDecoder 的流式状态随调用推进,
          // 对同一 chunk 二次 decode 会在多字节序列跨 chunk 时损坏 text/buf
          const piece = dec.decode(value, { stream: true });
          if (handle.firstChunkAt == null) handle.firstChunkAt = Date.now();
          handle.text += piece;
          buf += piece;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6);
              if (payload === '[DONE]') continue;
              try {
                handle.chunks.push(JSON.parse(payload));
              } catch {
                handle.chunks.push(payload);
              }
            }
          }
        }
        buf += dec.decode(); // 冲刷尾部悬置字节(多字节序列恰跨最后 chunk)
        settle('done');
      } catch (err) {
        settle((err as { name?: string })?.name === 'AbortError' ? 'aborted' : 'network-error');
      }
    })();
    return { status: res.status, headers: res.headers };
  })();
  handle.done = handle.ready.then(
    async ({ status }) => {
      if (status !== 200) return 'http-error' as const;
      // 真实等待流收尾;stall 上限把「永不收尾」从挂死套件变成可失败断言
      return Promise.race([settled, sleep(stallMs).then(() => 'stalled' as const)]);
    },
    (err) =>
      (err as { name?: string })?.name === 'AbortError'
        ? ('aborted' as const)
        : ('network-error' as const),
  );
  return handle;
}

// ---- 用例注册与运行 ----
export interface CaseDef {
  id: string;
  group: string;
  title: string;
  fn: (c: any) => Promise<void>;
}

export interface CaseResult {
  id: string;
  group: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  ms: number;
  detail?: string;
}

export const registry: CaseDef[] = [];

export function define(id: string, group: string, title: string, fn: (c: any) => Promise<void>) {
  registry.push({ id, group, title, fn });
}

export async function runAll(ctx: any, only?: string[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  let current = '';
  for (const c of registry) {
    if (only != null && only.length > 0 && !only.includes(c.id)) continue;
    if (c.group !== current) {
      current = c.group;
      console.log(`\n━━━ ${current} ━━━`);
    }
    const start = Date.now();
    try {
      await c.fn(ctx);
      results.push({ ...c, status: 'PASS', ms: Date.now() - start });
      console.log(`  ✓ ${c.id} ${c.title} (${Date.now() - start}ms)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status = (error as any)?.skip === true ? 'SKIP' : 'FAIL';
      results.push({ ...c, status, ms: Date.now() - start, detail: msg });
      console.log(
        `  ${status === 'SKIP' ? '−' : '✗'} ${c.id} ${c.title} [${status}] ${msg.slice(0, 300)}`,
      );
    }
  }
  return results;
}

export class SkipCase extends Error {
  skip = true;
}

export function report(results: CaseResult[]) {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log('\n════════════════ 汇总 ════════════════');
  for (const g of [...new Set(results.map((r) => r.group))]) {
    const rows = results.filter((r) => r.group === g);
    const p = rows.filter((r) => r.status === 'PASS').length;
    console.log(
      `  ${g}: ${p}/${rows.length} pass${rows.some((r) => r.status === 'FAIL') ? '  ⚠️ 有发现' : ''}`,
    );
  }
  console.log(`  总计: ${pass} PASS / ${fail} FAIL(=发现) / ${skip} SKIP / ${results.length} 用例`);
  if (fail > 0) {
    console.log('\n---- 发现(FAIL = 防守未达预期,需人工复核) ----');
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      console.log(`  [${r.id}] ${r.title}\n    ${r.detail?.slice(0, 500)}`);
    }
  }
  return { pass, fail, skip, total: results.length };
}

/** 从 e2e/live-fire 向上找根 .env 装载(不覆盖已有环境变量) */
export function loadRootEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, '.env');
    try {
      const text = readFileSync(candidate, 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m == null) continue;
        if (process.env[m[1]] == null) process.env[m[1]] = m[2];
      }
      return candidate;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('root .env not found');
}
