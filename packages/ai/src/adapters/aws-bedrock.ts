import { createHash, createHmac } from 'node:crypto';
import type { Endpoint, ChannelDesc, ParamRules, UpstreamError, Usage } from '../types';
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter';
import {
  chatRequestToClaude,
  claudeResponseToChat,
  claudeUsageToUsage,
} from '../protocol/claude-chat';
import { claudeUpstreamToCanonicalStream } from '../protocol/claude-stream';
import { tableOrFallback } from '../errors/fallback';
import type { ErrorKind } from '../errors/kinds';

/** bedrock 错误 type → kind（AWS 错误码表） */
const BEDROCK_CODE_KINDS: Record<string, ErrorKind> = {
  ThrottlingException: 'rate_limited',
  throttling: 'rate_limited',
  AccessDeniedException: 'insufficient_permissions',
  ValidationException: 'invalid_request',
  ModelStreamErrorException: 'upstream_error',
  InternalServerException: 'upstream_error',
  ModelNotReadyException: 'overloaded',
  ServiceUnavailableException: 'overloaded',
};

/**
 * AWS Bedrock 适配器（protocol='aws-bedrock'，Converse Messages API）。
 *
 * 寻址：POST /model/{model}/invoke | /model/{model}/invoke-with-response-stream
 * 认证：SigV4（AccessKeyId/SecretAccessKey[/SessionToken]，apiKey 格式
 *       "accessKeyId:secretAccessKey[:sessionToken]"——渠道密钥单字段承载三段）。
 * 流式响应是 AWS eventstream 二进制帧 → 解析为 anthropic 事件流 → 规范形。
 *
 * SigV4 全部用 node:crypto 手写（无新依赖）：规范请求 + 签名头。
 * baseUrl 形如 https://bedrock-runtime.{region}.amazonaws.com（region 从 host 提取）。
 */

const SERVICE = 'bedrock';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function parseAwsCredentials(apiKey: string): AwsCredentials | null {
  const parts = apiKey.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    accessKeyId: parts[0]!,
    secretAccessKey: parts[1]!,
    sessionToken: parts[2] || undefined,
  };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function signBedrockRequest(args: {
  method: string;
  url: URL;
  body: string;
  credentials: AwsCredentials;
  at: Date;
}): Record<string, string> {
  const { method, url, body, credentials, at } = args;
  const atStr = at.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = atStr.slice(0, 8);
  const payloadHash = createHash('sha256').update(body, 'utf8').digest('hex');

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': atStr,
    'x-amz-content-sha256': payloadHash,
  };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const signedHeaderNames = Object.keys(headers).toSorted();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]!.trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    url.pathname,
    url.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${regionFromHost(url.host)}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    atStr,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  let key: Buffer = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  key = hmac(key, regionFromHost(url.host));
  key = hmac(key, SERVICE);
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function regionFromHost(host: string): string {
  const m = /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  return m?.[1] ?? 'us-east-1';
}

// ─────────────────── AWS eventstream 二进制解析 ───────────────────

interface EventstreamFrame {
  headers: Record<string, string | number>;
  payload: Buffer;
}

/**
 * 解析 AWS eventstream 帧（v0.11 规范）：
 * 总长(4) + 头长(4) + prelude CRC(4) + headers + payload + message CRC(4)
 * 头部类型字节：7=string(名称长2+值长2) 其他数值类型按宽度读。
 */
