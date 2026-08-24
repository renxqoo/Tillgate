/**
 * worker 全链 e2e 装置（v1 gateway e2e-worker 搬迁;P7）：网关真装配世界
 * （e2e/gateway/kit——隔离 schema + mock chat 上游 + 种子渠道/映射）+ worker
 * 全真装配（assembleWorker,loadWorkerConfig 最小 env）共库;视频生成环的
 * MiniMax 任务协议上游在本地 mock（v1 createServer 形态——gateway/upstream.ts
 * 只覆盖 openai-compatible chat 族,任务族协议不在其内）。
 *
 * 驱动口径（P7 与 v1 的装置差异,断言语义不改）：
 * - v1 真 worker 三定时器 100ms 节奏自驱 → v2 assembly.runners 直驱（settle/
 *   generation 入口即定时器 tick 的同一生产函数——数据接收仍由真实 worker
 *   装配完成,只是不经定时器）;停机语义用真 scheduler（start 消费 → stop 停止）。
 * - v1 共享 dev 库 + 预算快照还原/逐表清理 → v2 隔离 schema 世界（drop cascade
 *   自清,v1 ⑯b/⑯c 的手工清理清单消亡）。
 * - v1 worker 必配 REDIS_URL（BullMQ 唤醒）→ v2 worker 无 Redis 配置项
 *   （PG LISTEN/NOTIFY;本装置 WORKER_SETTLE_WAKE=false 不挂消费端）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ping, closeDb, createDb } from '@tillgate/db';
import type { Db } from '@tillgate/db';
import { E2E_CHANNEL_ENCRYPTION_KEY, setupE2EWorld, type E2EWorld } from '../gateway/kit.js';
import { loadWorkerConfig } from '../../apps/worker/src/config.js';
import { assembleWorker } from '../../apps/worker/src/assembly.js';
import type { WorkerAssembly } from '../../apps/worker/src/assembly.js';

/** mock MiniMax 视频上游（v1 e2e-worker createServer 形态迁移）：
 *  提交 → task_id;查询 2 次 Queueing 后 Success（file_id + 宽高）;files/retrieve 换 url */
export interface VideoUpstream {
  server: Server;
  baseUrl: string;
  /** 最近一次提交回执的上游任务号（提交断言用） */
  lastTaskId: string;
  /** 提交请求的 authorization 头（解密注入断言用） */
  submittedAuth: string;
  close(): Promise<void>;
}

/** 内部可变状态（查询计数——前 2 次 Queueing、其后 Success 的应答分流） */
interface VideoUpstreamState extends VideoUpstream {
  queryCount: number;
}

/** 视频上游请求路由（模块级工厂——保持状态闭包并避免 server 工厂深嵌套） */
function createVideoUpstreamHandler(state: VideoUpstreamState) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    state.submittedAuth = req.headers.authorization ?? '';
    const url = req.url ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.includes('/v1/video_generation')) {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        state.lastTaskId = `task-${randomUUID()}`;
        json(200, { task_id: state.lastTaskId, base_resp: { status_code: 0, status_msg: '' } });
      });
      return;
    }
    if (url.includes('/v1/query/video_generation')) {
      state.queryCount += 1;
      if (state.queryCount <= 2) {
        json(200, {
          status: 'Queueing',
          task_id: state.lastTaskId,
          base_resp: { status_code: 0, status_msg: '' },
        });
      } else {
        json(200, {
          status: 'Success',
          task_id: state.lastTaskId,
          file_id: 'file-xyz',
          video_width: 1280,
          video_height: 720,
          base_resp: { status_code: 0, status_msg: '' },
        });
      }
      return;
    }
    if (url.includes('/v1/files/retrieve')) {
      json(200, {
        file: { download_url: 'https://cdn.mock/video.mp4', file_id: 'file-xyz' },
        base_resp: { status_code: 0, status_msg: '' },
      });
      return;
    }
    json(404, {});
  };
}

export function startVideoUpstream(): VideoUpstream {
  const state: VideoUpstreamState = {
    server: null as unknown as Server,
    baseUrl: '',
    lastTaskId: '',
    submittedAuth: '',
    queryCount: 0,
    close: async () => {},
  };
  state.server = createServer(createVideoUpstreamHandler(state));
  const listening = new Promise<void>((resolve) => {
    state.server.listen(0, '127.0.0.1', () => {
      const address = state.server.address();
      state.baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
  state.close = async () => {
    (state.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => {
      state.server.close(() => resolve());
    });
  };
  (state as { ready: Promise<void> }).ready = listening;
  return state;
}

/** 世界存续期 worker（结算/生成 runner 直驱;停机语义用 scheduler） */
export async function assembleWorldWorker(world: E2EWorld): Promise<WorkerAssembly> {
  const config = loadWorkerConfig({
    NODE_ENV: 'test',
    DATABASE_URL: world.scopedUrl,
    // 与 gateway 装配共钥——worker 结算/轮询要解密同一批渠道行
    CHANNEL_API_KEY_ENCRYPTION: E2E_CHANNEL_ENCRYPTION_KEY,
    OTEL_TRACES_MODE: 'off',
    LOG_LEVEL: 'error',
    WORKER_OWNER_ID: `e2e-br-${randomUUID().slice(0, 8)}`,
    // 隔离世界无他进程——LISTEN 消费端不挂（runner 直驱覆盖数据接收面）
    WORKER_SETTLE_WAKE: 'false',
    // 告警投递静音（e2e 不测 notify;dev 库真实投递会噪）
    WORKER_NOTIFY_ENABLED: 'false',
    // 定时器节奏：settle/generation 短值（⑯c 停机语义用真定时器证「活着会消费」）;
    // 其余 job 放慢——本旅程不触达,给大间隔防误 tick
    WORKER_SETTLE_INTERVAL_MS: '100',
    WORKER_GENERATION_INTERVAL_MS: '100',
    WORKER_RECOVER_INTERVAL_MS: '300000',
    WORKER_REFERRAL_INTERVAL_MS: '300000',
    WORKER_RECONCILE_INTERVAL_MS: '300000',
    WORKER_PARTITION_INTERVAL_MS: '300000',
    WORKER_SHUTDOWN_GRACE_MS: '5000',
    // 视频 mock 上游在回环——SSRF 逃生门仅非生产可用（与生产装配同口径）
    WORKER_AI_ALLOW_LOCAL_URL: 'true',
  } as unknown as NodeJS.ProcessEnv);
  return assembleWorker(config);
}

/** worker 收口：停调度 → 关唤醒端 → 关库（世界 teardown 的 drop cascade 之前） */
export async function teardownWorker(worker: WorkerAssembly): Promise<void> {
  await worker.scheduler.stop();
  await worker.wakeup?.close();
  await worker.closeDb();
}

/** PG 可达探测（不可达优雅 skip——admin kit 同款形态） */
export async function pgReady(): Promise<boolean> {
  const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
  if (url === undefined || url === '') return false;
  const probe: Db = createDb({
    url,
    poolMax: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
    maxUses: 10,
  });
  try {
    await ping(probe);
    return true;
  } catch {
    return false;
  } finally {
    await closeDb(probe).catch(() => {});
  }
}

export { setupE2EWorld };
export type { E2EWorld };
