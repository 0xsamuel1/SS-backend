import request from "supertest";
import express from "express";
import type { DataSource } from "typeorm";
import { createIssuerProfileRouter } from "../../src/routes/issuer-profile.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import {
  ISSUER_SETTLEMENT_HISTORY_VIEW,
  IssuerProfileService,
} from "../../src/services/issuer-profile.service";
import { encodeCursor } from "../../src/utils/cursor-pagination.utils";
import { InvoiceStatus, UserType } from "../../src/types/enums";
import type { InvoiceTransition } from "../../src/lib/invoice-state-machine";

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(),
} as never;

const SELLER_ID = "11111111-1111-4111-8111-111111111111";
const issuerUser = {
  id: SELLER_ID,
  stellarAddress: "GISSUER",
  userType: UserType.SELLER,
  isKycVerified: true,
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
};

function invoiceRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    invoice_number: `INV-${n}`,
    title: null,
    amount: "1000.0000",
    status: InvoiceStatus.FUNDED,
    yield_bps: 800 + n,
    adjustment_bps: null,
    due_date: "2026-03-01",
    settled_at: null,
    created_at: new Date(Date.UTC(2026, 0, n, 10)),
    ...overrides,
  };
}

interface FakeData {
  user?: typeof issuerUser | (Omit<typeof issuerUser, "userType"> & { userType: UserType }) | null;
  trackRecord?: Record<string, unknown>;
  history?: Record<string, unknown>[];
  yieldRows?: Record<string, unknown>[];
  hasInvoices?: boolean;
  driver?: string;
}

function fakeDataSource(data: FakeData = {}) {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("REFRESH MATERIALIZED VIEW")) return [];
    if (sql.includes(`FROM "${ISSUER_SETTLEMENT_HISTORY_VIEW}"`) && sql.includes("COUNT(*)")) {
      return [data.trackRecord ?? {}];
    }
    if (sql.includes(`SELECT "issuer_name"`)) return [{ issuer_name: "Acme Ltd" }];
    if (sql.includes("SELECT 1 FROM")) return data.hasInvoices ? [{}] : [];
    if (sql.includes(`i."invoice_number"`)) {
      const limit = params[2] as number;
      return (data.history ?? []).slice(0, limit);
    }
    if (sql.includes(`i."yield_bps" IS NOT NULL`)) return data.yieldRows ?? [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const dataSource = {
    options: { type: data.driver ?? "postgres" },
    query,
    getRepository: () => ({
      findOne: jest.fn(async () => (data.user === undefined ? issuerUser : data.user)),
    }),
  } as unknown as DataSource;
  return { dataSource, query };
}

function buildApp(service: IssuerProfileService) {
  const app = express();
  app.use("/api/v1", createIssuerProfileRouter({ issuerProfileService: service }));
  app.use(createErrorMiddleware(silentLogger));
  return app;
}

