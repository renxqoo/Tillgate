/**
 * 脚本化 mock 上游：openai-compatible 协议族应答 +
 * 请求录制（体/头全量留证）——e2e 套件共享装置（kit 拆件：本文件只管上游行为）。
 */
import { createServer, type Server, type ServerResponse } from 'node:http';

/** mock 上游接受的渠道密钥（鉴权不对等价 401——leak 扫描的明文靶）；kit re-export */
export const E2E_UPSTREAM_KEY = 'sk-e2e-minimax-0123456789abcdef';

// ---------------------------------------------------------------------------
// mock 上游：脚本化 openai-compatible 应答 + 请求录制
// ---------------------------------------------------------------------------

export type UpstreamScript =
  | 'auto' // 缺省：按请求体 stream 字段分流（并发混合负载用——无共享可变脚本竞态）
  | 'nonstream-usage' // JSON 200 + usage{10,5}（n>1 时回 n choices）
  | 'nonstream-huge-usage' // usage{1000,100000}——fixed 超额补扣向量
  | 'nonstream-reject' // 400 错误体——上游拒绝向量（网关出 502）
  | 'nonstream-slow-body' // 响应头先到、体分片慢发——非流式断连向量（⑦）
  | 'stream-usage' // SSE：增量帧（累计 usage）+ 终帧 + DONE
  | 'stream-usage-hold' // SSE：增量帧后挂住（取消/断连向量）
  | 'stream-no-usage-hold' // SSE：无 usage 增量帧后挂住（估算向量）
  | 'stream-done-no-usage'; // SSE：完成但无 usage（usage_missing_completed 向量）

export interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** 200 个 CJK 字增量（估算口径 0.7 token/字 → ≥100 token） */
const cjkDeltas = Array.from({ length: 20 }, () => '数'.repeat(10));

export interface MockUpstream {
  url: string;
  /** 当前脚本（用例独占设置） */
  script: UpstreamScript;
  /** 响应前延迟 ms（slow ⑮ 慢上游旋钮） */
  delayMs: number;
  /** 流帧间延迟 ms（慢流向量） */
  frameGapMs: number;
  recorded: RecordedRequest[];
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 脚本载荷构造（纯数据函数——auto 之外的具名脚本逐个落帧/落体）
// ---------------------------------------------------------------------------

// SSE 增量帧（无 usage——估算向量用）
const contentFrame = (t: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

// SSE 终帧（无 usage——stream-done-no-usage 收尾）
const finishFrame = (): string =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;

// SSE 增量帧（累计 usage——stream-usage 族）
const usageDeltaFrame = (t: string, i: number): string =>
  `data: ${JSON.stringify({
    choices: [{ delta: { content: t } }],
    usage: { prompt_tokens: 50, completion_tokens: (i + 1) * 5, total_tokens: 50 + (i + 1) * 5 },
  })}\n\n`;

// SSE 终帧（最终 usage——stream-usage 族）
const usageFinishFrame = (): string =>
  `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
  })}\n\n`;

// 脚本 usage 口径（prompt/completion 对——total 派生）
const USAGE_SMALL = { promptTokens: 10, completionTokens: 5 };
const USAGE_HUGE = { promptTokens: 1_000, completionTokens: 100_000 };

/** 非流式 JSON 应答体（id 固定 chatcmpl-e2e；n>1 回 n choices） */
function nonstreamBody(
  content: string,
  n: number,
  usage: { promptTokens: number; completionTokens: number },
): string {
  return JSON.stringify({
    id: 'chatcmpl-e2e',
    choices: Array.from({ length: n }, (_, index) => ({
      index,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    })),
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    },
  });
}

// ---------------------------------------------------------------------------
// SSE 写出与脚本分发（模块级小函数——避免 createServer 回调内深嵌套）
// ---------------------------------------------------------------------------

/** SSE 写出：帧间按 state.frameGapMs 节奏逐帧写；写完后 hold 则挂住连接等客户端
 *  取消（inactivity 兜底归网关），否则发 DONE 收尾 */
function writeSse(
  res: ServerResponse,
  plan: { frames: string[]; hold: boolean },
  state: MockUpstream,
): void {
  let i = 0;
  const writeNext = (): void => {
    const frame = plan.frames[i];
    if (frame !== undefined) {
      res.write(frame);
      i += 1;
      setTimeout(writeNext, state.frameGapMs);
    } else if (!plan.hold) {
      res.end('data: [DONE]\n\n');
    }
  };
  writeNext();
}

/** 脚本应答上下文（res + 选项聚合——控制参数个数） */
interface RespondContext {
  res: ServerResponse;
  n: number;
  state: MockUpstream;
}

/** 按具名脚本应答（auto 已在请求处理点归一为具体脚本） */
function runScript(script: Exclude<UpstreamScript, 'auto'>, ctx: RespondContext): void {
  switch (script) {
    case 'stream-usage':
    case 'stream-usage-hold': {
      const frames = [...cjkDeltas.map(usageDeltaFrame), usageFinishFrame()];
      writeSse(ctx.res, { frames, hold: script === 'stream-usage-hold' }, ctx.state);
      return;
    }
    case 'stream-no-usage-hold': {
      writeSse(ctx.res, { frames: cjkDeltas.map(contentFrame), hold: true }, ctx.state);
      return;
    }
    case 'stream-done-no-usage': {
      const frames = [...cjkDeltas.map(contentFrame), finishFrame()];
      writeSse(ctx.res, { frames, hold: false }, ctx.state);
      return;
    }
    case 'nonstream-slow-body': {
      // 响应头即刻到、体 1s 后一次发完——客户端「拿到头即断」时网关仍需读完
      // 上游体计费（断连≠免费，⑦ 断连向量的确定性形态）
      ctx.res.writeHead(200, { 'content-type': 'application/json' });
      setTimeout(() => ctx.res.end(nonstreamBody('好', 1, USAGE_SMALL)), 1_000);
      return;
    }
    case 'nonstream-huge-usage': {
      ctx.res.writeHead(200, { 'content-type': 'application/json' });
      ctx.res.end(nonstreamBody('x', 1, USAGE_HUGE));
      return;
    }
    case 'nonstream-reject': {
      ctx.res.writeHead(400, { 'content-type': 'application/json' });
      ctx.res.end(
        JSON.stringify({ error: { message: 'upstream rejected', type: 'invalid_request_error' } }),
      );
      return;
    }
    default: {
      ctx.res.writeHead(200, { 'content-type': 'application/json' });
      ctx.res.end(nonstreamBody('hi', ctx.n, USAGE_SMALL));
    }
  }
}

export function startMockUpstream(): MockUpstream {
  const state: MockUpstream = {
    url: '',
    script: 'auto',
    delayMs: 0,
    frameGapMs: 0,
    recorded: [],
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${E2E_UPSTREAM_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad upstream key' } }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      state.recorded.push({ headers: { ...req.headers }, body });
      const n = typeof body.n === 'number' && body.n > 0 ? body.n : 1;
      const autoScript = body.stream === true ? 'stream-usage' : 'nonstream-usage';
      const script = state.script === 'auto' ? autoScript : state.script;
      const respond = (): void => runScript(script, { res, n, state });
      if (state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });
  const listening = new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      state.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
  state.close = async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  // 同步返回（url 由首个用例前经 ready() 屏障确保——见 setupE2EWorld）
  (state as { ready?: Promise<void> }).ready = listening;
  return state;
}
