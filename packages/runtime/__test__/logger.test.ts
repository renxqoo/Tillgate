import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger';

/** 行收集流：createLogger 的输出注入面（pino 默认直写 fd 1，劫持 stdout 不可靠） */
function collect(): { lines: string[]; stream: { write: (line: string) => void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => lines.push(line) } };
}

describe('createLogger', () => {
  it('redact 命中 v1 六条路径 + v2 新增三条路径（根级字段）', () => {
    const { lines, stream } = collect();
    const logger = createLogger({ level: 'info', serviceName: 't', stream });
    logger.info(
      {
        apiKey: 'sk-1',
        api_key: 'sk-2',
        clientSecret: 'cs-1',
        client_secret: 'cs-2',
        key: 'k-1',
        token: 'tk-1',
        secret: 'sc-1',
        password: 'pw-1',
      },
      'msg',
    );
    const parsed = JSON.parse(lines[0]!) as Record<string, string>;
    for (const field of [
      'apiKey',
      'api_key',
      'clientSecret',
      'client_secret',
      'key',
      'token',
      'secret',
      'password',
    ]) {
      expect(parsed[field], field).toBe('[REDACTED]');
    }
  });

  it('redact 命中嵌套路径（req.headers.authorization）', () => {
    const { lines, stream } = collect();
    const logger = createLogger({ level: 'info', pretty: false, stream });
    logger.info({ req: { headers: { authorization: 'Bearer live-token' } } }, 'req');
    const parsed = JSON.parse(lines[0]!) as { req: { headers: { authorization: string } } };
    expect(parsed.req.headers.authorization).toBe('[REDACTED]');
  });

  it('serviceName 与 level 生效；低于 level 的日志不输出', () => {
    const { lines, stream } = collect();
    const logger = createLogger({ level: 'warn', serviceName: 'svc-name', stream });
    logger.info('dropped');
    logger.warn({ code: 'W1' }, 'kept');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { name: string; level: number; code: string };
    expect(parsed.name).toBe('svc-name');
    expect(parsed.code).toBe('W1');
  });

  it('pretty 形态可创建（开发态 transport 配置不抛错）', () => {
    expect(() =>
      createLogger({ level: 'info', pretty: true, serviceName: 'pretty-svc' }),
    ).not.toThrow();
  });
});
