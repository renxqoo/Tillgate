/**
 * 模型定价纯规则：免费标记与价格分量的相容性（v1 domain/model-pricing 原样迁移）。
 *
 * 单一真相：isFree 由价格决定（全零价 = 免费），显式 isFree=true 必须全零——
 * 绝不允许「isFree=true + 非零价」的矛盾配置（授权 0 元 / 结算实扣口径分裂）。
 */
export interface PriceTriple {
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
}

const isZero = (v: string): boolean => /^0+(\.0+)?$/.test(v.trim());

/** 全零价 = 免费（目录导入/价格更新推导 isFree 的唯一口径） */
export function isFreeByPrice(p: PriceTriple): boolean {
  return isZero(p.inputPrice) && isZero(p.outputPrice) && isZero(p.cacheInputPrice);
}

/** 显式免费与价格相容（isFree=true → 全部价格分量归零，含缓存写价与单位价）；
 *  合并口径由调用方组好再判。 */
export function freePriceConsistent(
  isFree: boolean,
  p: PriceTriple & { cacheWritePrice?: string; unitPrice?: string },
): boolean {
  return (
    !isFree ||
    (isZero(p.inputPrice) &&
      isZero(p.outputPrice) &&
      isZero(p.cacheInputPrice) &&
      isZero(p.cacheWritePrice ?? '0') &&
      isZero(p.unitPrice ?? '0'))
  );
}
