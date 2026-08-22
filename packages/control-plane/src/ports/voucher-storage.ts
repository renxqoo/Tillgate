/**
 * 渠道进货凭证存储 port：凭证字节 I/O 边界（默认 DB voucher_blobs bytea，后续可切 OSS）。
 * 解析与配额裁决在 domain/channel/voucher（纯函数）；本 port 只管存取。
 */
export interface VoucherStorage {
  /** 存凭证 → 键；MIME 白名单外的类型拒绝 */
  save(data: Uint8Array, mimeType: string): Promise<string>;
  /** 取凭证；键非法/不存在 → null */
  load(key: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
}
