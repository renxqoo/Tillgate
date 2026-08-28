/**
 * 落库加解密 port(TOTP secret 静态加密)。装配注入 runtime.createCipher 产物;
 * enc:v1 格式单一真相在 runtime,本包不编译依赖 runtime。
 */
export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}
