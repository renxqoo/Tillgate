/**
 * 静默溢出告警接线（P1#4）：订阅 ai 包 success 事件的 contextOverflow 旗标 →
 * notify_outbox 入箱（事件即事实，worker 按渠道订阅投递 webhook/email）。
 *
 * 语义：溢出不翻转成功、不影响计费（计费按供应商 usage 是正确口径）——
 * 这是可观测告警：供应商对超窗输入静默截断，运营需要知道（用户可能拿到
 * 缺上下文的回答）。dedupe 按请求幂等；入箱失败静默（告警不反噬请求）。
 */
import { notifyOutbox } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';

interface AiEventLike {
  type: string;
  requestId?: string;
  channelKey?: string;
  contextOverflow?: boolean;
  model?: string;
  channelId?: number;
  channelName?: string;
  usage?: { inputTokens?: number } | null;
}

export function wireContextOverflowAlert(
  ai: { onEvent(cb: (e: AiEventLike) => void): () => void },
  db: Db,
): () => void {
  return ai.onEvent((e) => {
    if (e.type !== 'success' || e.contextOverflow !== true) return;
    void db
      .insert(notifyOutbox)
      .values({
        event: 'context_overflow',
        payload: {
          requestId: e.requestId ?? null,
          channelKey: e.channelKey ?? null,
          model: e.model ?? null,
          inputTokens: e.usage?.inputTokens ?? null,
        },
        dedupeKey: `context-overflow:${e.requestId ?? 'unknown'}`,
      })
      .onConflictDoNothing()
      .catch(() => {
        // 告警旁路：入箱失败只丢一条告警，绝不能影响请求路径
      });
  });
}

/**
 * 死凭据软防护告警接线：tracker 连续失败达阈值翻转 invalid 时（ai 包事件）→
 * notify_outbox 入箱。替代原「单次 401 即落库 status=4 硬杀」的告警职责——
 * 渠道不再永久退出路由（Redis 软跳过 + TTL 自愈），人工经管理台状态控制面裁决。
 */
export function wireDeadCredentialAlert(
  ai: { onEvent(cb: (e: AiEventLike) => void): () => void },
  db: Db,
): () => void {
  return ai.onEvent((e) => {
    if (e.type !== 'channel_dead_credential' || e.channelId == null) return;
    void db
      .insert(notifyOutbox)
      .values({
        event: 'channel_disabled',
        payload: {
          channelId: e.channelId,
          channelName: e.channelName ?? null,
          reason: 'dead_credential',
        },
        dedupeKey: `channel-disabled:${e.channelId}:${Date.now()}`,
      })
      .onConflictDoNothing()
      .catch(() => {
        // 告警旁路：入箱失败只丢一条告警，不影响请求路径
      });
  });
}
