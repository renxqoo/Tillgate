// client-safe 类型（不依赖 @ai-gateway/api-client，避免拉入 server-only next/headers）
export interface UserRow {
  id: number;
  issuer: string | null;
  subject: string;
  identityProvider: string | null;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  rateCardName: string | null;
  balance: string;
  reservedBalance: string;
  availableBalance: string;
  creditLimit: string;
  dailySpendLimit: string | null;
  status: number;
  freezeReason: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RateCardOption {
  id: number;
  name: string;
  coefficient: string;
}
