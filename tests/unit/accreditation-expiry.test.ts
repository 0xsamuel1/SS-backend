import request from "supertest";
import express from "express";
import RedisMock from "ioredis-mock";
import type Redis from "ioredis";
import type { Repository } from "typeorm";
import { createInvestmentRouter } from "../../src/routes/investment.routes";
import { createSecondaryMarketRouter } from "../../src/routes/secondary-market.routes";
import { createInvestorRouter } from "../../src/routes/investor.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import {
  ACCREDITATION_EXPIRED_CODE,
  invoiceIdFromRequest,
  requireUnexpiredAccreditation,
} from "../../src/middleware/accreditation-expiry.middleware";
import {
  ACCREDITATION_CACHE_MAX_TTL_SECONDS,
  InvestorAccreditationService,
  accreditationCacheKey,
  computeAccreditationCacheTtl,
} from "../../src/services/investor-accreditation.service";
import {
  AccreditationStatus,
  AccreditationTier,
  type InvestorAccreditation,
} from "../../src/models/InvestorAccreditation.model";
import type { Invoice } from "../../src/models/Invoice.model";
import type { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { KYCStatus } from "../../src/types/enums";

const WALLET = "GINVESTORWALLET";
const OTHER_WALLET = "GSOMEONEELSE";
const NOW = new Date("2026-06-01T12:00:00.000Z");
const PAST_EXPIRY = new Date("2026-05-01T00:00:00.000Z");
const FUTURE_EXPIRY = new Date("2026-06-01T13:00:00.000Z"); // 1h after NOW

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(),
} as never;

// ioredis-mock instances share one in-memory store, so reset it per test.
beforeEach(async () => {
  await new RedisMock().flushall();
});

/** Minimal in-memory TypeORM repository keyed by one field. */
function memoryRepo<T extends object>(key: keyof T, rows: T[] = []) {
  const store = new Map<unknown, T>(rows.map((row) => [row[key], row]));
  const repo = {
    store,
    findOne: jest.fn(async ({ where }: { where: Partial<T> }) => {
      const row = store.get(where[key]);
      return row ? { ...row } : null;
    }),
    create: jest.fn((data: Partial<T>) => ({ ...data }) as T),
    save: jest.fn(async (row: T) => {
      store.set(row[key], { ...row });
      return row;
    }),
  };
  return repo;
}

