/**
 * 告警邮件模板(品牌抽为注入参数):
 * subject = `[品牌] 告警:事件名`;text = 事件名 + 两空格缩进的 pretty JSON payload。
 * 中文属运维提示文案;验证码邮件渲染归 identity,不在此。
 */

export interface AlertEmail {
  readonly subject: string;
  readonly text: string;
}

export function renderAlertEmail(
  event: string,
  payload: Record<string, unknown>,
  brand: string,
): AlertEmail {
  return {
    subject: `[${brand}] 告警：${event}`,
    text: `${event}\n${JSON.stringify(payload, null, 2)}`,
  };
}
