/**
 * 集成配置明文视图合并（写路径与探针路径共享）：
 * 存量装载（secret 解密，失败记入 undecryptable 保持密文形态）
 * + 提交应用（三态校验：值=设置 / null=清除 / 缺席=保持）。
 * 不可解密密文原样保留在合并视图（写入时原样回写、回显全遮；探针时认证必然失败）。
 */
import { isValidFieldValue } from '../../domain/integrations/specs';
import type { IntegrationSpec } from '../../domain/integrations/specs';
import { controlPlaneErrors } from '../../errors';
import type { SecretCipher } from '../../ports/secret-cipher';

const CIPHERTEXT_PREFIX = 'enc:';

export interface MergePlaintextViews {
  readonly stored: Readonly<Record<string, unknown>>;
  readonly submitted: Readonly<Record<string, string | null>>;
}

/** 明文视图合并结果：undecryptable = 解密失败的存量 secret 字段名集合 */
export interface MergedPlaintext {
  readonly merged: Record<string, string>;
  readonly undecryptable: Set<string>;
}

export function mergeIntegrationPlaintext(
  cipher: SecretCipher,
  spec: IntegrationSpec,
  views: MergePlaintextViews,
): MergedPlaintext {
  const merged: Record<string, string> = {};
  const undecryptable = new Set<string>();
  for (const field of spec.fields) {
    const value = views.stored[field.name];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!field.secret) {
      merged[field.name] = value;
      continue;
    }
    const plaintext = safeDecryptSecret(cipher, value);
    if (plaintext == null) {
      undecryptable.add(field.name);
      merged[field.name] = value;
    } else {
      merged[field.name] = plaintext;
    }
  }
  applySubmitted(spec, { merged, undecryptable, submitted: views.submitted });
  return { merged, undecryptable };
}

/** 提交应用：未知字段拒绝 / enc: 伪装拒绝（变体同拒）/ null 清除 / 值校验后覆盖 */
function applySubmitted(
  spec: IntegrationSpec,
  view: {
    readonly merged: Record<string, string>;
    readonly undecryptable: Set<string>;
    readonly submitted: Readonly<Record<string, string | null>>;
  },
): void {
  const { merged, undecryptable } = view;
  for (const [name, value] of Object.entries(view.submitted) as [string, string | null][]) {
    const field = spec.fields.find((f) => f.name === name);
    if (field == null) {
      throw controlPlaneErrors.business('integration_field_invalid', {
        key: spec.key,
        field: name,
      });
    }
    if (value == null) {
      Reflect.deleteProperty(merged, name);
      undecryptable.delete(name);
      continue;
    }
    if (isCiphertextLookalike(value)) {
      throw controlPlaneErrors.business('integration_secret_encrypted', {
        key: spec.key,
        field: name,
      });
    }
    if (!isValidFieldValue(field.kind, value)) {
      throw controlPlaneErrors.business('integration_field_invalid', {
        key: spec.key,
        field: name,
      });
    }
    merged[name] = value;
    undecryptable.delete(name);
  }
}

/** enc: 伪装密文判定（前导空白与大小写变体同拒） */
function isCiphertextLookalike(value: string): boolean {
  return value.trimStart().toLowerCase().startsWith(CIPHERTEXT_PREFIX);
}

/** secret 解密（密文损坏/解密失败 → null；空串同样视为不可用） */
export function safeDecryptSecret(cipher: SecretCipher, packed: string): string | null {
  try {
    const decrypted = cipher.decrypt(packed);
    return decrypted.length > 0 ? decrypted : null;
  } catch {
    return null;
  }
}
