import { serveApp } from '@tillgate/http';
import { closeDb, ping } from '@tillgate/db';
import { createShutdown } from '@tillgate/runtime';
import { loadTraceReceiverConfig } from './config';
import { assembleReceiver } from './assembly';
import { createReceiverApp } from './app';

/**
 * 链路接收端入口：独立小服务（内网），诊断数据 best-effort（过载即丢绝不反压业务）。
 * 部署：双副本无状态；网关/worker 等以 OTEL_TRACES_MODE=otlp +
 * OTEL_EXPORTER_OTLP_ENDPOINT=http://trace-receiver:8793 指向本服务。
 */

const config = loadTraceReceiverConfig();
const { logger, otel, db, store, batcher } = assembleReceiver(config);
// ping 绑定在进程装配面:app.ts 不接触 Db 类型,非装配代码只持闭包与纯契约
const app = createReceiverApp({
  pingDb: () => ping(db),
  store,
  batcher,
  token: config.receiverToken,
  logger,
});

const server = serveApp(app, { port: config.port }, () => {
  batcher.start();
  logger.info(
    {
      port: config.port,
      auth: config.receiverToken ? 'token' : 'open(dev)',
      queueMax: config.queueMax,
      batchMax: config.batchMax,
    },
    'trace-receiver ready',
  );
});

// 优雅停机编排件(runtime):server.close → otel flush → batcher 尽力排空 → db 收口
const shutdown = createShutdown({
  serviceName: 'trace-receiver',
  server,
  otel,
  redis: null,
  db: { end: () => closeDb(db) },
  graceMs: 10_000,
  closeables: [batcher],
  log: logger,
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
