import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #779 — issuer profile aggregation.
 *
 * One row per settled invoice with its settlement timestamp (the latest
 * `→ settled` row in `invoice_status_history`, falling back to the invoice's
 * `updated_at` for invoices settled before history was recorded), whether it
 * settled on time, and how many days it took. The issuer profile endpoint
 * aggregates its track record from this view instead of scanning invoices and
 * history on every request. The view is refreshed whenever an invoice settles.
 *
 * The unique index on `invoice_id` is required for
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY`, which keeps reads unblocked.
 */
export class CreateIssuerSettlementHistoryView1755300000000 implements MigrationInterface {
  name = "CreateIssuerSettlementHistoryView1755300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "issuer_settlement_history_mv" AS
      SELECT
        s.invoice_id,
        s.seller_id,
        s.amount,
        s.due_date,
        s.settled_at,
        (s.settled_at AT TIME ZONE 'UTC')::date <= s.due_date AS settled_on_time,
        EXTRACT(EPOCH FROM (s.settled_at - s.created_at)) / 86400.0 AS days_to_settle
      FROM (
        SELECT
          i."id" AS invoice_id,
          i."seller_id" AS seller_id,
          i."amount" AS amount,
          i."due_date" AS due_date,
          i."created_at" AS created_at,
          COALESCE(h.settled_at, i."updated_at") AS settled_at
        FROM "invoices" i
        LEFT JOIN (
          SELECT "invoice_id", MAX("created_at") AS settled_at
          FROM "invoice_status_history"
          WHERE "to_status" = 'settled'
          GROUP BY "invoice_id"
        ) h ON h."invoice_id" = i."id"
        WHERE i."status" = 'settled' AND i."deleted_at" IS NULL
      ) s
      WITH DATA;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_issuer_settlement_history_mv_invoice"
      ON "issuer_settlement_history_mv" ("invoice_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_issuer_settlement_history_mv_seller"
      ON "issuer_settlement_history_mv" ("seller_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "issuer_settlement_history_mv";`);
  }
}
