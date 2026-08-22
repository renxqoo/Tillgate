/**
 * 密钥加解密 port：渠道上游 Key 落库加密（AES-256-GCM，密文 enc:v1 单 key 单格式）。
 * 与 runtime 基础设施包的 Cipher 结构兼容——装配直接注入其 createCipher(ENCRYPTION_KEY)，
 * 本包无需编译依赖它（DESIGN §5 依赖白名单）。
 */
export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(packed: string): string;
}
