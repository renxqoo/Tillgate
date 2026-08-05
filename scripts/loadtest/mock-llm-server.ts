/**
 * Mock OpenAI 兼容上游（本地压测用，scripts/loadtest/mock-llm-server.ts）
 *
 * 不调用任何付费 API；模拟 OpenAI /v1/chat/completions 行为：
 *   - 流式：按 tokenIntervalMs 逐帧 drip SSE，总时长 durationMs，尾帧带 usage
 *   - 非流式：等待 durationMs 后一次性返回完整 JSON（含 usage）
 *
 * 内置并发观测：实时跟踪 in-flight 请求数，进程退出时打印 max concurrency。
 *
 * 用法：tsx scripts/loadtest/mock-llm-server.ts [--port 9999] [--duration-ms 1500] [--token-interval-ms 20]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ---- 参数解析 ----
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const PORT = Number(arg('port', '9999'));
const DURATION_MS = Number(arg('duration-ms', '1500'));
const TOKEN_INTERVAL_MS = Number(arg('token-interval-ms', '20'));

// ---- 并发观测 ----
let inFlight = 0;
let maxInFlight = 0;
const startTime = Date.now();
let totalRequests = 0;
let streamRequests = 0;
let nonStreamRequests = 0;

function enter(): void {
  inFlight++;
  totalRequests++;
  if (inFlight > maxInFlight) {
    maxInFlight = inFlight;
    // 只在创新高时打印（避免刷屏）
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[mock-llm] ⬆ max in-flight = ${maxInFlight} (at ${elapsed}s, current ${inFlight})`);
  }
}
function leave(): void {
  inFlight--;
}

// ---- 读 body ----
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function sseFrame(data: string): string {
  return `data: ${data}\n\n`;
}

/** 流式响应：逐帧 drip */
async function streamChat(res: ServerResponse, body: unknown): Promise<void> {
  const reqBody = (body && typeof body === 'object' ? body : {}) as { model?: string };
  const model = reqBody.model ?? 'mock-model';
  // 总帧数 = duration / interval，至少 2 帧（首帧 role + 内容帧）
  const frameCount = Math.max(2, Math.floor(DURATION_MS / TOKEN_INTERVAL_MS));
  const tokens = ['你', '好', '，', '这', '是', '一', '个', '压', '测', '模', '拟', '回', '复', '。'];
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // 首帧：role
  res.write(
    sseFrame(
      JSON.stringify({
        id: 'mock-' + Math.random().toString(36).slice(2, 10),
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }),
    ),
  );
  // 内容帧
  const outputTokens = Math.max(1, Math.floor(frameCount * 0.8));
  for (let i = 0; i < outputTokens; i++) {
    await sleep(TOKEN_INTERVAL_MS);
    const tok = tokens[i % tokens.length]!;
    res.write(
      sseFrame(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: tok }, finish_reason: null }],
        }),
      ),
    );
  }
  // 收尾帧（finish_reason）
  await sleep(TOKEN_INTERVAL_MS);
  res.write(
    sseFrame(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
    ),
  );
  // usage 尾帧（stream_options.include_usage=true 时网关会要）
  res.write(
    sseFrame(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion.chunk',
        model,
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: outputTokens,
          total_tokens: 10 + outputTokens,
        },
      }),
    ),
  );
  // [DONE]
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 非流式响应：等待后一次性返回 */
async function nonStreamChat(res: ServerResponse, body: unknown): Promise<void> {
  const reqBody = (body && typeof body === 'object' ? body : {}) as { model?: string };
  const model = reqBody.model ?? 'mock-model';
  await sleep(DURATION_MS);
  const outputTokens = Math.max(1, Math.floor(DURATION_MS / TOKEN_INTERVAL_MS));
  const text = '你好，这是一个压测模拟回复。'.repeat(Math.max(1, Math.floor(outputTokens / 10)));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'mock-' + Math.random().toString(36).slice(2, 10),
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: outputTokens,
        total_tokens: 10 + outputTokens,
      },
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const server = createServer(async (req, res) => {
  // 健康检查（供压测驱动探活）
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', inFlight, maxInFlight }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  // 兼容带 /v1 前缀和不带前缀两种调用
  const url = req.url ?? '';
  if (!url.endsWith('/v1/chat/completions') && !url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  enter();
  try {
    const raw = await readBody(req);
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    const isStream = (parsed as { stream?: boolean } | null)?.stream === true;
    if (isStream) {
      streamRequests++;
      await streamChat(res, parsed);
    } else {
      nonStreamRequests++;
      await nonStreamChat(res, parsed);
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ error: { message: String(err) } }));
  } finally {
    leave();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-llm] config: duration=${DURATION_MS}ms token-interval=${TOKEN_INTERVAL_MS}ms`);
  console.log('[mock-llm] 路由：POST /v1/chat/completions（stream 与非 stream 自动判别）');
});

// ---- 优雅关闭：打印观测统计 ----
function shutdown(sig: string): void {
  console.log(`\n[mock-llm] received ${sig}, shutting down...`);
  console.log('========================================');
  console.log('  Mock LLM 上游观测统计');
  console.log('========================================');
  console.log(`  总请求数         : ${totalRequests}`);
  console.log(`  流式请求         : ${streamRequests}`);
  console.log(`  非流式请求       : ${nonStreamRequests}`);
  console.log(`  ★ 最大并发 in-flight : ${maxInFlight}`);
  console.log(`  当前 in-flight   : ${inFlight}`);
  console.log(`  运行时长         : ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log('========================================');
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
