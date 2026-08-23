import type { LandingT } from './ui';

/** 接入示例代码（真实 Base URL + 占位 Key），与 api-guide 同源口径 */
export function buildSamples(t: LandingT, base: string) {
  const KEY = t('cmdToken');
  const MODEL = t('cmdModel');
  const HELLO = t('cmdHello');

  return {
    py: `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${KEY}",
)

resp = client.chat.completions.create(
    model="${MODEL}",
    messages=[{"role": "user", "content": "${HELLO}"}],
)
print(resp.choices[0].message.content)`,
    node: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${base}',
  apiKey: '${KEY}',
});
const res = await client.chat.completions.create({
  model: '${MODEL}',
  messages: [{ role: 'user', content: '${HELLO}' }],
});
console.log(res.choices[0].message.content);`,
    curl: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${MODEL}", "messages": [{"role": "user", "content": "${HELLO}"}]}'`,
  };
}
