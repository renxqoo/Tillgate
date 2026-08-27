/**
 * 支付验签密钥轮换双读窗：rotatable 字段变更后旧密文进入
 * previous_secrets；窗口内参与验签（先新后旧），到期自愈——无需人工清理。
 */
import { PAYMENT_SECRET_ROTATION_WINDOW_MS } from './keys';

/** 窗口判定（时钟注入可测）：无轮换记录 = 不在窗内 */
export function withinRotationWindow(rotatedAt: Date | null, nowMs: number): boolean {
  if (rotatedAt == null) return false;
  return nowMs - rotatedAt.getTime() < PAYMENT_SECRET_ROTATION_WINDOW_MS;
}