export function parseEventstreamFrames(buffer: Buffer): {
  frames: EventstreamFrame[];
  rest: Buffer;
} {
  const frames: EventstreamFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 16) {
    const totalLen = buffer.readUInt32BE(offset);
    if (totalLen < 16 || buffer.length - offset < totalLen) break;
    const headerLen = buffer.readUInt32BE(offset + 4);
    const headers: Record<string, string | number> = {};
    let h = offset + 12;
    const headerEnd = offset + 12 + headerLen; // prelude = 总长4 + 头长4 + CRC4
    while (h < headerEnd) {
      const nameLen = buffer.readUInt8(h);
      h += 1;
      const name = buffer.toString('utf8', h, h + nameLen);
      h += nameLen;
      const valueType = buffer.readUInt8(h);
      h += 1;
      if (valueType === 7) {
        const valueLen = buffer.readUInt16BE(h);
        h += 2;
        headers[name] = buffer.toString('utf8', h, h + valueLen);
        h += valueLen;
      } else {
        const width =
          valueType === 8
            ? 2
            : valueType === 5
              ? 4
              : valueType === 6 || valueType === 7
                ? 8
                : valueType === 4
                  ? 1
                  : 8;
        h += width;
      }
    }
    const payloadStart = offset + 12 + headerLen;
    const payload = buffer.subarray(payloadStart, offset + totalLen - 4);
    frames.push({ headers, payload: Buffer.from(payload) });
    offset += totalLen;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** eventstream 字节流 → anthropic 事件 SSE 字节流（:event-type 头 → event: 行） */
export function eventstreamToClaudeSse(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { frames, rest } = parseEventstreamFrames(Buffer.from(pending));
        if (frames.length === 0) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          pending = concatBytes(pending, value!);
          continue;
        }
        pending = new Uint8Array(rest);
        for (const frame of frames) {
          const eventType =
            typeof frame.headers[':event-type'] === 'string'
              ? frame.headers[':event-type']
              : 'unknown';
          const payloadText = frame.payload.toString('utf8');
          controller.enqueue(enc.encode(`event: ${eventType}\ndata: ${payloadText}\n\n`));
        }
        return;
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

// ─────────────────── 适配器 ───────────────────

export class AwsBedrockAdapter implements ProtocolAdapter {
  readonly protocol = 'aws-bedrock';
  readonly supportedEndpoints: readonly Endpoint[] = ['chat'];

  planRequest(
    channel: ChannelDesc,
    {
      model,
      stream,
      requestId,
    }: { endpoint: 'chat' | 'embeddings'; model: string; requestId: string; stream: boolean },
  ): { path: string; headers: Record<string, string> } {
    void requestId;
    const action = stream ? 'invoke-with-response-stream' : 'invoke';
    return {
      path: `/model/${encodeURIComponent(model)}/${action}`,
      headers: { 'content-type': 'application/json' },
    };
  }

  /** Bedrock SigV4 的认证头需要完整 URL 与最终 body——由 create-ai 经 signRequest 钩子注入 */
  signRequest?: (args: {
    url: URL;
    body: string;
    apiKey: string;
    at: Date;
  }) => Record<string, string>;

  finalizeRequestBody(
    body: Record<string, unknown>,
    { model, stream }: { endpoint: 'chat' | 'embeddings'; model: string; stream: boolean },
  ): Record<string, unknown> {
    const claudeBody = chatRequestToClaude({ ...body, model });
    claudeBody.anthropic_version = 'bedrock-2023-05-31';
    if (stream) claudeBody.stream = true;
    return claudeBody;
  }

  normalizeRequest(
    req: unknown,
    _rules: ParamRules,
    _endpoint: Endpoint,
  ): { body: unknown; adjustments: ParamAdjustment[] } {
    void _endpoint;
    return { body: req, adjustments: [] as ParamAdjustment[] };
  }

  translateResponseBody(body: unknown): unknown {
    return claudeResponseToChat(body);
  }

  /** model 参数不参与 claude 族转换：真实模型名从 message_start 提取（v1 同语义） */
  translateUpstreamStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return claudeUpstreamToCanonicalStream(eventstreamToClaudeSse(stream));
  }

  extractUsage(res: unknown): Usage | null {
    const j = res as Record<string, unknown> | null;
    const u = claudeUsageToUsage(j?.usage);
    return u
      ? {
          inputTokens: u.promptTokens,
          cachedInputTokens: u.cachedTokens,
          outputTokens: u.completionTokens,
          estimated: false,
          raw: j?.usage,
        }
      : null;
  }

  mapError(
    status: number | undefined,
    body: unknown,
    headers?: Record<string, string>,
  ): UpstreamError {
    return tableOrFallback({ table: BEDROCK_CODE_KINDS, status, body, headers });
  }

  probeRequests(_channel: ChannelDesc): { path: string; headers: Record<string, string> }[] {
    // Bedrock 无廉价 GET 探测：invoke 空体会 4xx——用列表模型 GET（SigV4 由传输层统一签名）
    return [{ path: '/models', headers: {} }];
  }
}

export { signBedrockRequest as signAwsRequest };
export type { UpstreamError, Usage };
