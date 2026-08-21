import { describe, expect, it } from 'vitest';
import { loadTraceReceiverEnv, secretSchema, strictBooleanSchema } from '../env.js';

describe('共享环境字段安全 schema', () => {
  it('拒绝已知弱密钥、短密钥和低多样性密钥', () => {
    const schema = secretSchema('TEST_SECRET', 16);
    expect(() => schema.parse('passwordpassword')).toThrow();
    expect(() => schema.parse('short')).toThrow();
    expect(() => schema.parse('aaaaaaaaaaaaaaaa')).toThrow();
    expect(schema.parse('strong-secret-1234')).toBe('strong-secret-1234');
  });

  it('布尔值只接受 true/false，字符串 false 不得变成 true', () => {
    const schema = strictBooleanSchema(true);
    expect(schema.parse('false')).toBe(false);
    expect(schema.parse('true')).toBe(true);
    expect(() => schema.parse('yes')).toThrow();
  });

  it('trace receiver 生产环境必须配置令牌，且按传入 env 解析默认追踪模式', () => {
    expect(() => loadTraceReceiverEnv({ NODE_ENV: 'production' })).toThrow('TRACE_RECEIVER_TOKEN');
    expect(loadTraceReceiverEnv({
      NODE_ENV: 'production',
      TRACE_RECEIVER_TOKEN: 'trace-token-production-1234',
    }).OTEL_TRACES_MODE).toBe('off');
  });
});
