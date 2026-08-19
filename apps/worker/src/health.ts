/**
 * worker 健康端点（v1 health server 的 v2 移植，compose healthcheck 依赖 8792）：
 *   /livez  恒 200（进程活着）
 *   /readyz DB 可 ping + 各循环未停（编排器摘除探针语义）
 *   /health 深度报告（积压/dead/循环时点——须 x-health-token 令牌，G2）
 */
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface WorkerHealthState {
  live(): boolean;
  ready(): boolean;
  deep(): Record<string, unknown>;
}

function tokenOk(provided: string | undefined, expected: string): boolean {
  if (!expected) return false;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startHealthServer(
  port: number,
  state: WorkerHealthState,
  token: string,
): Server {
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (url === '/livez') {
      response.writeHead(state.live() ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: state.live() ? 'ok' : 'fail' }));
      return;
    }
    if (url === '/readyz') {
      response.writeHead(state.ready() ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: state.ready() ? 'ok' : 'fail' }));
      return;
    }
    if (url === '/health') {
      const provided = Array.isArray(request.headers['x-health-token'])
        ? request.headers['x-health-token'][0]
        : request.headers['x-health-token'];
      if (!tokenOk(provided, token)) {
        response.writeHead(403, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: { message: '深度健康报告需要令牌', code: 'WORKER_HEALTH_TOKEN_REQUIRED' } }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state.deep()));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(port);
  return server;
}
