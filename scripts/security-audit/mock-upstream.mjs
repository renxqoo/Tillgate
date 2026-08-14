/**
 * 极简 OpenAI 兼容 mock 上游（E2E 用，非真实计费）：
 *   - GET  /v1/models            → 连通性探测
 *   - POST /v1/chat/completions  → 返回固定 usage（prompt=1000 / completion=500 → 约 2 元）
 * 用法：node scripts/security-audit/mock-upstream.mjs [port]
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9999);
const PROMPT_TOKENS = Number(process.env.MOCK_PROMPT_TOKENS ?? 1000);
const COMPLETION_TOKENS = Number(process.env.MOCK_COMPLETION_TOKENS ?? 500);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    console.log(`[mock] ${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      return json(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
    }
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      return json(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: {
          prompt_tokens: PROMPT_TOKENS,
          completion_tokens: COMPLETION_TOKENS,
          total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
        },
      });
    }
    json(res, 404, { error: { message: 'not found' } });
  });
});

server.listen(port, () => {
  console.log(`mock-upstream listening on http://localhost:${port} (prompt=${PROMPT_TOKENS} completion=${COMPLETION_TOKENS})`);
});
