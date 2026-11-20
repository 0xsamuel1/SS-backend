import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #783 — secondary market lock-up, fee/royalty settlement.
 *
 * - `invoices.lock_up_expiry`: holders cannot list before this moment.
 * - `invoices.secondary_royalty_bps`: issuer royalty on secondary sales.
 * - `secondary_trades`: one settlement record per purchase, with the gross
 *   amount split into platform fee, royalty and seller proceeds.
 */
export class AddSecondaryMarketLockUpAndTrades1755500000000 implements MigrationInterface {
  name = "AddSecondaryMarketLockUpAndTrades1755500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoices"
      ADD COLUMN IF NOT EXISTS "lock_up_expiry" timestamptz,
      ADD COLUMN IF NOT EXISTS "secondary_royalty_bps" integer NOT NULL DEFAULT 0;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "invoices"
        ADD CONSTRAINT "chk_invoices_secondary_royalty_bps"
        CHECK ("secondary_royalty_bps" BETWEEN 0 AND 1000);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "secondary_trades" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "listing_id" uuid NOT NULL,
        "invoice_id" uuid NOT NULL,
        "seller_wallet" varchar(56) NOT NULL,
        "seller_id" uuid,
        "buyer_wallet" varchar(56) NOT NULL,
        "buyer_id" uuid NOT NULL,
        "fractions" decimal(18,4) NOT NULL,
        "price_per_fraction" decimal(18,4) NOT NULL,
        "gross_amount" decimal(18,4) NOT NULL,
        "platform_fee_bps" integer NOT NULL,
        "platform_fee_amount" decimal(18,4) NOT NULL,
        "royalty_bps" integer NOT NULL,
        "royalty_amount" decimal(18,4) NOT NULL,
        "royalty_recipient_wallet" varchar(56),
        "seller_proceeds" decimal(18,4) NOT NULL,
        "transaction_hash" varchar(128),
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "fk_secondary_trades_listing" FOREIGN KEY ("listing_id")
          REFERENCES "secondary_listings" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_secondary_trades_invoice" FOREIGN KEY ("invoice_id")
          REFERENCES "invoices" ("id") ON DELETE RESTRICT,
        CONSTRAINT "chk_secondary_trades_split"
          CHECK ("platform_fee_amount" + "royalty_amount" + "seller_proceeds" = "gross_amount")
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_secondary_trades_listing" ON "secondary_trades" ("listing_id");`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_secondary_trades_invoice" ON "secondary_trades" ("invoice_id", "created_at");`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_secondary_trades_buyer" ON "secondary_trades" ("buyer_wallet");`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "secondary_trades";`);
    await queryRunner.query(
      `ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "chk_invoices_secondary_royalty_bps";`
    );
    await queryRunner.query(`
      ALTER TABLE "invoices"
      DROP COLUMN IF EXISTS "secondary_royalty_bps",
      DROP COLUMN IF EXISTS "lock_up_expiry";
    `);
  }
}
