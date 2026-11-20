import { Router, type RequestHandler } from "express";
import { InvestmentController } from "../controllers/investment.controller";
import { InvestmentService } from "../services/investment.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { createInvestRateLimiter } from "../middleware/redis-rate-limit.middleware";
import { checkContractNotPaused } from "../middleware/contract-pause-guard.middleware";
import type { AuthService } from "../services/auth.service";
import type { ContractGuardService } from "../services/stellar/contract-guard.service";
import type { InvestorAccreditationService } from "../services/investor-accreditation.service";
import {
  invoiceIdFromRequest,
  requireUnexpiredAccreditation,
} from "../middleware/accreditation-expiry.middleware";

export interface InvestmentRouterDependencies {
  investmentService: InvestmentService;
  authService: AuthService;
  contractGuardService?: ContractGuardService;
  contractId?: string | null;
  /** Issue #780 — blocks investing with an expired accreditation. */
  accreditationService?: InvestorAccreditationService;
}

// Rate limit: per-IP and per-wallet sliding window counters stored in Redis
const investmentRateLimiter = createInvestRateLimiter("create");

export function createInvestmentRouter({
  investmentService,
  authService,
  contractGuardService,
  contractId = null,
  accreditationService,
}: InvestmentRouterDependencies): Router {
  const router = Router();
  const controller = new InvestmentController(investmentService);
  const authMiddleware = createAuthMiddleware(authService);

  // Only the state-changing endpoint is gated: reading a portfolio during a
  // pause is harmless, and blocking it would hide the state of the system.
  const pauseGuard: RequestHandler[] = contractGuardService
    ? [checkContractNotPaused({ contractGuardService, contractId })]
    : [];
  const accreditationGuard: RequestHandler[] = accreditationService
    ? [
        requireUnexpiredAccreditation({
          accreditationService,
          resolveInvoiceId: invoiceIdFromRequest,
        }),
      ]
    : [];

  // POST /api/v1/investments - Create a new investment commitment
  router.post(
    "/",
    authMiddleware,
    ...pauseGuard,
    investmentRateLimiter,
    ...accreditationGuard,
    controller.createInvestment
  );

  // GET /api/v1/investments/dashboard - Investor portfolio aggregate
  router.get("/dashboard", authMiddleware, controller.getDashboard);

  // GET /api/v1/investments/analytics - Investor portfolio performance analytics
  router.get("/analytics", authMiddleware, controller.getInvestorAnalytics);

  return router;
}
