/**
 * 红测（审计问题 #2：上游请求跟随重定向且不复检目标）：
 * fetchUpstream 的 SSRF 守卫只校验初始 URL；原生 fetch 缺省 redirect:'follow'
 * 会自动跟随 30x 到任意目标（https 公网地址可跳 http://127.0.0.1:port、
 * http://169.254.169.254 云 metadata，同时绕过 https-only 与私网判定）。
 * 契约：出站请求必须以 redirect:'manual' 派发——3x 不自动跟随，由上层
 * 决定拒绝或对 Location 递归过守卫。本文件当前为红，修复后转绿。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUpstream } from '../src/transport/http-client.js';
import { defined } from './defined.js';

afterEach(() => vi.unstubAllGlobals());

describe('fetchUpstream 重定向防护', () => {
  it('出站请求必须以 redirect:"manual" 派发（守卫不得被 30x 跳转绕过）', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return new Response('ok', { status: 200 });
      }),
    );
    await fetchUpstream(
      'https://upstream.example.test/v1/x',
      { method: 'GET' },
      // 守卫用放行替身：本测锁「过审 URL 的派发形态」，不测守卫本身
      { connectMs: 1_000, guard: async () => {} },
    );
    expect(inits).toHaveLength(1);
    expect(defined(inits[0], 'inits[0]').redirect).toBe('manual');
  });
});