describe("GET /api/v1/issuers/:wallet (issue #779)", () => {
  it("returns identity, track record, invoice history and dynamic yield", async () => {
    const { dataSource } = fakeDataSource({
      trackRecord: {
        settled_count: "4",
        on_time_count: "3",
        late_count: "1",
        avg_days_to_settle: "41.12345",
        total_volume: "4002.5000",
      },
      history: [
        invoiceRow(2, {
          status: InvoiceStatus.SETTLED,
          adjustment_bps: -25,
          settled_at: new Date("2026-03-01T12:00:00.000Z"),
        }),
        invoiceRow(1),
      ],
      yieldRows: [
        invoiceRow(3, { adjustment_bps: 15 }),
        invoiceRow(2, { adjustment_bps: -25 }),
        invoiceRow(1),
      ],
    });
    const res = await request(buildApp(new IssuerProfileService(dataSource, silentLogger)))
      .get("/api/v1/issuers/GISSUER")
      .expect(200);

    const { identity, track_record, invoice_history, dynamic_yield } = res.body.data;
    expect(identity).toEqual({
      wallet: "GISSUER",
      display_name: "Acme Ltd",
      user_type: UserType.SELLER,
      kyc_verified: true,
      member_since: "2025-01-01T00:00:00.000Z",
    });
    expect(track_record).toEqual({
      settled_count: 4,
      on_time_count: 3,
      late_count: 1,
      avg_days_to_settle: 41.12,
      total_volume_usd: "4002.50",
    });
    expect(invoice_history.items[0]).toMatchObject({
      invoice_number: "INV-2",
      status: InvoiceStatus.SETTLED,
      yield: { base_bps: 802, adjustment_bps: -25, effective_bps: 777 },
      due_date: "2026-03-01",
      settlement_date: "2026-03-01T12:00:00.000Z",
    });
    expect(invoice_history.items[1].settlement_date).toBeNull();
    expect(invoice_history.has_more).toBe(false);
    expect(invoice_history.next_cursor).toBeNull();

    // Newest invoice (INV-3: 803 + 15) is the current rate; sparkline is oldest first.
    expect(dynamic_yield.current_rate_bps).toBe(818);
    expect(dynamic_yield.current_rate_percent).toBe(8.18);
    expect(dynamic_yield.sparkline.map((p: { effective_bps: number }) => p.effective_bps)).toEqual([
      801, 777, 818,
    ]);
  });

  it("returns empty track record and null current rate for an issuer with no settlements", async () => {
    const { dataSource } = fakeDataSource({
      trackRecord: {
        settled_count: "0",
        on_time_count: "0",
        late_count: "0",
        avg_days_to_settle: null,
        total_volume: "0",
      },
    });
    const res = await request(buildApp(new IssuerProfileService(dataSource, silentLogger)))
      .get("/api/v1/issuers/GISSUER")
      .expect(200);

    expect(res.body.data.track_record).toEqual({
      settled_count: 0,
      on_time_count: 0,
      late_count: 0,
      avg_days_to_settle: null,
      total_volume_usd: "0.00",
    });
    expect(res.body.data.dynamic_yield).toEqual({
      current_rate_bps: null,
      current_rate_percent: null,
      sparkline: [],
    });
  });

  it("paginates invoice history with a cursor", async () => {
    const history = [invoiceRow(3), invoiceRow(2), invoiceRow(1)];
    const { dataSource, query } = fakeDataSource({ history });
    const app = buildApp(new IssuerProfileService(dataSource, silentLogger));

    const first = await request(app).get("/api/v1/issuers/GISSUER?limit=2").expect(200);
    const page = first.body.data.invoice_history;
    expect(page.items).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBe(encodeCursor(history[1].created_at, history[1].id));

    await request(app)
      .get(`/api/v1/issuers/GISSUER?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`)
      .expect(200);
    const historyCall = query.mock.calls.filter(([sql]) => sql.includes(`i."invoice_number"`))[1];
    expect(historyCall[0]).toContain(`< ($4::timestamptz, $5::uuid)`);
    expect(historyCall[1]).toEqual([
      SELLER_ID,
      expect.any(Array),
      3,
      history[1].created_at.toISOString(),
      history[1].id,
    ]);
  });

  it("rejects an invalid cursor or limit with 400", async () => {
    const { dataSource } = fakeDataSource();
    const app = buildApp(new IssuerProfileService(dataSource, silentLogger));

    const badCursor = await request(app).get("/api/v1/issuers/GISSUER?cursor=garbage").expect(400);
    expect(badCursor.body.error.code).toBe("INVALID_CURSOR");
    const nonUuid = encodeCursor(new Date(), "not-a-uuid");
    await request(app).get(`/api/v1/issuers/GISSUER?cursor=${nonUuid}`).expect(400);

    for (const limit of ["0", "101", "abc"]) {
      const res = await request(app).get(`/api/v1/issuers/GISSUER?limit=${limit}`).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("returns 404 for wallets with no issuer record", async () => {
    const unknown = fakeDataSource({ user: null });
    const res = await request(buildApp(new IssuerProfileService(unknown.dataSource, silentLogger)))
      .get("/api/v1/issuers/GNOBODY")
      .expect(404);
    expect(res.body.error.code).toBe("ISSUER_NOT_FOUND");

    const investor = fakeDataSource({
      user: { ...issuerUser, userType: UserType.INVESTOR },
      hasInvoices: false,
    });
    await request(buildApp(new IssuerProfileService(investor.dataSource, silentLogger)))
      .get("/api/v1/issuers/GISSUER")
      .expect(404);
  });

  it("treats an investor-type wallet with invoices as an issuer", async () => {
    const { dataSource } = fakeDataSource({
      user: { ...issuerUser, userType: UserType.INVESTOR },
      hasInvoices: true,
    });
    await request(buildApp(new IssuerProfileService(dataSource, silentLogger)))
      .get("/api/v1/issuers/GISSUER")
      .expect(200);
  });
});

describe("issuer settlement history view refresh (issue #779)", () => {
  function transition(to: InvoiceStatus): InvoiceTransition {
    return { to, invoice: { id: "inv-1" } } as unknown as InvoiceTransition;
  }

  it("refreshes the materialized view when an invoice settles", async () => {
    const { dataSource, query } = fakeDataSource();
    const effect = new IssuerProfileService(
      dataSource,
      silentLogger
    ).createSettlementRefreshEffect();

    await effect(transition(InvoiceStatus.FUNDED));
    expect(query).not.toHaveBeenCalled();

    await effect(transition(InvoiceStatus.SETTLED));
    expect(query).toHaveBeenCalledWith(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY "${ISSUER_SETTLEMENT_HISTORY_VIEW}"`
    );
  });

  it("logs and swallows refresh failures so settlement is not affected", async () => {
    const { dataSource, query } = fakeDataSource();
    query.mockRejectedValueOnce(new Error("lock timeout"));
    const logger = { ...(silentLogger as object), warn: jest.fn() };
    const effect = new IssuerProfileService(
      dataSource,
      logger as never
    ).createSettlementRefreshEffect();

    await expect(effect(transition(InvoiceStatus.SETTLED))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to refresh issuer settlement history view.",
      expect.objectContaining({ invoice_id: "inv-1", error: "lock timeout" })
    );
  });

  it("coalesces concurrent refreshes into at most one follow-up", async () => {
    const { dataSource, query } = fakeDataSource();
    let release!: () => void;
    query.mockImplementationOnce(
      () => new Promise<never[]>((resolve) => (release = () => resolve([])))
    );
    const service = new IssuerProfileService(dataSource, silentLogger);

    const calls = [
      service.refreshSettlementHistory(),
      service.refreshSettlementHistory(),
      service.refreshSettlementHistory(),
    ];
    release();
    await Promise.all(calls);

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("skips the refresh on non-Postgres databases", async () => {
    const { dataSource, query } = fakeDataSource({ driver: "sqlite" });
    await new IssuerProfileService(dataSource, silentLogger).refreshSettlementHistory();
    expect(query).not.toHaveBeenCalled();
  });
});
