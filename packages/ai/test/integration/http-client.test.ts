import { describe, expect, it } from 'vitest';
import { classifyHttpError } from '../../src/errors/classify.js';
import { fetchUpstream, readBody } from '../../src/transport/http-client.js';
import { startServer, wait } from './helpers.js';

/**
 * 集成场景（本地 http server mock 上游）：
 * 正常 200 / 空 200 / 429 / 401 / connect 超时 / 网络错误 / SSRF 拒绝
 * 状态码分类走 classifyHttpError（阶段 A 已单测矩阵，此处验证链路闭环）
 */

const POST = { method: 'POST' } as const;

describe('fetchUpstream 集成', () => {
  it('正常 200：返回 Response，body 可读', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [] }));
    });
    try {
      const res = await fetchUpstream(server.baseUrl + '/v1/chat/completions', POST, {
        connectMs: 2000,
        allowLocal: true,
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(await readBody(res)) as { id: string };
      expect(body.id).toBe('x');
    } finally {
      await server.close();
    }
  });

  it('空 200：body 为空字符串（空完成判定交给上层）', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end();
    });
    try {
      const res = await fetchUpstream(server.baseUrl + '/v1/chat/completions', POST, {
        connectMs: 2000,
        allowLocal: true,
      });
      expect(res.status).toBe(200);
      expect(await readBody(res)).toBe('');
    } finally {
      await server.close();
    }
  });

  it('429：状态透传，分类为 rate_limited（retryable、不跳闸）', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
    });
    try {
      const res = await fetchUpstream(server.baseUrl + '/v1/chat/completions', POST, {
        connectMs: 2000,
        allowLocal: true,
      });
      expect(res.status).toBe(429);
      const err = classifyHttpError(429, JSON.parse(await readBody(res)));
      expect(err.code).toBe('rate_limited');
      expect(err.retryable).toBe(true);
      expect(err.circuitTrip).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('401：分类为 invalid_api_key（死凭据）', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    try {
      const res = await fetchUpstream(server.baseUrl + '/v1/chat/completions', POST, {
        connectMs: 2000,
        allowLocal: true,
      });
      expect(res.status).toBe(401);
      const err = classifyHttpError(401, JSON.parse(await readBody(res)));
      expect(err.code).toBe('invalid_api_key');
      expect(err.deadCredential).toBe(true);
      expect(err.retryable).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('connect 超时：上游不响应 → 抛 timeout 错误（retryable + circuitTrip）', async () => {
    const server = await startServer(() => {
      /* 收到请求但不响应，直到客户端超时 abort */
    });
    try {
      await expect(
        fetchUpstream(server.baseUrl + '/v1/chat/completions', POST, {
          connectMs: 80,
          allowLocal: true,
        }),
      ).rejects.toMatchObject({ code: 'timeout', retryable: true, circuitTrip: true });
    } finally {
      await server.close();
    }
  });

  it('网络错误：拒绝连接 → 抛 network 错误（retryable + circuitTrip）', async () => {
    // 起一个 server 拿端口后关闭，确保端口无监听 → ECONNREFUSED
    const server = await startServer(() => {});
    const port = new URL(server.baseUrl).port;
    await server.close();
    await expect(
      fetchUpstream(`http://127.0.0.1:${port}/v1/chat/completions`, POST, {
        connectMs: 2000,
        allowLocal: true,
      }),
    ).rejects.toMatchObject({ code: 'network', retryable: true, circuitTrip: true });
  });

  it('外部 AbortSignal：headers 返回前 abort → 抛原生 AbortError（不做重试分类）', async () => {
    // 上游收到请求但不写任何响应（headers 挂起），abort 才能作用于 fetch 本身
    const server = await startServer(() => {
      /* 不响应 */
    });
    try {
      const controller = new AbortController();
      const pending = fetchUpstream(server.baseUrl + '/v1/chat/completions', POST, {
        connectMs: 10_000,
        signal: controller.signal,
        allowLocal: true,
      }).catch((e: unknown) => e);
      await wait(30);
      controller.abort();
      const err = await pending;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('aborted');
      expect((err as { retryable?: boolean }).retryable).toBeUndefined(); // 不参与重试分类
    } finally {
      await server.close();
    }
  });

  it('SSRF 防护：默认拒绝 http:// 内网地址（生产必配 allowLocal=false）', async () => {
    const server = await startServer(() => {});
    try {
      await expect(
        fetchUpstream(server.baseUrl + '/v1/chat/completions', POST, { connectMs: 500 }),
      ).rejects.toThrow('unsupported protocol: http:');
    } finally {
      await server.close();
    }
  });
});
