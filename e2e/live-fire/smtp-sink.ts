/**
 * 本地 SMTP sink(live-fire 装置,不提交)。
 * 明文 SMTP(不广播 AUTH/STARTTLS——nodemailer 非 465 端口即明文直投),
 * 捕获邮件全文逐行追加 ndjson,harness 按收件人提取 6 位验证码。
 * 状态机带跨 chunk 行缓冲:nodemailer 会把 DATA 命令与整个邮件体放进同一
 * TCP chunk,命令态循环切到 DATA 后同一 chunk 的剩余字节必须转入数据态。
 * 用法: bun e2e/live-fire/smtp-sink.ts [port=2525] [outFile=.smtp-captures.ndjson]
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const PORT = Number(process.argv[2] ?? 2525);
const OUT = process.argv[3] ?? new URL('./.smtp-captures.ndjson', import.meta.url).pathname;
writeFileSync(OUT, '');

const CRLF = '\r\n';

net
  .createServer((socket) => {
    let from = '';
    let to = '';
    let inData = false;
    let data: string[] = [];
    let buf = '';
    const reply = (line: string) => socket.write(line + CRLF);

    reply('220 sink ready');
    const handleCommand = (line: string) => {
      const cmd = line.trim().toUpperCase();
      if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
        reply('250-sink');
        reply('250 8BITMIME');
      } else if (cmd.startsWith('MAIL FROM')) {
        from = line;
        reply('250 ok');
      } else if (cmd.startsWith('RCPT TO')) {
        to = line;
        reply('250 ok');
      } else if (cmd === 'DATA') {
        inData = true;
        data = [];
        reply('354 go ahead');
      } else if (cmd === 'QUIT') {
        reply('221 bye');
        socket.end();
      } else {
        reply('250 ok');
      }
    };

    socket.on('data', (chunkRaw) => {
      buf += chunkRaw.toString('utf8');
      // 命令态:逐完整行消费,直到出现 DATA(剩余字节留给数据态)
      while (!inData) {
        const idx = buf.indexOf(CRLF);
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleCommand(line);
      }
      // 数据态:找终结符 \r\n.\r\n(或行首单独的 .\r\n / .)
      if (inData) {
        let end = buf.indexOf(`${CRLF}.${CRLF}`);
        let termLen = CRLF.length + 1 + CRLF.length;
        if (end < 0 && (buf === `.${CRLF}` || buf === '.' || buf.startsWith(`.${CRLF}`))) {
          end = 0;
          termLen = buf === '.' ? 1 : 3;
        }
        if (end >= 0) {
          data.push(buf.slice(0, end));
          const body = data.join('');
          appendFileSync(OUT, `${JSON.stringify({ ts: Date.now(), from, to, body })}\n`);
          from = '';
          to = '';
          inData = false;
          data = [];
          buf = buf.slice(end + termLen);
          reply('250 ok: queued as SINK');
          // 同 chunk 后续如有 pipelined 命令,回到循环
          while (!inData) {
            const idx = buf.indexOf(CRLF);
            if (idx < 0) break;
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleCommand(line);
          }
        } else {
          data.push(buf);
          buf = '';
        }
      }
    });
    socket.on('error', () => {});
  })
  .listen(PORT, () => console.log(`[smtp-sink] listening on :${PORT} → ${OUT}`));
