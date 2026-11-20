import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #781 — invoice document registration by IPFS CID.
 *
 * - `deleted_at` soft-deletes documents when their invoice is withdrawn.
 * - `filename` / `mime_type` become optional: documents registered by CID only
 *   carry a type and size.
 * - A partial unique index stops the same CID being registered twice on one
 *   invoice while still allowing re-registration after a soft delete.
 */
export class AddInvoiceDocumentRegistration1755400000000 implements MigrationInterface {
  name = "AddInvoiceDocumentRegistration1755400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoice_documents"
      ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
    `);
    await queryRunner.query(`
      ALTER TABLE "invoice_documents"
      ALTER COLUMN "filename" DROP NOT NULL,
      ALTER COLUMN "mime_type" DROP NOT NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_invoice_documents_invoice_cid_active"
      ON "invoice_documents" ("invoice_id", "cid")
      WHERE "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."uq_invoice_documents_invoice_cid_active";`
    );
    // Rows registered without a filename/mime type cannot satisfy NOT NULL.
    await queryRunner.query(
      `UPDATE "invoice_documents" SET "filename" = COALESCE("filename", "cid"), "mime_type" = COALESCE("mime_type", 'application/octet-stream');`
    );
    await queryRunner.query(`
      ALTER TABLE "invoice_documents"
      ALTER COLUMN "filename" SET NOT NULL,
      ALTER COLUMN "mime_type" SET NOT NULL;
    `);
    await queryRunner.query(`ALTER TABLE "invoice_documents" DROP COLUMN IF EXISTS "deleted_at";`);
  }
}
