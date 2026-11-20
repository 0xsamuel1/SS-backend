import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum AccreditationTier {
  UNACCREDITED = "unaccredited",
  ACCREDITED = "accredited",
  QUALIFIED = "qualified",
}

/**
 * Review lifecycle of a wallet's accreditation (issue #780).
 *
 * `active` accreditations are only valid until `expiryDate`; once that passes
 * the wallet is blocked from investing in accreditation-gated invoices until a
 * renewal is submitted (`pending_review`) and approved again (`active`).
 */
export enum AccreditationStatus {
  ACTIVE = "active",
  PENDING_REVIEW = "pending_review",
  REJECTED = "rejected",
}

export const ACCREDITATION_LIMITS: Record<AccreditationTier, number> = {
  [AccreditationTier.UNACCREDITED]: 100_000,
  [AccreditationTier.ACCREDITED]: 1_000_000,
  [AccreditationTier.QUALIFIED]: 10_000_000,
};

@Entity("investor_accreditations")
@Index("idx_investor_accreditation_wallet", ["walletAddress"], { unique: true })
export class InvestorAccreditation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "wallet_address", type: "varchar", length: 256, unique: true })
  walletAddress!: string;

  @Column({
    type: "enum",
    enum: AccreditationTier,
    default: AccreditationTier.UNACCREDITED,
  })
  tier!: AccreditationTier;

  @Column({
    type: "varchar",
    length: 32,
    default: AccreditationStatus.ACTIVE,
  })
  status!: AccreditationStatus;

  @Column({ name: "verification_date", type: "timestamptz", nullable: true })
  verificationDate!: Date | null;

  @Column({ name: "verification_source", type: "varchar", length: 255, nullable: true })
  verificationSource!: string | null;

  /** When the current accreditation lapses. Null means it does not expire. */
  @Column({ name: "expiry_date", type: "timestamptz", nullable: true })
  expiryDate!: Date | null;

  /** Reference (IPFS hash, storage key or URL) to the latest submitted document. */
  @Column({ name: "document_reference", type: "varchar", length: 512, nullable: true })
  documentReference!: string | null;

  @Column({ name: "renewal_submitted_at", type: "timestamptz", nullable: true })
  renewalSubmittedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
