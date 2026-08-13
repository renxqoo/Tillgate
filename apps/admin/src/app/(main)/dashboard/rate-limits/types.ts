export type RateLimitKind = "user" | "model" | "channel" | "key";

/** 统一的限流行（4 类实体映射成同构结构，共用表格/弹窗） */
export interface RateLimitItem {
  id: number;
  /** 主标识：user email / model externalName / channel name / key name */
  label: string;
  /** 次标识：user displayName / key preview（脱敏） */
  sublabel?: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: number;
}
