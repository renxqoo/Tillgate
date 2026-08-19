import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { VertexAiAdapter } from '../../src/adapters/vertex-ai.js';

/** Vertex AI 适配器：SA 解析 / JWT 交换 / token 缓存 / 寻址 project+location 提取 */
const tokenServer = (opts: { status?: number; body?: unknown } = {}) => {
  const seen: Array<{ grantType: string; assertion: string }> = [];
  const calls = { count: 0 };
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.count += 1;
    const params = new URLSearchParams(String(init?.body));
    seen.push({
      grantType: params.get('grant_type') ?? '',
      assertion: params.get('assertion') ?? '',
    });
    return new Response(
      opts.body !== undefined ? JSON.stringify(opts.body) : JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }),
      { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { fetchImpl, seen, calls };
};

describe('VertexAiAdapter', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const saJson = JSON.stringify({
    client_email: 'svc@proj.iam.gserviceaccount.com',
    private_key: privateKey.replace(/\n/g, '\\n'),
    project_id: 'my-proj',
  });
  const channel = {
    baseUrl: 'https://europe-west4-aiplatform.googleapis.com',
    apiKey: saJson,
    protocol: 'vertex-ai',
  };
  it('signRequest：SA → RS256 JWT 断言换 token（grant_type 正确、头三段可解析）', async () => {
    const { fetchImpl, seen } = tokenServer();
    const adapter = new VertexAiAdapter(fetchImpl);
    const headers = await adapter.signRequest({ url: new URL('https://x.test'), body: '', apiKey: saJson });
    expect(headers.authorization).toBe('Bearer tok-1');
    expect(seen[0]!.grantType).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c] = seen[0]!.assertion.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims).toMatchObject({ iss: 'svc@proj.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token' });
    void publicKey;
  });

  it('token 缓存：60s 余量内复用（二次调用不再交换）；换新 SA 重新交换', async () => {
    const { fetchImpl, calls } = tokenServer();
    const adapter = new VertexAiAdapter(fetchImpl);
    const a1 = await adapter.signRequest({ url: new URL('https://x'), body: '', apiKey: saJson });
    const a2 = await adapter.signRequest({ url: new URL('https://x'), body: '', apiKey: saJson });
    expect(calls.count).toBe(1);
    expect(a1).toEqual(a2);
    const otherSa = JSON.stringify({
      client_email: 'other@proj.iam.gserviceaccount.com',
      private_key: privateKey.replace(/\n/g, '\\n'),
      project_id: 'p2',
    });
    await adapter.signRequest({ url: new URL('https://x'), body: '', apiKey: otherSa });
    expect(calls.count).toBe(2);
    void fetchImpl;
  });

  it('非 SA JSON 的 apiKey → 显式报错；交换 4xx/无 access_token → 显式报错', async () => {
    const adapter = new VertexAiAdapter();
    await expect(adapter.signRequest({ url: new URL('https://x'), body: '', apiKey: 'not-json' }))
      .rejects.toThrow('service account');
    const failing = new VertexAiAdapter((async () => new Response('{}', { status: 400 })) as unknown as typeof fetch);
    await expect(failing.signRequest({ url: new URL('https://x'), body: '', apiKey: saJson }))
      .rejects.toThrow('token exchange failed: 400');
    const noToken = new VertexAiAdapter((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);
    await expect(noToken.signRequest({ url: new URL('https://x'), body: '', apiKey: saJson }))
      .rejects.toThrow('no access_token');
  });

  it('寻址：project 从 SA、location 从 baseUrl host 提取；兜底 default-project/us-central1', () => {
    const adapter = new VertexAiAdapter();
    const plan = adapter.planRequest(channel, { endpoint: 'chat', model: 'gemini-2.5-pro', requestId: 'r', stream: false });
    expect(plan.path).toBe('/v1/projects/my-proj/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent');
    const fallbackChannel = { baseUrl: 'https://aiplatform.googleapis.com', apiKey: 'bad', protocol: 'vertex-ai' };
    const fallback = adapter.planRequest(fallbackChannel, { endpoint: 'chat', model: 'm', requestId: 'r', stream: true });
    expect(fallback.path).toContain('/projects/default-project/locations/us-central1/');
    expect(fallback.path).toContain(':streamGenerateContent?alt=sse');
  });

  it('探测为空表（token 异步交换不可静态给头）——尽力而为语义', () => {
    expect(new VertexAiAdapter().probeRequests(channel)).toEqual([]);
  });

  it('usage：usageMetadata 归一（cached/thoughts）；无 → null', () => {
    const adapter = new VertexAiAdapter();
    expect(adapter.extractUsage({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, cachedContentTokenCount: 1, thoughtsTokenCount: 3 } }))
      .toMatchObject({ inputTokens: 5, cachedInputTokens: 1, outputTokens: 5 });
    expect(adapter.extractUsage({})).toBeNull();
  });
});