function accreditationRow(overrides: Partial<InvestorAccreditation> = {}): InvestorAccreditation {
  return {
    id: "acc-1",
    walletAddress: WALLET,
    tier: AccreditationTier.ACCREDITED,
    status: AccreditationStatus.ACTIVE,
    verificationDate: new Date("2025-06-01T00:00:00.000Z"),
    verificationSource: "manual",
    expiryDate: PAST_EXPIRY,
    documentReference: null,
    renewalSubmittedAt: null,
    createdAt: new Date("2025-06-01T00:00:00.000Z"),
    updatedAt: new Date("2025-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

function setup(options: { accreditation?: Partial<InvestorAccreditation> | null } = {}) {
  const accreditationRepo = memoryRepo<InvestorAccreditation>(
    "walletAddress",
    options.accreditation === null ? [] : [accreditationRow(options.accreditation)]
  );
  const invoiceRepo = memoryRepo<Invoice>("id", [
    { id: "inv-gated", requiresAccreditation: true } as Invoice,
    { id: "inv-open", requiresAccreditation: false } as Invoice,
  ]);
  const listingRepo = memoryRepo<SecondaryListing>("id", [
    { id: "listing-gated", invoiceId: "inv-gated" } as SecondaryListing,
    { id: "listing-open", invoiceId: "inv-open" } as SecondaryListing,
  ]);
  const redis = new RedisMock() as unknown as Redis;

  const service = new InvestorAccreditationService(
    accreditationRepo as unknown as Repository<InvestorAccreditation>,
    invoiceRepo as unknown as Repository<Invoice>,
    listingRepo as unknown as Repository<SecondaryListing>,
    redis,
    () => NOW
  );

  return { service, accreditationRepo, invoiceRepo, listingRepo, redis };
}

function buildApp(service: InvestorAccreditationService, user = { stellarAddress: WALLET }) {
  const authService = {
    getCurrentUser: jest.fn().mockResolvedValue({
      id: "user-1",
      kycStatus: KYCStatus.APPROVED,
      ...user,
    }),
  };
  const investmentService = {
    createInvestment: jest.fn().mockResolvedValue({ id: "investment-1" }),
  };
  const secondaryMarketService = {
    buyListing: jest.fn().mockResolvedValue({ id: "listing-gated" }),
  };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/investments",
    createInvestmentRouter({
      investmentService: investmentService as never,
      authService: authService as never,
      accreditationService: service,
    })
  );
  app.use(
    "/api/v1/secondary-market",
    createSecondaryMarketRouter({
      secondaryMarketService: secondaryMarketService as never,
      authService: authService as never,
      accreditationService: service,
    })
  );
  app.use(
    "/api/v1/investors",
    createInvestorRouter({ authService: authService as never, accreditationService: service })
  );
  app.use(createErrorMiddleware(silentLogger));

  return { app, investmentService, secondaryMarketService };
}

describe("accreditation expiry middleware (issue #780)", () => {
  it("returns 403 accreditation_expired with an accurate expired_at for expired wallets", async () => {
    const { service } = setup();
    const { app, investmentService } = buildApp(service);

    const res = await request(app)
      .post("/api/v1/investments")
      .set("Authorization", "Bearer token")
      .send({ invoiceId: "inv-gated", investmentAmount: "100" })
      .expect(403);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ACCREDITATION_EXPIRED_CODE);
    expect(res.body.error.details.expired_at).toBe(PAST_EXPIRY.toISOString());
    expect(investmentService.createInvestment).not.toHaveBeenCalled();
  });

  it("blocks secondary market purchases of gated invoices for expired wallets", async () => {
    const { service } = setup();
    const { app, secondaryMarketService } = buildApp(service);

    const res = await request(app)
      .post("/api/v1/secondary-market/listings/listing-gated/buy")
      .set("Authorization", "Bearer token")
      .send({})
      .expect(403);

    expect(res.body.error.code).toBe(ACCREDITATION_EXPIRED_CODE);
    expect(res.body.error.details.expired_at).toBe(PAST_EXPIRY.toISOString());
    expect(secondaryMarketService.buyListing).not.toHaveBeenCalled();
  });

  it("skips the check for invoices that do not require accreditation", async () => {
    const { service } = setup();
    const statusSpy = jest.spyOn(service, "getExpiryStatus");
    const { app, investmentService, secondaryMarketService } = buildApp(service);

    await request(app)
      .post("/api/v1/investments")
      .set("Authorization", "Bearer token")
      .send({ invoiceId: "inv-open", investmentAmount: "100" })
      .expect(201);
    await request(app)
      .post("/api/v1/secondary-market/listings/listing-open/buy")
      .set("Authorization", "Bearer token")
      .send({});

    expect(statusSpy).not.toHaveBeenCalled();
    expect(investmentService.createInvestment).toHaveBeenCalled();
    expect(secondaryMarketService.buyListing).toHaveBeenCalled();
  });

  it("lets wallets with a future expiry through", async () => {
    const { service } = setup({ accreditation: { expiryDate: FUTURE_EXPIRY } });
    const { app, investmentService } = buildApp(service);

    await request(app)
      .post("/api/v1/investments")
      .set("Authorization", "Bearer token")
      .send({ invoiceId: "inv-gated", investmentAmount: "100" })
      .expect(201);

    expect(investmentService.createInvestment).toHaveBeenCalled();
  });

  it("does not block wallets without an accreditation record or expiry date", async () => {
    for (const accreditation of [null, { expiryDate: null }]) {
      const { service } = setup({ accreditation });
      const { app } = buildApp(service);
      await request(app)
        .post("/api/v1/investments")
        .set("Authorization", "Bearer token")
        .send({ invoiceId: "inv-gated", investmentAmount: "100" })
        .expect(201);
    }
  });

  it("calls next() without a user and resolves invoice ids from params or body", async () => {
    const { service } = setup();
    const next = jest.fn();
    await requireUnexpiredAccreditation({
      accreditationService: service,
      resolveInvoiceId: invoiceIdFromRequest,
    })({ params: {}, body: {} } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();

    expect(invoiceIdFromRequest({ params: { id: "a" }, body: {} } as never)).toBe("a");
    expect(invoiceIdFromRequest({ params: { invoiceId: "b" }, body: {} } as never)).toBe("b");
    expect(invoiceIdFromRequest({ params: {}, body: { invoiceId: "c" } } as never)).toBe("c");
    expect(invoiceIdFromRequest({ params: {}, body: {} } as never)).toBeNull();
  });
});

describe("accreditation status cache (issue #780)", () => {
  it("syncs the cache TTL to the expiry date, capped at the max TTL", () => {
    expect(computeAccreditationCacheTtl(FUTURE_EXPIRY, NOW)).toBe(3600);
    expect(computeAccreditationCacheTtl(new Date("2027-01-01T00:00:00Z"), NOW)).toBe(
      ACCREDITATION_CACHE_MAX_TTL_SECONDS
    );
    expect(computeAccreditationCacheTtl(PAST_EXPIRY, NOW)).toBe(
      ACCREDITATION_CACHE_MAX_TTL_SECONDS
    );
    expect(computeAccreditationCacheTtl(null, NOW)).toBe(ACCREDITATION_CACHE_MAX_TTL_SECONDS);
  });

  it("caches the status in Redis with the expiry-synced TTL and serves repeat reads from it", async () => {
    const { service, accreditationRepo, redis } = setup({
      accreditation: { expiryDate: FUTURE_EXPIRY },
    });

    await service.getExpiryStatus(WALLET);
    await service.getExpiryStatus(WALLET);

    expect(accreditationRepo.findOne).toHaveBeenCalledTimes(1);
    expect(await redis.ttl(accreditationCacheKey(WALLET))).toBe(3600);
  });

  it("falls back to the database when Redis fails", async () => {
    const { service, redis } = setup();
    jest.spyOn(redis, "get").mockRejectedValue(new Error("redis down"));

    await expect(service.getExpiryStatus(WALLET)).resolves.toMatchObject({ expired: true });
  });
});

describe("PUT /investors/:wallet/accreditation renewal (issue #780)", () => {
  it("stores the document reference, sets pending_review and invalidates the cache", async () => {
    const { service, accreditationRepo, redis } = setup();
    const { app } = buildApp(service);

    await service.getExpiryStatus(WALLET);
    expect(await redis.get(accreditationCacheKey(WALLET))).not.toBeNull();

    const res = await request(app)
      .put(`/api/v1/investors/${WALLET}/accreditation`)
      .set("Authorization", "Bearer token")
      .send({ documentReference: "ipfs://QmRenewalDoc" })
      .expect(200);

    expect(res.body.data).toMatchObject({
      walletAddress: WALLET,
      status: AccreditationStatus.PENDING_REVIEW,
      documentReference: "ipfs://QmRenewalDoc",
      renewalSubmittedAt: NOW.toISOString(),
    });
    const stored = accreditationRepo.store.get(WALLET)!;
    expect(stored.status).toBe(AccreditationStatus.PENDING_REVIEW);
    expect(stored.documentReference).toBe("ipfs://QmRenewalDoc");
    expect(await redis.get(accreditationCacheKey(WALLET))).toBeNull();

    // The expiry is unchanged until an admin approves the renewal, so the
    // wallet stays blocked and the next read reflects the new status.
    await expect(service.getExpiryStatus(WALLET)).resolves.toMatchObject({
      expired: true,
      status: AccreditationStatus.PENDING_REVIEW,
    });
  });

  it("invalidates the cache when an admin approves a renewal with a new expiry", async () => {
    const { service } = setup();
    await expect(service.getExpiryStatus(WALLET)).resolves.toMatchObject({ expired: true });

    await service.updateAccreditation(WALLET, AccreditationTier.ACCREDITED, "admin", FUTURE_EXPIRY);

    await expect(service.getExpiryStatus(WALLET)).resolves.toMatchObject({
      expired: false,
      status: AccreditationStatus.ACTIVE,
    });
  });

  it("rejects renewals for another wallet", async () => {
    const { service } = setup();
    const { app } = buildApp(service);

    await request(app)
      .put(`/api/v1/investors/${OTHER_WALLET}/accreditation`)
      .set("Authorization", "Bearer token")
      .send({ documentReference: "ipfs://QmRenewalDoc" })
      .expect(403);
  });

  it("rejects a missing document reference", async () => {
    const { service } = setup();
    const { app } = buildApp(service);

    const res = await request(app)
      .put(`/api/v1/investors/${WALLET}/accreditation`)
      .set("Authorization", "Bearer token")
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
