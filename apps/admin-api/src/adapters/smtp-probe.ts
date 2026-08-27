/**
 * SMTP 集成探针桥接件（装配面——仅 assembly.ts 引用）。
 * control-plane 的 SmtpProbe port 由 nodemailer verify() 实现：真实连接 +
 * 登录认证，不发送邮件。传输器口径与发信路径一致（465 隐式 TLS / 其余端口
 * STARTTLS）；每次探针新建传输器——不缓存连接，坏配置即刻生效。
 */
import nodemailer from 'nodemailer';
import type { ProbeOutcome, SmtpProbe, SmtpProbeTarget } from '@tillgate/control-plane';

/** 管理面探针时限（防弹窗长挂；nodemailer 缺省连接超时远长于此） */
const SMTP_PROBE_TIMEOUT_MS = 10_000;

/**
 * @param timeoutMs 连接/问候/套接字三段超时（测试可注入缩短）
 */
export function createSmtpProbe(timeoutMs: number = SMTP_PROBE_TIMEOUT_MS): SmtpProbe {
  return {
    async probeSmtp(target: SmtpProbeTarget): Promise<ProbeOutcome> {
      const startedAt = Date.now();
      let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
      try {
        transport = nodemailer.createTransport({
          host: target.host,
          port: target.port,
          secure: target.port === 465,
          auth: { user: target.user, pass: target.pass },
          connectionTimeout: timeoutMs,
          greetingTimeout: timeoutMs,
          socketTimeout: timeoutMs,
        });
        await transport.verify();
        return { ok: true, durationMs: Date.now() - startedAt };
      } catch (error) {
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: { code: smtpErrorCode(error), message: errorMessage(error) },
        };
      } finally {
        transport?.close();
      }
    },
  };
}

/** nodemailer 错误取传输层 code（EAUTH/ETIMEDOUT/…），无 code 归 'smtp' */
function smtpErrorCode(error: unknown): string {
  if (typeof error === 'object' && error != null && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'smtp';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
