import { decrypt } from '/Users/wrr/work/ai-getway/packages/core/src/crypto.ts';
const apiKey = decrypt('enc:v1:30290e950aa5f1cb214910dd:cf6f073ededa22ad6107b7c8aa8fe23a:f26207039493924f5d5d4dcb2c000dcf10a7c3ec35f60fca0e4a0399417fa2bc6e45fbf2d2ed09d149f62c74c612170c7dd86c0963a3e479954dcd27c40f3f27fe8e7ad86ba8535024e910cfdc00de29db62479f2433f4994fd9b337c68708996513d6c0383e7948e69bffb50446a5e283f78d135099dff8a06e26fe32', 'b6b8e44627d238e7782128142f0994ed40dceb2475432aeb52cf6ce221b20863');
const start = Date.now();
try {
  const res = await fetch('https://api.minimaxi.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'MiniMax-M3', max_tokens: 20000, messages: [{ role: 'user', content: '写一篇 3000 字的散文' }] }),
  });
  const text = await res.text();
  console.log('elapsed:', Math.round((Date.now() - start) / 1000) + 's, status:', res.status);
  console.log('body head:', text.slice(0, 200));
} catch (e) {
  console.log('elapsed:', Math.round((Date.now() - start) / 1000) + 's, THREW:', (e as Error).message, (e as Error).cause ?? '');
}
