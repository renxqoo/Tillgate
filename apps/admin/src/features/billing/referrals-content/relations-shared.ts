export interface ReferralRelationRow {
  id: number;
  inviterUserId: number;
  inviterEmail: string | null;
  inviteeUserId: number;
  inviteeEmail: string | null;
  status: number;
  createdAt: string;
  commissionTotal: string;
}
