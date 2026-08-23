/**
 * 脚本化 mock 上游（v1 cost-drain 内嵌件泛化）：openai-compatible 协议族应答 +
 * 请求录制（体/头全量留证）——e2e 套件共享装置（kit 拆件：本文件只管上游行为）。
 */
import { createServer, type Server } from 'node:http';

/** mock 上游接受的渠道密钥（鉴权不对等价 401——leak 扫描的明文靶）；kit re-export */
export const E2E_UPSTREAM_KEY = 'sk-e2e-minimax-0123456789abcdef';

// ---------------------------------------------------------------------------
// mock 上游：脚本化 openai-compatible 应答 + 请求录制（v1 cost-drain 内嵌件泛化）
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

/** 200 个 CJK 字增量（估算口径 0.7 token/字 → ≥100 token——v1 同款） */
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
      const respond = () => {
        const sse = (frames: string[], hold = false) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          let i = 0;
          const writeNext = (): void => {
            if (i < frames.length) {
              res.write(frames[i]!);
              i += 1;
              setTimeout(writeNext, state.frameGapMs);
            } else if (!hold) {
              res.end('data: [DONE]\n\n');
            }
            // hold = 挂住连接等客户端取消（inactivity 兜底归网关）
          };
          writeNext();
        };
        const script =
          state.script === 'auto'
            ? body.stream === true
              ? 'stream-usage'
              : 'nonstream-usage'
            : state.script;
        switch (script) {
          case 'stream-usage':
          case 'stream-usage-hold':
            sse(
              [
                ...cjkDeltas.map(
                  (t, i) =>
                    `data: ${JSON.stringify({
                      choices: [{ delta: { content: t } }],
                      usage: {
                        prompt_tokens: 50,
                        completion_tokens: (i + 1) * 5,
                        total_tokens: 50 + (i + 1) * 5,
                      },
                    })}\n\n`,
                ),
                `data: ${JSON.stringify({
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
                })}\n\n`,
              ],
              state.script === 'stream-usage-hold',
            );
            return;
          case 'stream-no-usage-hold':
            sse(
              cjkDeltas.map(
                (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`,
              ),
              true,
            );
            return;
          case 'stream-done-no-usage':
            sse([
              ...cjkDeltas.map(
                (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`,
              ),
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
            ]);
            return;
          case 'nonstream-slow-body': {
            // 响应头即刻到、体 1s 后一次发完——客户端「拿到头即断」时网关仍需读完
            // 上游体计费（断连≠免费，v1 ⑦ 向量的确定性等价形态）
            res.writeHead(200, { 'content-type': 'application/json' });
            setTimeout(() => {
              res.end(
                JSON.stringify({
                  id: 'chatcmpl-e2e',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: '好' },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }),
              );
            }, 1_000);
            return;
          }
          case 'nonstream-huge-usage':
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-e2e',
                choices: [
                  { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' },
                ],
                usage: { prompt_tokens: 1_000, completion_tokens: 100_000, total_tokens: 101_000 },
              }),
            );
            return;
          case 'nonstream-reject':
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: { message: 'upstream rejected', type: 'invalid_request_error' },
              }),
            );
            return;
          default:
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-e2e',
                choices: Array.from({ length: n }, (_, index) => ({
                  index,
                  message: { role: 'assistant', content: 'hi' },
                  finish_reason: 'stop',
                })),
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              }),
            );
        }
      };
      if (state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });
  const listening = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.close = async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  void listening.then(() => {
    const address = server.address();
    state.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  // 同步返回（url 由首个用例前经 ready() 屏障确保——见 setupE2EWorld）
  (state as { ready?: Promise<void> }).ready = listening;
  return state;
}
