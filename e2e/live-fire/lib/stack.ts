/**
 * live-fire 进程栈:独立端口起 gateway/client-api/admin-api/worker + mock 上游 + SMTP sink,
 * 与开发者可能正在跑的 8080/8081/8082 实例互不干扰;worker 例外——同一 DB 的第二个 worker
 * 会参与结算(claim 幂等),故启动前检测并停掉已有 worker 进程(测试期独占结算语义)。
 */
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, http } from './h.ts';

export const PORTS = {
  mock: 8890,
  smtp: 2525,
  gw: 8810,
  client: 8811,
  gwStrict: 8812,
  clientStrict: 8813,
  admin: 8814,
} as const;

export const URLS = {
  gw: `http://127.0.0.1:${PORTS.gw}`,
  gwStrict: `http://127.0.0.1:${PORTS.gwStrict}`,
  client: `http://127.0.0.1:${PORTS.client}`,
  clientStrict: `http://127.0.0.1:${PORTS.clientStrict}`,
  admin: `http://127.0.0.1:${PORTS.admin}`,
  mock: `http://127.0.0.1:${PORTS.mock}`,
};

const ROOT = join(import.meta.dir, '../../..');
const LOG_DIR = join(import.meta.dir, '../logs');
mkdirSync(LOG_DIR, { recursive: true });

interface Proc {
  name: string;
  proc: any;
}

const procs: Proc[] = [];

function spawn(name: string, args: string[], cwd: string, envOverride: Record<string, string>) {
  const out = openSync(join(LOG_DIR, `${name}.log`), 'w');
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...envOverride },
    stdout: out,
    stderr: out,
    stdin: 'ignore',
  });
  procs.push({ name, proc });
  return proc;
}

function bunApp(name: string, appDir: string, envOverride: Record<string, string>) {
  // 127.0.0.1 显式 IPv4:localhost 在 macOS 下 DNS/IPv6 双栈尝试会把池的新建
  // 连接拖到秒级(高并发建连风暴时打满 connectionTimeout)——经典坑,直连环回
  const dbUrl = process.env.DATABASE_URL?.replace(/\/\/([^:@/]+):([^@/]*)@localhost:/, (m, u, p) => `//${u}:${p}@127.0.0.1:`) ?? process.env.DATABASE_URL;
  spawn(name, ['bun', 'dist/index.js'], join(ROOT, appDir), {
    ...(dbUrl != null ? { DATABASE_URL: dbUrl } : {}),
    ...envOverride,
  });
}

async function waitHealthy(name: string, url: string, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await http(url, { timeoutMs: 2000 });
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`${name} did not become healthy at ${url}`);
    await sleep(300);
  }
}

/** 清 BullMQ 结算队列残留(跨轮 job 风暴会拖垮共享 PG——轮间抖动主源) */
function purgeSettlementQueue() {
  const pass = (() => {
    try {
      return new URL(process.env.REDIS_URL as string).password;
    } catch {
      return 'root123';
    }
  })();
  Bun.spawnSync([
    'bash', '-c',
    `redis-cli -a ${pass} --scan --pattern '{bull}:settlement*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1`,
  ]);
}

