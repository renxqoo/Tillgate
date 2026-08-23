/**
 * 充值金额校验（纯函数，可测）：十进制、1 元 – 10 万元（分单位 BigInt 精确比较）。
 */
export const TOPUP_PRESETS = ['10', '50', '100', '500'] as const;

const TOPUP_MIN_CENTS = 100n;
const TOPUP_MAX_CENTS = 10_000_000n;

export function isValidTopupAmount(raw: string): boolean {
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(raw)) return false;
  const [yuan = '0', fraction = ''] = raw.split('.');
  const cents = BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents >= TOPUP_MIN_CENTS && cents <= TOPUP_MAX_CENTS;
}
