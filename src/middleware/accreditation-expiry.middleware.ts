import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { InvestorAccreditationService } from "../services/investor-accreditation.service";
import type { AuthenticatedRequest } from "../types/auth";
import { PublicAppError } from "../utils/http-error";

export const ACCREDITATION_EXPIRED_CODE = "accreditation_expired";

/** Resolves which invoice a request targets, or null when it cannot be determined. */
export type InvoiceIdResolver = (req: Request) => Promise<string | null> | string | null;

export interface AccreditationExpiryGuardOptions {
  accreditationService: InvestorAccreditationService;
  resolveInvoiceId: InvoiceIdResolver;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** For POST /invoices/:id/invest and POST /investments ({ invoiceId } body). */
export const invoiceIdFromRequest: InvoiceIdResolver = (req) => {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  return firstString(params.id, params.invoiceId, body.invoiceId);
};

/** For POST /secondary-market/listings/:id/buy: the listing's underlying invoice. */
export function invoiceIdFromSecondaryListing(
  accreditationService: InvestorAccreditationService
): InvoiceIdResolver {
  return async (req) => {
    const listingId = firstString((req.params ?? {}).id);
    if (!listingId) return null;
    return accreditationService.getInvoiceIdForListing(listingId);
  };
}

/**
 * Blocks invest / secondary-market purchase requests from wallets whose
 * accreditation has lapsed (issue #780). Must run after the auth middleware.
 *
 * - Invoices flagged `requires_accreditation = false` skip the check.
 * - Wallets with no accreditation record, or no expiry date, are not blocked
 *   here; other gating (KYC, acknowledgement, tier limits) still applies.
 * - Expired wallets get 403 `accreditation_expired` with `expired_at`.
 */
export function requireUnexpiredAccreditation({
  accreditationService,
  resolveInvoiceId,
}: AccreditationExpiryGuardOptions): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const wallet = (req as AuthenticatedRequest).user?.stellarAddress;
      if (!wallet) {
        next();
        return;
      }

      const invoiceId = await resolveInvoiceId(req);
      if (invoiceId) {
        const requiresAccreditation =
          await accreditationService.invoiceRequiresAccreditation(invoiceId);
        if (requiresAccreditation === false) {
          next();
          return;
        }
      }

      const status = await accreditationService.getExpiryStatus(wallet);
      if (status.expired) {
        next(
          new PublicAppError(
            403,
            "Investor accreditation has expired. Submit a renewal to continue investing.",
            ACCREDITATION_EXPIRED_CODE,
            {
              expired_at: status.expiresAt,
              renewal_status: status.status,
            }
          )
        );
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
