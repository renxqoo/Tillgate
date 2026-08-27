/**
 * smtp-probe 装配面探针（mock nodemailer；独立文件——vi.resetModules 会换代
 * 模块注册表，与其他测试互不污染）。
 */
import { describe, expect, it, vi } from 'vitest';

interface TransportStub {
  readonly options: Record<string, unknown>;
  verify: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** 传输器替身工厂：记录构造参数；verify 可编程回放 */
function transportStub(verifyImpl: () => Promise<void> = async () => {}) {
  const stubs: TransportStub[] = [];
  const createTransport = (opts: Record<string, unknown>) => {
    const stub: TransportStub = {
      options: opts,
      verify: vi.fn(verifyImpl),
      close: vi.fn(),
    };
    stubs.push(stub);
    return stub;
  };
  return { stubs, createTransport };
}

async function importProbe(createTransport: (opts: Record<string, unknown>) => unknown) {
  vi.doMock('nodemailer', () => ({
    default: { createTransport },
    createTransport,
  }));
  vi.resetModules();
  const { createSmtpProbe } = await import('../src/adapters/smtp-probe');
  return createSmtpProbe(5_000);
}

const TARGET = {
  host: 'smtp.example.com',
  port: 465,
  user: 'noreply@example.com',
  pass: 's3cret',
  from: 'noreply@example.com',
};

describe('smtp-probe（装配面探针）', () => {
  it('verify 通过 → ok:true + 传输器口径（465=secure + 三段超时）+ close 释放', async () => {
    const { stubs, createTransport } = transportStub();
    const probe = await importProbe(createTransport);
    const result = await probe.probeSmtp(TARGET);
    expect(result).toEqual({ ok: true, durationMs: expect.any(Number) });
    expect(stubs).toHaveLength(1);
    expect(stubs[0]?.options).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'noreply@example.com', pass: 's3cret' },
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 5_000,
    });
    expect(stubs[0]?.verify).toHaveBeenCalledTimes(1);
    expect(stubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('verify 认证拒绝 → ok:false 透传传输层 code（EAUTH），不是管理面错误', async () => {
    const { createTransport } = transportStub(async () => {
      throw Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH' });
    });
    const probe = await importProbe(createTransport);
    const result = await probe.probeSmtp(TARGET);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'EAUTH', message: 'Invalid login: 535' });
  });

  it('verify 抛无 code 异常 → error.code 归 smtp；587 端口 secure=false', async () => {
    const { stubs, createTransport } = transportStub(async () => {
      throw new Error('greeting never came');
    });
    const probe = await importProbe(createTransport);
    const result = await probe.probeSmtp({ ...TARGET, port: 587 });
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'smtp', message: 'greeting never came' });
    expect(stubs[0]?.options).toMatchObject({ port: 587, secure: false });
    // 失败路径同样释放传输器
    expect(stubs[0]?.close).toHaveBeenCalledTimes(1);
  });
});
