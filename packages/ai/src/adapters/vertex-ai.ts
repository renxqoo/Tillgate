import { createSign } from 'node:crypto';
import type { ChannelDesc, UpstreamError, Usage } from '../types';
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter';
import { chatRequestToGemini, geminiResponseToChat, geminiUpstreamToCanonicalStream, geminiUsageToUsage } from '../protocol/gemini-chat';
import { classifyHttpError } from '../errors/classify';

/**
 * Google Vertex AI 适配器（protocol='vertex-ai'）。
 *
 * 寻址：/v1/projects/{project}/locations/{location}/publishers/google/models/{model}
 *      :generateContent | :streamGenerateContent?alt=sse
 * 认证：服务账号 JSON（渠道 apiKey = SA JSON 原文）→ RS256 JWT →
 *      https://oauth2.googleapis.com/token 换 access token（进程内缓存至过期前 60s）。
 * baseUrl 形如 https://{location}-aiplatform.googleapis.com（project/location 从
 * SA JSON 的 project_id + baseUrl host 提取）。
 */

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

const TOKEN_TTL_S = 3600;

const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');

export class VertexAiAdapter implements ProtocolAdapter {
  readonly protocol = 'vertex-ai';
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  private parseSa(apiKey: string): ServiceAccountKey | null {
    try {
      const sa = JSON.parse(apiKey) as ServiceAccountKey;
      if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') return null;
      return sa;
    } catch {
      return null;
    }
  }

  /** SA → OAuth2 access token（缓存按 SA 指纹；fetch 可注入便于测试） */
  private async getAccessToken(sa: ServiceAccountKey, fetchImpl: typeof fetch = fetch): Promise<string> {
    const cacheKey = sa.client_email;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + TOKEN_TTL_S,
    };
    const unsigned = `${b64(header)}.${b64(claims)}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key.replace(/\\n/g, '\n'));
    const assertion = `${unsigned}.${signature.toString('base64url')}`;

    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) {
      throw new Error(`vertex token exchange failed: ${res.status}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof data.access_token !== 'string') {
      throw new Error('vertex token exchange returned no access_token');
    }
    this.tokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : TOKEN_TTL_S) * 1000,
    });
    return data.access_token;
  }

  /** 供 create-ai 获取带认证的最终头（token 异步）——签名钩子同样时序正确 */
  signRequest = async (args: { url: URL; body: string; apiKey: string }): Promise<Record<string, string>> => {
    void args.url;
    void args.body;
    const sa = this.parseSa(args.apiKey);
    if (!sa) throw new Error('vertex channel apiKey is not a service account JSON');
    const token = await this.getAccessToken(sa);
    return { authorization: `Bearer ${token}` };
  };

  planRequest(channel: ChannelDesc, { model, requestId, stream }: { endpoint: 'chat' | 'embeddings'; model: string; requestId: string; stream: boolean }): { path: string; headers: Record<string, string> } {
    void channel;
    void requestId;
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return {
      path: `/v1/projects/${this.projectOf(channel)}/locations/${this.locationOf(channel)}/publishers/google/models/${encodeURIComponent(model)}:${action}`,
      headers: { 'content-type': 'application/json' },
    };
  }

  private projectOf(channel: ChannelDesc): string {
    const sa = this.parseSa(channel.apiKey);
    return sa?.project_id ?? 'default-project';
  }

  private locationOf(channel: ChannelDesc): string {
    const m = /^https?:\/\/([a-z0-9-]+)-aiplatform\.googleapis\.com/.exec(channel.baseUrl);
    return m?.[1] ?? 'us-central1';
  }

  finalizeRequestBody(body: Record<string, unknown>, { model }: { endpoint: 'chat' | 'embeddings'; model: string; stream: boolean }): Record<string, unknown> {
    return chatRequestToGemini({ ...body, model });
  }

  normalizeRequest(req: unknown): { body: unknown; adjustments: ParamAdjustment[] } {
    return { body: req, adjustments: [] };
  }

  translateResponseBody(body: unknown): unknown {
    return geminiResponseToChat(body, '');
  }

  translateUpstreamStream(stream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
    return geminiUpstreamToCanonicalStream(stream, model);
  }

  extractUsage(res: unknown): Usage | null {
    const j = res as Record<string, unknown> | null;
    const u = geminiUsageToUsage(j?.usageMetadata);
    return u
      ? { inputTokens: u.promptTokens, cachedInputTokens: u.cachedTokens, outputTokens: u.completionTokens, estimated: false, raw: j?.usageMetadata }
      : null;
  }

  mapError(status: number | undefined, body: unknown): UpstreamError {
    return classifyHttpError(status ?? 0, body);
  }

  probeRequests(channel: ChannelDesc): { path: string; headers: Record<string, string> }[] {
    // token 是异步交换——探测头在传输层经 signRequest 补齐不可行（probe 不走签名钩子），
    // Vertex 返回空表：探测跳过（尽力而为语义），连通性由熔断/死凭据机制兜底。
    void channel;
    return [];
  }
}
