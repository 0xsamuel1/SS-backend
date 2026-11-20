import { randomUUID } from "crypto";
import { createWriteStream, promises as fs } from "fs";
import path from "path";
import archiver from "archiver";
import { DataSource, In, LessThanOrEqual, Repository } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceDocument } from "../models/InvoiceDocument.model";
import { DocumentExportJob, DocumentExportJobStatus } from "../models/DocumentExportJob.model";
import { Investment } from "../models/Investment.model";
import { User } from "../models/User.model";
import { KYCStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { logger, type AppLogger } from "../observability/logger";
import type { IPFSService } from "./ipfs.service";
import { createSignedDownloadToken, verifySignedDownloadToken } from "../lib/signed-url";

export type ExportJobStatus = DocumentExportJobStatus;

export interface ExportJob {
  id: string;
  invoiceId: string;
  status: ExportJobStatus;
  zipPath?: string;
  downloadToken?: string;
  downloadTokenExpiresAt?: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface DocumentExportServiceDependencies {
  dataSource: DataSource;
  ipfsService: IPFSService;
  /** Must be the same durable mounted directory on every backend replica. */
  tempDir: string;
  signingSecret: string;
  urlTtlMinutes: number;
  retentionMs?: number;
  logger?: AppLogger;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const LEASE_RENEWAL_INTERVAL_MS = 60 * 1000;

/** Characters outside `[A-Za-z0-9._-]` are not safe in a ZIP entry/file name across platforms. */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function extensionFor(filename: string | null, mimeType: string | null): string {
  const existing = filename ? path.extname(filename) : "";
  if (existing) return existing;
  if (!mimeType) return "";
  const byMime: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  return byMime[mimeType] ?? "";
}

function toExportJob(job: DocumentExportJob): ExportJob {
  return {
    id: job.id,
    invoiceId: job.invoiceId,
    status: job.status,
    ...(job.zipPath ? { zipPath: job.zipPath } : {}),
    ...(job.downloadToken ? { downloadToken: job.downloadToken } : {}),
    ...(job.downloadTokenExpiresAt
      ? { downloadTokenExpiresAt: job.downloadTokenExpiresAt.getTime() }
      : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt.getTime(),
    ...(job.completedAt ? { completedAt: job.completedAt.getTime() } : {}),
  };
}

/**
 * Generates invoice ZIPs on a shared filesystem and persists job state in the
 * database so another replica can poll or download a completed export.
 */
export class DocumentExportService {
  private readonly jobs: Repository<DocumentExportJob>;
  private readonly ownerId = randomUUID();
  private readonly retentionMs: number;
  private readonly appLogger: AppLogger;

  constructor(private readonly dependencies: DocumentExportServiceDependencies) {
    this.jobs = dependencies.dataSource.getRepository(DocumentExportJob);
    this.retentionMs = dependencies.retentionMs ?? DEFAULT_RETENTION_MS;
    this.appLogger = dependencies.logger ?? logger;
  }

  async requestExport(invoiceId: string, requestingUserId: string): Promise<{ jobId: string }> {
    const invoice = await this.dependencies.dataSource
      .getRepository(Invoice)
      .findOneBy({ id: invoiceId });
    if (!invoice) {
      throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    }

    await this.assertEligible(invoice, requestingUserId);

    const jobId = `exp_${invoiceId}_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date();
    const job = this.jobs.create({
      id: jobId,
      invoiceId,
      requesterId: requestingUserId,
      status: "processing",
      zipPath: this.archivePath(jobId),
      downloadToken: null,
      downloadTokenExpiresAt: null,
      error: null,
      leaseOwner: this.ownerId,
      leaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS),
      expiresAt: null,
      completedAt: null,
    });
    await this.jobs.save(job);

    void this.runExport(jobId, invoice.invoiceNumber, this.ownerId);
    return { jobId };
  }

  async getJobStatus(jobId: string): Promise<ExportJob | undefined> {
    let job = await this.jobs.findOneBy({ id: jobId });
    if (!job) return undefined;

    if (
      job.status === "processing" &&
      job.leaseExpiresAt &&
      job.leaseExpiresAt.getTime() <= Date.now()
    ) {
      await this.removeArchive(job);
      const failed = await this.jobs.update(
        {
          id: job.id,
          status: "processing",
          leaseExpiresAt: LessThanOrEqual(new Date()),
        },
        {
          status: "failed",
          error: "Export worker lease expired before completion",
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.retentionMs),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      );
      if (failed.affected) {
        job = await this.jobs.findOneBy({ id: jobId });
        if (!job) return undefined;
      }
    }

    return toExportJob(job);
  }

  async getDownloadPath(jobId: string, token: string): Promise<string> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job || job.status !== "completed" || !job.zipPath) {
      throw new ServiceError("export_not_ready", "Export job is not ready for download", 404);
    }

    if (
      token !== job.downloadToken ||
      !verifySignedDownloadToken(this.dependencies.signingSecret, jobId, token)
    ) {
      throw new ServiceError("invalid_download_token", "Download link is invalid or has expired", 403);
    }

    return job.zipPath;
  }

  async cleanupExpiredJobs(now: Date = new Date()): Promise<{ jobsDeleted: number; archivesDeleted: number }> {
    const candidates = await this.jobs.find({
      where: [
        { status: "processing", leaseExpiresAt: LessThanOrEqual(now) },
        { status: In(["completed", "failed"]), expiresAt: LessThanOrEqual(now) },
      ],
    });
    let jobsDeleted = 0;
    let archivesDeleted = 0;

    for (const candidate of candidates) {
      if (candidate.status === "processing") {
        const removed = await this.removeArchive(candidate);
        const markedFailed = await this.jobs.update(
          {
            id: candidate.id,
            status: "processing",
            leaseExpiresAt: LessThanOrEqual(now),
          },
          {
            status: "failed",
            error: "Export worker lease expired before completion",
            completedAt: now,
            expiresAt: new Date(now.getTime() + this.retentionMs),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        );
        if (markedFailed.affected) {
          if (removed) archivesDeleted++;
        }
        continue;
      }

      const removed = await this.removeArchive(candidate);
      if (removed) archivesDeleted++;
      const deleted = await this.jobs.delete({
        id: candidate.id,
        status: In(["completed", "failed"]),
        expiresAt: LessThanOrEqual(now),
      });
      jobsDeleted += deleted.affected ?? 0;
    }

    this.appLogger.info("document_export.cleanup.completed", {
      jobs_deleted: jobsDeleted,
      archives_deleted: archivesDeleted,
    });
    return { jobsDeleted, archivesDeleted };
  }

  startCleanupSchedule(intervalMs = 60 * 60 * 1000): { stop: () => void } {
    const timer = setInterval(() => {
      void this.cleanupExpiredJobs().catch((error: unknown) => {
        this.appLogger.error("document_export.cleanup.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  private async assertEligible(invoice: Invoice, requestingUserId: string): Promise<void> {
    const user = await this.dependencies.dataSource
      .getRepository(User)
      .findOneBy({ id: requestingUserId });
    if (!user) {
      throw new ServiceError("user_not_found", "User not found", 404);
    }
    if (user.kycStatus !== KYCStatus.APPROVED) {
      throw new ServiceError("kyc_not_approved", "KYC approval required to export documents", 403);
    }

    const isIssuer = invoice.sellerId === requestingUserId;
    if (isIssuer) return;

    const hasInvested = await this.dependencies.dataSource.getRepository(Investment).exists({
      where: { invoiceId: invoice.id, investorId: requestingUserId },
    });
    if (!hasInvested) {
      throw new ServiceError(
        "export_forbidden",
        "Only the issuer or an investor in this invoice may export its documents",
        403,
      );
    }
  }

  private archivePath(jobId: string): string {
    return path.join(path.resolve(this.dependencies.tempDir), `${jobId}.zip`);
  }

  private async removeArchive(job: DocumentExportJob): Promise<boolean> {
    if (!job.zipPath) return false;
    const resolved = path.resolve(job.zipPath);
    const tempDir = path.resolve(this.dependencies.tempDir);
    if (!resolved.startsWith(`${tempDir}${path.sep}`)) {
      throw new Error(`Export archive path is outside the configured shared directory: ${resolved}`);
    }
    try {
      await fs.stat(resolved);
      await fs.rm(resolved, { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      this.appLogger.error("document_export.archive_cleanup.failed", {
        job_id: job.id,
        path: resolved,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async renewLease(jobId: string, leaseOwner: string): Promise<boolean> {
    const result = await this.jobs.update(
      { id: jobId, status: "processing", leaseOwner },
      { leaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS) },
    );
    return Boolean(result.affected);
  }

  private async runExport(jobId: string, invoiceNumber: string, leaseOwner: string): Promise<void> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job) return;
    let leaseLost = false;
    let leaseError: unknown;
    const heartbeat = setInterval(() => {
      void this.renewLease(jobId, leaseOwner).then((renewed) => {
        if (!renewed) leaseLost = true;
      }).catch((error: unknown) => {
        leaseError = error;
        this.appLogger.error("document_export.lease_renewal.failed", {
          job_id: jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, LEASE_RENEWAL_INTERVAL_MS);
    heartbeat.unref();

    try {
      const documents = await this.dependencies.dataSource
        .getRepository(InvoiceDocument)
        .find({ where: { invoiceId: job.invoiceId }, order: { createdAt: "ASC" } });

      if (documents.length === 0) {
        throw new ServiceError("no_documents", "This invoice has no documents to export", 404);
      }

      await fs.mkdir(this.dependencies.tempDir, { recursive: true });
      await this.writeZip(job.zipPath!, job.invoiceId, invoiceNumber, documents, async () => {
        if (leaseLost || leaseError) {
          throw leaseError instanceof Error ? leaseError : new Error("Export worker lease was lost");
        }
        if (!(await this.renewLease(jobId, leaseOwner))) {
          leaseLost = true;
          throw new Error("Export worker lease was lost");
        }
      });

      const { token, expiresAt } = createSignedDownloadToken(
        this.dependencies.signingSecret,
        jobId,
        this.dependencies.urlTtlMinutes,
      );
      const completedAt = new Date();
      const saved = await this.jobs.update(
        { id: jobId, status: "processing", leaseOwner },
        {
          status: "completed",
          downloadToken: token,
          downloadTokenExpiresAt: new Date(expiresAt),
          completedAt,
          expiresAt: new Date(Math.max(expiresAt, completedAt.getTime() + this.retentionMs)),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      );
      if (!saved.affected) throw new Error("Export worker no longer owns this job");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      try {
        await this.removeArchive(job);
        const failed = await this.jobs.update(
          { id: jobId, status: "processing", leaseOwner },
          {
            status: "failed",
            error: message,
            completedAt: new Date(),
            expiresAt: new Date(Date.now() + this.retentionMs),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        );
        if (!failed.affected) {
          throw new Error("Export worker no longer owns this job");
        }
      } catch (failureError) {
        this.appLogger.error("document_export.failure_persistence.failed", {
          job_id: jobId,
          error: failureError instanceof Error ? failureError.message : String(failureError),
          original_error: message,
        });
      }
      this.appLogger.error("document_export.job.failed", { job_id: jobId, error: message });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async writeZip(
    zipPath: string,
    invoiceId: string,
    invoiceNumber: string,
    documents: InvoiceDocument[],
    renewLease: () => Promise<void>,
  ): Promise<void> {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    let finalized = false;
    let closed = false;
    let settled = false;

    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectCompletion(error);
    };
    const completeIfReady = () => {
      if (!settled && closed && finalized && output.writableFinished) {
        settled = true;
        resolveCompletion();
      }
    };

    output.on("error", fail);
    output.on("close", () => {
      closed = true;
      if (!output.writableFinished) {
        fail(new Error("ZIP output closed before the archive finished writing"));
      } else {
        completeIfReady();
      }
    });
    archive.on("error", fail);
    archive.pipe(output);

    try {
      const invoiceLabel = sanitizeForFilename(invoiceNumber || invoiceId);
      const seenNames = new Map<string, number>();

      for (const doc of documents) {
        await renewLease();
        const fileBuffer = await this.dependencies.ipfsService.fetchFile(doc.cid);
        await renewLease();

        const dateStamp = doc.createdAt.toISOString().slice(0, 10);
        const docType = sanitizeForFilename(doc.docType);
        const extension = extensionFor(doc.filename, doc.mimeType);
        let entryName = `${invoiceLabel}_${docType}_${dateStamp}${extension}`;
        const count = seenNames.get(entryName) ?? 0;
        seenNames.set(entryName, count + 1);
        if (count > 0) {
          entryName = `${invoiceLabel}_${docType}_${dateStamp}_${count + 1}${extension}`;
        }

        archive.append(fileBuffer, { name: entryName });
      }

      await archive.finalize();
      finalized = true;
      completeIfReady();
      await completion;
    } catch (error) {
      archive.abort();
      const closed = output.closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => output.once("close", resolve));
      output.destroy();
      await closed;
      throw error;
    }
  }
}

export function createDocumentExportService(
  dependencies: DocumentExportServiceDependencies,
): DocumentExportService {
  return new DocumentExportService(dependencies);
}
