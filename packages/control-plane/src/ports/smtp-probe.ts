/**
 * SMTP 探针 port：集成设置（smtp）连通性探测的执行边界——真实连接 + 登录认证，
 * 不发送邮件。实现由装配用 nodemailer verify() 包装（adapters/smtp-probe）；
 * 本包不 import nodemailer（传输细节归 app 装配层）。
 */

import type { ProbeOutcome } from './upstream-probe';

/** 探针目标（pass 已解密——仅存在于探针调用内存内；形状与快照 SmtpConfig 同构） */
export interface SmtpProbeTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export interface SmtpProbe {
  /**
   * 连接 + 认证校验（465 隐式 TLS / 其余端口 STARTTLS，与发信传输器同口径）。
   * 上游失败（不可达/认证拒绝/超时）也是探针结果（ok:false），不是管理面错误。
   */
  probeSmtp(target: SmtpProbeTarget): Promise<ProbeOutcome>;
}
