/**
 * 密码哈希（scrypt）已抽到 @ai-gateway/identity。
 * 本文件重新导出，保持现有 import 可用。新代码请直接 import @ai-gateway/identity。
 *
 * admins.password_hash 与 users.password_hash 共用同一 scrypt 格式，
 * 迁移管理员时 password_hash 原样搬迁即可继续校验。
 */
export {
  hashPassword,
  verifyPassword,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  HASH_LEN,
} from '@ai-gateway/identity';
