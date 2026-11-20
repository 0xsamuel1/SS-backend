import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #780 — accreditation expiry enforcement.
 *
 * Creates the `investor_accreditations` table (the entity previously had no
 * migration) including expiry/renewal tracking, and adds the per-invoice
 * `requires_accreditation` flag the expiry middleware uses to decide whether
 * an invest or secondary-market purchase must be gated.
 */
export class CreateInvestorAccreditationsWithExpiry1755200000000 implements MigrationInterface {
  name = "CreateInvestorAccreditationsWithExpiry1755200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."investor_accreditations_tier_enum"
          AS ENUM ('unaccredited', 'accredited', 'qualified');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "investor_accreditations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "wallet_address" varchar(256) NOT NULL,
        "tier" "public"."investor_accreditations_tier_enum" NOT NULL DEFAULT 'unaccredited',
        "status" varchar(32) NOT NULL DEFAULT 'active',
        "verification_date" timestamptz,
        "verification_source" varchar(255),
        "expiry_date" timestamptz,
        "document_reference" varchar(512),
        "renewal_submitted_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_investor_accreditation_wallet"
      ON "investor_accreditations" ("wallet_address");
    `);
    await queryRunner.query(`
      ALTER TABLE "invoices"
      ADD COLUMN IF NOT EXISTS "requires_accreditation" boolean NOT NULL DEFAULT true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invoices" DROP COLUMN IF EXISTS "requires_accreditation";`
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_investor_accreditation_wallet";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "investor_accreditations";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."investor_accreditations_tier_enum";`);
  }
}
