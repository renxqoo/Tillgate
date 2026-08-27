/**
 * 独立 mock 上游 LLM 服务（live-fire redteam 装置，不入 CI、不提交）。
 *
 * Bun 单进程 HTTP 服务,模拟 4 家厂商人格(openmock/deepmock/moonmock/chaosmock),
 * 线格式 openai-compatible;按路径前缀区分厂商(每厂商独立 base_url/Bearer key,
 * 网关侧 = 每厂商一行 providers/channels)。支持:
 *   - 非流式 /v1/chat/completions、流式 SSE(逐块 + 终帧 usage)、/v1/models、/v1/embeddings
 *   - 故障注入:real_model 指令后缀 `#f=dir1,dir2`(见 parseDirectives)
 *   - 全局/按厂商状态故障:/__ctl(挂起全厂商、恢复、查看)、/__metrics(上游调用计数)
 * 用法: bun e2e/live-fire/mock-llm.ts [port=8790]
 */
const PORT = Number(process.argv[2] ?? 8790);

interface Persona {
  key: string;
  idPrefix: string;
  ttfbMs: [number, number];
  chunkCount: number;
  chunkDelayMs: number;
  reasoning: boolean;
  catalog: string[];
}

const VENDORS: Record<string, Persona> = {
  openmock: {
    key: 'sk-mock-openmock-k1',
    idPrefix: 'chatcmpl',
    ttfbMs: [15, 40],
    chunkCount: 6,
    chunkDelayMs: 8,
    reasoning: false,
    catalog: ['rt-base', 'rt-mini'],
  },
  deepmock: {
    key: 'sk-mock-deepmock-k1',
    idPrefix: 'deep-chat',
    ttfbMs: [60, 120],
    chunkCount: 8,
    chunkDelayMs: 14,
    reasoning: true,
    catalog: ['rt-base', 'rt-deep-thinker'],
  },
  moonmock: {
    key: 'sk-mock-moonmock-k1',
    idPrefix: 'moon-cmpl',
    ttfbMs: [35, 80],
    chunkCount: 12,
    chunkDelayMs: 10,
    reasoning: false,
    catalog: ['rt-base'],
  },
  chaosmock: {
    key: 'sk-mock-chaosmock-k1',
    idPrefix: 'chaos-cmpl',
    ttfbMs: [3, 10],
    chunkCount: 4,
    chunkDelayMs: 4,
    reasoning: false,
    catalog: ['rt-base'],
  },
};

type Mode = 'ok' | 'hang' | 's429';
const ctl: { global: Mode; vendors: Record<string, Mode> } = {
  global: 'ok',
  vendors: {},
};
const metrics = {
  startedAt: new Date().toISOString(),
  requests: {} as Record<string, number>,
  byModel: {} as Record<string, number>,
  authFails: 0,
  bytesOut: 0,
  idempotencyKeys: {} as Record<string, number>,
};

function bump(map: Record<string, number>, k: string) {
  map[k] = (map[k] ?? 0) + 1;
}

/** 参数化指令(带数字后缀)白名单:ttfb3000/slow400/chunks8/n3/bigbody64;其余 token 原样作键 */
const PARAMETRIC = new Set(['ttfb', 'slow', 'chunks', 'n', 'bigbody']);