export async function startStack() {
  purgeSettlementQueue();
  // 本仓库 apps 的残留实例(相对路径命令行不含仓库名,按 cwd 识别)会分走结算
  // claim/抢端口——测试期独占:杀掉 cwd 在本仓库 apps/* 的 src/index.ts 进程
  const existing = Bun.spawnSync([
    'bash',
    '-c',
    `for p in \$(pgrep -f 'src/index.ts'); do d=\$(lsof -p \$p 2>/dev/null | awk '/cwd/{print \$NF}'); case \$d in ${ROOT}/apps/*) echo \$p;; esac; done`,
  ]);
  const pids = existing.stdout.toString().trim().split('\n').filter((p) => p !== '' && p !== String(process.pid));
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
      console.log(`[stack] killed leftover repo app pid=${pid}`);
    } catch {}
  }

  spawn('mock-llm', ['bun', join(ROOT, 'e2e/live-fire/mock-llm.ts'), String(PORTS.mock)], ROOT, {});
  spawn('smtp-sink', ['bun', join(ROOT, 'e2e/live-fire/smtp-sink.ts'), String(PORTS.smtp)], ROOT, {});

  spawn(
    'gateway-bun',
    ['bun', 'dist/index.js'],
    join(ROOT, 'apps/gateway'),
    {
      ...(process.env.DATABASE_URL?.includes('localhost')
        ? { DATABASE_URL: process.env.DATABASE_URL.replace('@localhost:', '@127.0.0.1:') }
        : {}),
      GATEWAY_PORT: String(PORTS.gw),
      GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS: '2500',
      GATEWAY_UPSTREAM_DEADLINE_MS: '20000',
      AUTH_KEY_FAILURE_THRESHOLD: '1000',
      AUTH_IP_FAILURE_LIMIT: '10000',
      ADMISSION_MAX_PENDING: '10000',
      ADMISSION_MAX_OLDEST_MS: '120000',
      BILLING_AUTHORIZATION_TTL_MS: '15000',
      OTEL_TRACES_MODE: 'off',
      // bun#38163/#38231 家族 workaround:Bun SQL 池「检出排队」会停摆在途事务
      // (F-6)——池 ≥ 峰值并发即无排队,200 并发实测 200/200@779ms。
      DB_POOL_MAX: '210',
    },
  );
  bunApp('client-api', 'apps/client-api', {
    CLIENT_API_PORT: String(PORTS.client),
    EMAIL_CODE_REQUIRED: 'off',
    REGISTER_IP_LIMIT_PER_HOUR: '1000',
    LOGIN_IP_FAILURE_LIMIT: '10000',
    DB_POOL_MAX: '6',
  });
  bunApp('gateway-strict', 'apps/gateway', {
    GATEWAY_PORT: String(PORTS.gwStrict),
    GATEWAY_AI_ALLOW_LOCAL_URL: 'false',
    OTEL_TRACES_MODE: 'off',
    DB_POOL_MAX: '2',
  });
  bunApp('client-api-strict', 'apps/client-api', {
    CLIENT_API_PORT: String(PORTS.clientStrict),
    REGISTER_IP_LIMIT_PER_HOUR: '3',
    DB_POOL_MAX: '4',
  });
  bunApp('admin-api', 'apps/admin-api', { ADMIN_API_PORT: String(PORTS.admin), DB_POOL_MAX: '3' });
  bunApp('worker', 'apps/worker', {
    WORKER_HEALTH_PORT: '0',
    WORKER_SETTLE_INTERVAL_MS: '4000',
    WORKER_RECOVER_INTERVAL_MS: '4000',
    // P1 毒账单用例:退避基 500ms(PG 策略与 BullMQ 重投同源加速,死信判定不拖分钟级)
    WORKER_BASE_DELAY_MS: '500',
  });

  await waitHealthy('mock-llm', `${URLS.mock}/openmock/v1/models`);
  await waitHealthy('gateway', `${URLS.gw}/healthz`);
  await waitHealthy('gateway-strict', `${URLS.gwStrict}/healthz`);
  await waitHealthy('client-api', `${URLS.client}/healthz`);
  await waitHealthy('client-api-strict', `${URLS.clientStrict}/healthz`);
  await waitHealthy('admin-api', `${URLS.admin}/healthz`);
  await sleep(1500); // worker:进程活着 + LISTEN 就绪(无业务端口可探)
}

/** worker 专属句柄:支持 SIGKILL/SIGSTOP/SIGCONT 级故障注入 */
export function workerProc() {
  const found = procs.find((p) => p.name === 'worker');
  if (found == null) throw new Error('worker not running');
  return found.proc;
}

export async function restartWorker() {
  const found = procs.find((p) => p.name === 'worker');
  if (found != null) {
    try {
      found.proc.kill(9);
    } catch {}
    procs.splice(procs.indexOf(found), 1);
  }
  bunApp('worker', 'apps/worker', {
    WORKER_HEALTH_PORT: '0',
    WORKER_SETTLE_INTERVAL_MS: '4000',
    WORKER_RECOVER_INTERVAL_MS: '4000',
    // P1 毒账单用例:退避基 500ms(PG 策略与 BullMQ 重投同源加速,死信判定不拖分钟级)
    WORKER_BASE_DELAY_MS: '500',
  });
  await sleep(1500);
}

export async function stopStack() {
  for (const p of procs) {
    try {
      p.proc.kill('SIGTERM');
    } catch {}
  }
  await sleep(1200);
  for (const p of procs) {
    try {
      p.proc.kill('SIGKILL');
    } catch {}
  }
  procs.length = 0;
}
