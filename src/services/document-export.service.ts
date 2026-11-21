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
import {
  advanceProgress,
  canTransitionExportState,
  isTerminalExportState,
  progressForDocuments,
  type ExportJobState,
} from "./export-job-state";

export type ExportJobStatus = ExportJobState;

export interface ExportJob {
  id: string;
  invoiceId: string;
  /** User who requested the export; the only user who may inspect or cancel it. */
  requestedBy: string;
  status: ExportJobStatus;
  /** 0-100, never decreases, 100 only once the job is completed. */
  progress: number;
  totalDocuments: number;
  processedDocuments: number;
  zipPath?: string;
  downloadToken?: string;
  downloadTokenExpiresAt?: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
  cancelledAt?: number;
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

      requestedBy: requestingUserId,
      status: "queued",
      progress: 0,
      totalDocuments: 0,
      processedDocuments: 0,
      createdAt: Date.now(),
    };
    this.jobs.set(jobId, job);

    // Fire-and-forget: the caller polls `getJobStatus`, it does not await this.
    // Starting on the next turn of the event loop leaves the job observably
    // `queued` (and cancellable before any work happens) when this returns.
    setImmediate(() => {
      void this.runExport(job, invoice.invoiceNumber);
    });

    void this.runExport(jobId, invoice.invoiceNumber, this.ownerId);
    return { jobId };
  }

  /**
   * Returns the job only to the user who requested it. Any other caller gets
   * `undefined`, the same answer as an unknown id, so job ids cannot be probed.
   */
  getJobStatus(jobId: string, requestingUserId: string): ExportJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.requestedBy !== requestingUserId) return undefined;
    return job;
  }

  /**
   * Cancels a queued or running job (#808).
   *
   * Idempotent: cancelling an already-cancelled job returns it unchanged. A job
   * that has completed or failed cannot be cancelled (409). Not-found and
   * not-yours look identical (404). The transition is checked and applied in
   * one synchronous step, so it cannot interleave with the export finishing:
   * whichever lands first wins and the other sees the new state.
   */
  cancelJob(jobId: string, requestingUserId: string): ExportJob {
    const job = this.getJobStatus(jobId, requestingUserId);
    if (!job) {
      throw new ServiceError("export_job_not_found", "Export job not found", 404);
    }
    if (job.status === "cancelled") return job;
    if (!canTransitionExportState(job.status, "cancelled")) {
      throw new ServiceError(
        "export_not_cancellable",
        `A ${job.status} export job cannot be cancelled`,
        409,
      );
    }

    job.status = "cancelled";
    job.cancelledAt = Date.now();
    job.completedAt = job.cancelledAt;
    // A cancelled job never offers a download.
    delete job.downloadToken;
    delete job.downloadTokenExpiresAt;
    if (job.zipPath) {
      void fs.rm(job.zipPath, { force: true }).catch(() => undefined);
      delete job.zipPath;
    }
    return job;
  }

  private transition(job: ExportJob, to: ExportJobStatus): boolean {
    if (!canTransitionExportState(job.status, to)) return false;
    job.status = to;
    return true;
  }

  private setProgress(job: ExportJob, value: number): void {
    if (isTerminalExportState(job.status)) return;
    job.progress = advanceProgress(job.progress, value);
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

  private async runExport(job: ExportJob, invoiceNumber: string): Promise<void> {
    // The job may have been cancelled between being queued and starting.
    if (!this.transition(job, "running")) return;

    try {
      const documents = await this.dependencies.dataSource
        .getRepository(InvoiceDocument)
        .find({ where: { invoiceId: job.invoiceId }, order: { createdAt: "ASC" } });
      if (job.status !== "running") return;

      if (documents.length === 0) {
        throw new ServiceError("no_documents", "This invoice has no documents to export", 404);
      }
      job.totalDocuments = documents.length;

      await fs.mkdir(this.dependencies.tempDir, { recursive: true });
      const zipPath = path.join(this.dependencies.tempDir, `${job.id}.zip`);

      await this.writeZip(zipPath, job, invoiceNumber, documents);

      // Cancelled while the archive was being written: discard the file and
      // leave the job cancelled instead of overwriting that with "completed".
      if (job.status !== "running") {
        await fs.rm(zipPath, { force: true }).catch(() => undefined);
        return;
      }

      const { token, expiresAt } = createSignedDownloadToken(
        this.dependencies.signingSecret,
        jobId,
        this.dependencies.urlTtlMinutes,
      );

      if (!this.transition(job, "completed")) return;
      job.progress = 100;
      job.zipPath = zipPath;
      job.downloadToken = token;
      job.downloadTokenExpiresAt = expiresAt;
      job.completedAt = Date.now();
    } catch (error) {
      if (!this.transition(job, "failed")) return;
      job.error = error instanceof Error ? error.message : "Unknown error";
      job.completedAt = Date.now();
    }
  }

  private async writeZip(
    zipPath: string,
    job: ExportJob,
    invoiceNumber: string,
    documents: InvoiceDocument[],
    renewLease: () => Promise<void>,
  ): Promise<void> {
    const invoiceId = job.invoiceId;
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

    for (const doc of documents) {
      // Stop fetching as soon as the job is cancelled.
      if (job.status !== "running") break;

      const fileBuffer = await this.dependencies.ipfsService.fetchFile(doc.cid);

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

      archive.append(fileBuffer, { name: entryName });

      job.processedDocuments += 1;
      this.setProgress(job, progressForDocuments(job.processedDocuments, documents.length));
    }
  }
}

export function createDocumentExportService(
  dependencies: DocumentExportServiceDependencies,
): DocumentExportService {
  return new DocumentExportService(dependencies);
}
