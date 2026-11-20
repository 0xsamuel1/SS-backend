import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Settlement record of one secondary market purchase (issue #783): how many
 * fractions moved from seller to buyer and how the gross amount was split
 * between platform fee, issuer royalty and seller proceeds.
 *
 * Invariant: platform_fee_amount + royalty_amount + seller_proceeds = gross_amount.
 */
@Entity("secondary_trades")
@Index("idx_secondary_trades_listing", ["listingId"])
@Index("idx_secondary_trades_invoice", ["invoiceId", "createdAt"])
@Index("idx_secondary_trades_buyer", ["buyerWallet"])
export class SecondaryTrade {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "listing_id", type: "uuid" })
  listingId!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "seller_wallet", type: "varchar", length: 56 })
  sellerWallet!: string;

  @Column({ name: "seller_id", type: "uuid", nullable: true })
  sellerId!: string | null;

  @Column({ name: "buyer_wallet", type: "varchar", length: 56 })
  buyerWallet!: string;

  @Column({ name: "buyer_id", type: "uuid" })
  buyerId!: string;

  @Column({ name: "fractions", type: "decimal", precision: 18, scale: 4 })
  fractions!: string;

  @Column({ name: "price_per_fraction", type: "decimal", precision: 18, scale: 4 })
  pricePerFraction!: string;

  @Column({ name: "gross_amount", type: "decimal", precision: 18, scale: 4 })
  grossAmount!: string;

  @Column({ name: "platform_fee_bps", type: "int" })
  platformFeeBps!: number;

  @Column({ name: "platform_fee_amount", type: "decimal", precision: 18, scale: 4 })
  platformFeeAmount!: string;

  @Column({ name: "royalty_bps", type: "int" })
  royaltyBps!: number;

  @Column({ name: "royalty_amount", type: "decimal", precision: 18, scale: 4 })
  royaltyAmount!: string;

  @Column({ name: "royalty_recipient_wallet", type: "varchar", length: 56, nullable: true })
  royaltyRecipientWallet!: string | null;

  @Column({ name: "seller_proceeds", type: "decimal", precision: 18, scale: 4 })
  sellerProceeds!: string;

  @Column({ name: "transaction_hash", type: "varchar", length: 128, nullable: true })
  transactionHash!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
