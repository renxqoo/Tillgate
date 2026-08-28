/**
 * 双形态进程冒烟（trace-receiver 同款手动执行；
 * 独立 smoke 配置不进默认门禁）：bun-native 单运行时——bun 源码形态（bun src/index.ts）
 * 与 bun 产物形态（bun dist/index.js，Bun.serve + Bun.sql 不经 node 兼容层）各——
 *   探针 healthz/readyz/livez 200 → 静态 Key 鉴权 /v1/models 200/401 →
 *   一次非流式真请求 200（mock 上游全链计费）→ SIGTERM 优雅退出 → 结算对账。
 * 隔离 schema（世界装置）；结束 drop cascade——冒烟数据自清。
 * 运行：bun run test:e2e:smoke
 */
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { E2EKeys, setupE2EWorld, startE2EGateway } from './kit';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://:root123@127.0.0.1:6379';
const GW_ROOT = new URL('../../apps/gateway/', import.meta.url).pathname;
const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

interface Proc {
  baseUrl: string;
  waitExit(): Promise<number>;
}

/** 子进程启动入参（聚合对象——控制参数个数） */
interface GatewaySpawnInput {
  form: string;
  command: string;
  args: string[];
  port: number;
  env: Record<string, string>;
}

/** 起网关子进程（形态名 + 命令），等 listening 日志行 */
function startGateway(input: GatewaySpawnInput): Promise<Proc> {
  const { form, command, args, port, env } = input;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: GW_ROOT,
      // NODE_ENV=development：bun 的 development 条件解析 workspace src（NODE_ENV=test
      // 会走 production 条件命中 dist——control-plane dist 缺 JSON 资产是另案的打包缺陷）
      env: {
        ...process.env,
        ...env,
        GATEWAY_PORT: String(port),
        NODE_ENV: 'development',
        OTEL_TRACES_MODE: 'off',
        REDIS_URL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`${form} not listening within 20s:\n${buf}`)),
      20_000,
    );
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      if (buf.includes('gateway listening')) {
        clearTimeout(timer);
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          waitExit: () =>
            new Promise((res) => {
              child.once('exit', (code) => res(code ?? 0));
            }),
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${form} exited early (code ${code}):\n${buf}`));
    });
  });
}

/** 找监听端口的 pid（SIGTERM 定向） */
function findPid(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (err, stdout) => {
      const pid = Number(stdout.trim().split('\n')[0]);
      if (!pid) reject(new Error(`pid not found on port ${port}: ${String(err)}`));
      else resolve(pid);
    });
  });
}

it.skipIf(!hasEnv)(
  '双形态进程冒烟：bun 源码 / bun 产物 → 探针 + 鉴权 + 真请求 + SIGTERM + 对账',
  { timeout: 180_000, sequential: true },
  async () => {
    const world = await setupE2EWorld();
    const raw = `sk_${randomUUID().replace(/-/g, '')}`;
    const subject = `smoke-${randomUUID().slice(0, 8)}`;
    const r = await world.db.execute(sql`
      insert into users (issuer, subject, identity_provider) values ('smoke', ${subject}, 'local') returning id`);
    const userId = Number((r as unknown as Array<{ id: string | number }>)[0]?.id);
    await world.db.execute(sql`
      insert into api_keys (key_hash, key_preview, user_id, name)
      values (${createHash('sha256').update(raw).digest('hex')}, 'sk_…', ${userId}, 'smoke')`);

    // 世界内嵌装配（拿 billing facade 充值 + 驱动结算对账——进程外请求的账单同库）
    const helperGateway = await startE2EGateway(world);
    await helperGateway.assembly.billingFacade.wallet.credit({
      userId,
      amount: '1',
      refType: 'topup',
      refId: `smoke-${randomUUID().slice(0, 8)}`,
    });
    const keys = new E2EKeys(world, helperGateway.assembly.billingFacade);

    /** 单形态冒烟入参（聚合对象——控制参数个数） */
    const smokeForm = async (input: {
      form: string;
      command: string;
      args: string[];
      port: number;
    }): Promise<void> => {
      const { form, command, args, port } = input;
      console.log(`\n=== ${form} ===`);
      const proc = await startGateway({
        form,
        command,
        args,
        port,
        env: {
          DATABASE_URL: world.scopedUrl,
          ENCRYPTION_KEY: 'e2e-channel-key-0123456789abcdef',
          JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef012345',
          GATEWAY_AI_ALLOW_LOCAL_URL: 'true',
        },
      });
      try {
        for (const path of ['/healthz', '/readyz', '/livez']) {
          const res = await fetch(`${proc.baseUrl}${path}`);
          console.log(`${path} → ${res.status}`);
          expect(res.status).toBe(200);
        }
        const ok = await fetch(`${proc.baseUrl}/v1/models`, {
          headers: { authorization: `Bearer ${raw}` },
        });
        const bad = await fetch(`${proc.baseUrl}/v1/models`, {
          headers: { authorization: 'Bearer sk_invalidinvalid' },
        });
        console.log(`/v1/models 鉴权 → ok ${ok.status} / bad ${bad.status}`);
        expect(ok.status).toBe(200);
        expect(bad.status).toBe(401);
        world.upstream.script = 'auto';
        const chat = await fetch(`${proc.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'RX-M3',
            max_tokens: 100,
            messages: [{ role: 'user', content: '只回复：好' }],
          }),
        });
        console.log(`/v1/chat/completions → ${chat.status}`);
        await chat.text();
        expect(chat.status).toBe(200);
      } finally {
        process.kill(await findPid(port), 'SIGTERM');
        const code = await proc.waitExit();
        console.log(`${form} SIGTERM 退出码 ${code}`);
        expect(code).toBe(0);
      }
      await keys.settleAll(userId);
      const bills = await world.db.execute<{ status: string }>(
        sql`select status from billing_requests where user_id = ${userId}`,
      );
      console.log(`${form} 冒烟账单：`, bills.map((b) => b.status).join(','));
      expect(bills.every((b: { status: string }) => b.status === 'settled')).toBe(true);
    };

    try {
      await smokeForm({
        form: 'bun 源码形态',
        command: 'bun',
        args: ['src/index.ts'],
        port: 18_081,
      });
      await new Promise<void>((resolve, reject) => {
        const build = spawn('bun', ['run', 'build'], { cwd: GW_ROOT, stdio: 'inherit' });
        build.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`build failed ${code}`)),
        );
      });
      await smokeForm({
        form: 'bun 产物形态',
        command: 'bun',
        args: ['dist/index.js'],
        port: 18_082,
      });
      // 终态对账：余额 = 1 − Σ实扣（两形态各 1 笔）、在途 0
      await keys.settleAll(userId);
      const { balance, charged } = await keys.assertReconciled(userId, '1');
      console.log(`\n冒烟对账：余额 ${balance} Σ实扣 ${charged}（两形态各 1 笔）`);
    } finally {
      await helperGateway.stop();
      await world.teardown(); // 冒烟数据自清（schema drop cascade）
    }
  },
);
