/**
 * worker 进程入口：装配 → 启动调度/健康端点 → 信号注册。
 * 自启动守卫：test 环境（或 WORKER_NO_AUTOSTART=1）不自动启动——测试经
 * assembleWorker 装配后自行驱动。
 */
import { loadWorkerConfig } from './config';
import { assembleWorker } from './assembly';
import { startHealthServer } from './health';
import { createWorkerShutdown } from './shutdown';

const autostart =
  process.env.NODE_ENV !== 'test' &&
  process.env.VITEST === undefined &&
  process.env.WORKER_NO_AUTOSTART !== '1';

if (autostart) {
  const config = loadWorkerConfig();
  const assembly = await assembleWorker(config);

  assembly.scheduler.start();

  // 健康端点（0 = 关闭）：端口占用只告警不崩（旁路面）
  const healthServer =
    config.health.port > 0
      ? startHealthServer(config.health.port, assembly.healthState, config.health.token)
      : null;
  healthServer?.on('error', (error) => {
    assembly.logger.error({ err: String(error), port: config.health.port }, 'health server error');
  });
  healthServer?.unref();

  const shutdown = createWorkerShutdown({
    // 端点关闭形态：立即回调的 close 占位（createShutdown 只依赖该形状）
    healthServer: healthServer ?? { close: (cb: () => void) => cb() },
    otel: assembly.otel,
    closeDb: assembly.closeDb,
    scheduler: assembly.scheduler,
    wakeup: assembly.wakeup,
    settleQueue: assembly.settleQueue,
    abandonOwnedClaims: assembly.abandonOwnedClaims,
    graceMs: config.shutdownGraceMs,
    logger: assembly.logger,
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  assembly.logger.info(
    {
      owner: config.ownerId,
      jobs: assembly.jobs,
      wake: config.settle.wake ? 'pg-listen' : 'off',
      notify: config.notify.enabled ? 'on' : 'muted',
      healthPort: config.health.port,
    },
    'worker started',
  );
}
