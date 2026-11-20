import { Router, type NextFunction, type Request, type Response } from "express";
import type { IssuerProfileService } from "../services/issuer-profile.service";
import { ServiceError } from "../utils/service-error";
import { PublicAppError } from "../utils/http-error";

export interface IssuerProfileRouterDependencies {
  issuerProfileService: IssuerProfileService;
}

function firstQueryValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/**
 * Public issuer profile (issue #779). Mounted at /api/v1.
 *
 * GET /issuers/:wallet?cursor=&limit= — identity, track record, paginated
 * invoice history and dynamic yield for the issuer's profile page.
 */
export function createIssuerProfileRouter({
  issuerProfileService,
}: IssuerProfileRouterDependencies): Router {
  const router = Router();

  router.get("/issuers/:wallet", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawWallet = req.params.wallet;
      const wallet = (Array.isArray(rawWallet) ? rawWallet[0] : rawWallet)?.trim();
      if (!wallet) {
        throw new PublicAppError(400, "Wallet parameter is required.", "MISSING_WALLET");
      }

      const rawLimit = firstQueryValue(req.query.limit);
      const limit = rawLimit === undefined ? undefined : Number(rawLimit);

      const profile = await issuerProfileService.getProfile(wallet, {
        cursor: firstQueryValue(req.query.cursor),
        limit,
      });

      res.status(200).json({ success: true, data: profile });
    } catch (error) {
      if (error instanceof ServiceError) {
        next(new PublicAppError(error.statusCode, error.message, error.code, error.details));
        return;
      }
      next(error);
    }
  });

  return router;
}
