/**
 * 渠道进货凭证解析（纯函数）：data URL → 字节 + MIME 白名单 + 大小上限。
 * 存储是 I/O 边界（ports/voucher-storage）；本文件只做形状与配额裁决。
 */
import { controlPlaneErrors } from '../../errors';

const VOUCHER_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

export interface VoucherPayload {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

/** data:image/xxx;base64 载荷解析（白名单外类型/超限在包边界拒绝） */
export function parseVoucherDataUrl(dataUrl: string, maxBytes: number): VoucherPayload {
  const match = VOUCHER_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw controlPlaneErrors.business('invalid_voucher', { dataUrl: 'malformed' });
  }
  // 捕获组与整串匹配同生共死,解构收窄替代下标断言
  const [, mimeType, base64] = match;
  if (mimeType === undefined || base64 === undefined) {
    throw controlPlaneErrors.business('invalid_voucher', { dataUrl: 'malformed' });
  }
  const data = Uint8Array.from(Buffer.from(base64, 'base64'));
  if (data.byteLength > maxBytes) {
    throw controlPlaneErrors.business('voucher_too_large', {
      bytes: data.byteLength,
      maxBytes,
    });
  }
  return { data, mimeType };
}
