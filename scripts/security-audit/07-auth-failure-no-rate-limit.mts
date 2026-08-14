/**
 * 报红测试 07：网关鉴权失败路径（无效 Key）无 global/IP 限流 → 可无限刷 401 / 打爆 request_logs。
 *
 * 测什么 bug：
 *   gateway 中间件链顺序是 requestLog → auth → 路由（路由内才有 RPM/TPM 限流），
 *   即「全局限流/用户限流」都在鉴权之后。鉴权失败（无效 Key）在进入路由前就 401 返回，
 *   因此**不经过任何限流器**。唯一的爆破防护 `brute-force-guard` 只按 keyHash 计数
 *   （`auth:fails:{hash}`，阈值 5 才锁），攻击者每请求换一个随机 Key 即可永久绕过。
 *   后果：同一来源可无限刷 401，每条都 fire-and-forget 写一条 request_logs（DB 膨胀），
 *   并在 Redis 累积海量 `auth:fails:*` 键（内存压力），且无 429 可被观测/告警。
 *
 * 预期（安全）：同一来源短时间内大量鉴权失败应被限流（出现 429），或按来源(IP)聚合失败计数。
 * 实测：30 个不同随机 Key 全部 401、0 个 429 → 报红。
 *
 * 运行：pnpm tsx scripts/security-audit/07-auth-failure-no-rate-limit.mts
 */
import {
  loadEnv,
  psql,
  q,
  GATEWAY,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

const ATTEMPTS = 30;

async function chatWithKey(key: string): Promise<number> {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'x' }] }),
  });
  await res.arrayBuffer();
  return res.status;
}

function count401NullUser(): number {
  return Number(
    psql(
      `select count(*) from request_logs where path='/v1/chat/completions' and method='POST' and status_code=401 and user_id is null;`,
    ),
  );
}

async function main(): Promise<void> {
  console.log('🧪 报红测试 07：鉴权失败路径无 global/IP 限流（可无限刷 401）');
  console.log(`   gateway: ${GATEWAY} | 攻击: ${ATTEMPTS} 个不同随机无效 Key`);

  const before = count401NullUser();

  section('攻击：同一来源并发打 30 个「不同」随机无效 Key');
  const statuses: Record<string, number> = {};
  const tasks = Array.from({ length: ATTEMPTS }, (_, i) => async () => {
    const code = String(await chatWithKey(`ag_invalid_rotate_${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`));
    statuses[code] = (statuses[code] ?? 0) + 1;
  });
  // 并发 10，模拟单 IP 打点
  await Promise.all(
    Array.from({ length: Math.min(10, tasks.length) }, async () => {
      while (tasks.length) {
        const t = tasks.shift();
        if (t) await t();
      }
    }),
  );

  const after = count401NullUser();
  console.log(`  状态分布: ${JSON.stringify(statuses)}`);
  console.log(`  request_logs(401,无用户) 增量: ${after - before} 条`);

  const limited = Number(statuses['429'] ?? 0);
  if (limited === 0) {
    red(
      '鉴权失败路径无任何限流：同一来源可无限刷 401、无限写 request_logs / 累积 Redis auth:fails:*',
      `${ATTEMPTS} 个不同随机无效 Key 全部 401（0 个 429），request_logs 新增 ${after - before} 条。` +
        `根因：全局限流在鉴权之后才生效，鉴权失败根本走不到限流器；` +
        `brute-force-guard 只按 keyHash 计数，换 Key 即绕过。攻击者可借此打爆日志库与 Redis 内存。`,
    );
  }
  green(`鉴权失败被限流（出现 ${limited} 个 429），未复现 bug`);
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