/** real_model 指令解析:rt-base#f=s429,usage100x40 → {s429:true, usage:[100,40]}(usage 用 x 分隔避免与指令逗号冲突) */
function parseDirectives(raw: string): {
  base: string;
  d: Record<string, number | true | number[]>;
} {
  const hash = raw.indexOf('#f=');
  if (hash < 0) return { base: raw, d: {} };
  const base = raw.slice(0, hash);
  const d: Record<string, number | true | number[]> = {};
  for (const token of raw.slice(hash + 3).split(',')) {
    const usage = token.match(/^usage(\d+)x(\d+)$/);
    if (usage) {
      d.usage = [Number(usage[1]), Number(usage[2])];
      continue;
    }
    const m = token.match(/^([a-z]+)(\d+)$/);
    if (m != null && PARAMETRIC.has(m[1])) {
      d[m[1]] = Number(m[2]);
      continue;
    }
    d[token] = true;
  }
  return { base, d };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
const rid = () => Math.random().toString(36).slice(2, 10);

function usageOf(d: Record<string, number | true | number[]>): Record<string, number> {
  if ('negusage' in d) {
    return { prompt_tokens: -50, completion_tokens: -20, total_tokens: -70 };
  }
  if ('hugeusage' in d) {
    return {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000_000,
      total_tokens: 1_001_000_000,
    };
  }
  if ('zerousage' in d) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (Array.isArray(d.usage)) {
    const [p, c] = d.usage as [number, number];
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  }
  return { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 };
}

/** 非流式 JSON 响应体 */
function chatBody(p: Persona, model: string, n: number, usage: Record<string, number>) {
  const choices = Array.from({ length: n }, (_, i) => ({
    index: i,
    message: { role: 'assistant', content: `mock-reply-${p.idPrefix}-${i}: ${model}` },
    finish_reason: 'stop',
  }));
  return {
    id: `${p.idPrefix}-${rid()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    usage,
  };
}

/** 故障开关:返回 Response(该故障直接作答)或 null(无故障,走正常应答路径) */
async function faultGate(
  vendor: string,
  d: Record<string, number | true | number[]>,
): Promise<Response | null> {
  const mode = ctl.vendors[vendor] ?? ctl.global;
  if (mode === 'hang' || 'hang' in d) return new Promise<Response>(() => {});
  if (mode === 's429' && !('s429' in d)) {
    return Response.json(
      { error: { message: 'ctl rate limited', type: 'rate_limit_error', code: '429' } },
      { status: 429 },
    );
  }
  if ('hangbody' in d) {
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(''));
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if ('reset0' in d) {
    return new Response(
      new ReadableStream({
        start(c) {
          setTimeout(() => c.error(new Error('mock upstream reset before data')), 5);
        },
      }),
      { status: 200 },
    );
  }
  if ('empty' in d)
    return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
  if ('s429' in d)
    return Response.json(
      { error: { message: 'mock rate limited', type: 'rate_limit_error', code: '429' } },
      { status: 429 },
    );
  if ('s500' in d)
    return Response.json(
      { error: { message: 'mock internal error', type: 'server_error' } },
      { status: 500 },
    );
  if ('s403' in d)
    return Response.json(
      { error: { message: 'mock forbidden', type: 'permission_error' } },
      { status: 403 },
    );
  if ('s400' in d)
    return Response.json(
      { error: { message: 'mock bad request', type: 'invalid_request_error' } },
      { status: 400 },
    );
  if ('redir' in d) {
    return new Response('', { status: 302, headers: { location: `/redir-target-${rid()}` } });
  }
  if ('ttfb' in d) await sleep(Number(d.ttfb));
  return null;
}

// 每厂商独立端口(8790+i):网关熔断/死凭据状态按 protocol://host 维度共享,
// 同端口多厂商会互相熔断污染——隔离端口 = 隔离健康状态。
const VENDOR_ORDER = ['openmock', 'deepmock', 'moonmock', 'chaosmock'];

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/__metrics') return Response.json({ ctl, metrics });
  if (url.pathname === '/__ctl' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      scope?: string;
      mode?: Mode;
      reset?: boolean;
    };
    if (body.reset) {
      ctl.global = 'ok';
      ctl.vendors = {};
      metrics.requests = {};
      metrics.byModel = {};
      metrics.authFails = 0;
      metrics.bytesOut = 0;
      metrics.idempotencyKeys = {};
      return Response.json({ ok: true, ctl });
    }
    const mode: Mode = body.mode === 'hang' ? 'hang' : body.mode === 's429' ? 's429' : 'ok';
    if (body.scope && body.scope !== 'global') ctl.vendors[body.scope] = mode;
    else ctl.global = mode;
    return Response.json({ ok: true, ctl });
  }

  const m = url.pathname.match(
    /^\/([a-z]+)\/v1\/(chat\/completions|completions|embeddings|models)$/,
  );
  if (m == null || VENDORS[m[1]] == null) {
    return Response.json(
      { error: { message: `unknown mock path ${url.pathname}` } },
      { status: 404 },
    );
  }
  const vendor = m[1];
  const persona = VENDORS[vendor];
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${persona.key}`) {
    metrics.authFails += 1;
    return Response.json(
      {
        error: {
          message: 'Incorrect API key provided',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
      { status: 401 },
    );
  }
  bump(metrics.requests, vendor);

  if (m[2] === 'models') {
    return Response.json({
      object: 'list',
      data: persona.catalog.map((id) => ({ id, object: 'model', owned_by: vendor })),
    });
  }
  if (m[2] === 'embeddings') {
    return Response.json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: 'rt-embed',
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
  }

  const body = (await req.json().catch(() => null)) as {
    model?: string;
    stream?: boolean;
    n?: number;
  } | null;
  if (body == null || typeof body.model !== 'string' || body.model.length === 0) {
    return Response.json(
      { error: { message: 'mock: missing model', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }
  const { base, d } = parseDirectives(body.model);
  const echoModel = 'wrongmodel' in d ? 'wrong-model-echo' : base;
  bump(metrics.byModel, body.model);
  const idem = req.headers.get('idempotency-key');
  if (idem != null) bump(metrics.idempotencyKeys, idem);

  const n = 'n' in d ? Number(d.n) : Math.max(1, Math.min(body.n ?? 1, 4));
  const usage = usageOf(d);

  const gated = await faultGate(vendor, d);
  if (gated != null) return gated;

  if (body.stream !== true) {
    const json = JSON.stringify(chatBody(persona, echoModel, n, usage));
    metrics.bytesOut += json.length;
    return new Response(json, {
      status: 's401' in d ? 401 : 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  // ---- 流式 SSE ----
  const chunks = 'chunks' in d ? Number(d.chunks) : persona.chunkCount;
  const delay = 'slow' in d ? Number(d.slow) : persona.chunkDelayMs;
  const perFrame = 'perframe' in d;
  const bigKb = 'bigbody' in d ? Number(d.bigbody) : 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = 0;
      const id = `${persona.idPrefix}-${rid()}`;
      const frame = (delta: object, extra: object = {}, finish: string | null = null) => {
        const payload = {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: echoModel,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        };
        const line = `data: ${JSON.stringify(payload)}\n\n`;
        metrics.bytesOut += line.length;
        controller.enqueue(encoder.encode(line));
      };
      try {
        if ('garbage' in d) {
          controller.enqueue(encoder.encode('data: not-json {{{\n\n: broken frame\n\n'));
          await sleep(30);
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        await sleep(rand(persona.ttfbMs[0], persona.ttfbMs[1]));
        if (persona.reasoning) frame({ reasoning_content: 'thinking...' });
        for (let i = 0; i < chunks; i++) {
          const content =
            bigKb > 0 ? 'x'.repeat(bigKb * 1024) : `chunk-${i}-of-${modelSlice(body.model)}`;
          frame({ content }, perFrame ? { usage: scaled(usage, i + 1, chunks) } : {});
          sent += 1;
          if ('reset' in d && sent >= 2) {
            controller.error(new Error('mock upstream mid-stream reset'));
            return;
          }
          await sleep(delay);
        }
        const finalUsage = 'nousage' in d ? {} : { usage };
        frame({}, finalUsage, 'stop');
        if (!('nodone' in d)) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch {
        // 客户端断开等:静默结束
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

for (const [i, vendor] of VENDOR_ORDER.entries()) {
  Bun.serve({
    port: PORT + i,
    idleTimeout: 120,
    fetch: handler,
  });
  console.log(`[mock-llm] :${PORT + i} → ${vendor}`);
}

function modelSlice(m: string) {
  return m.length > 40 ? `${m.slice(0, 40)}…` : m;
}

/** per-frame 累计 usage:按已发块比例折算 */
function scaled(usage: Record<string, number>, done: number, total: number) {
  const f = Math.max(1, Math.round((done / total) * usage.completion_tokens));
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: f,
    total_tokens: usage.prompt_tokens + f,
  };
}

console.log(`[mock-llm] listening on :${PORT} vendors=${Object.keys(VENDORS).join(',')}`);
