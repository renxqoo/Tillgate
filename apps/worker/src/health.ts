/**
 * 进程健康端点（v1 health.ts 对位 + per-job 快照增强——DESIGN §5）：
 *   /livez          进程 running 标志
 *   /readyz         scheduler + PG + BullMQ Redis 就绪状态
 *   /health         x-health-token 守卫（timingSafeEqual）的深度报告
 * 无业务 HTTP 面（worker 无 app.ts）；server.unref 由调用方决定。
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface WorkerHealthState {
  live(): boolean;
  ready(): boolean | Promise<boolean>;
  deep(): Record<string, unknown>;
}

const BODY_OK = JSON.stringify({ status: 'ok' });
const BODY_FAIL = JSON.stringify({ status: 'fail' });

/** /readyz 响应：探测 reject 与 false 同义——对编排器 fail-closed，细节由依赖日志记录。 */
async function respondReady(res: ServerResponse, state: WorkerHealthState): Promise<void> {
  let ready = false;
  try {
    ready = await state.ready();
  } catch {
    ready = false;
  }
  res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  res.end(ready ? BODY_OK : BODY_FAIL);
}

function tokenMatches(expected: string, received: string | undefined): boolean {
  if (expected.length === 0) return false;
  if (received == null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startHealthServer(
  port: number,
  state: WorkerHealthState,
  token: string | undefined,
): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/livez') {
      res.writeHead(state.live() ? 200 : 503, { 'content-type': 'application/json' });
      res.end(state.live() ? BODY_OK : BODY_FAIL);
      return;
    }
    if (url === '/readyz') {
      void respondReady(res, state);
      return;
    }
    if (url === '/health') {
      const header = req.headers['x-health-token'];
      const received = Array.isArray(header) ? header[0] : header;
      if (!tokenMatches(token ?? '', received)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'deep health report requires a token',
              code: 'WORKER_HEALTH_TOKEN_REQUIRED',
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.deep()));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  server.listen(port);
  return server;
}
