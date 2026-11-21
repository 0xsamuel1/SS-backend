import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { DocumentExportService } from "../src/services/document-export.service";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceDocument } from "../src/models/InvoiceDocument.model";
import { Investment } from "../src/models/Investment.model";
import { User } from "../src/models/User.model";
import { KYCStatus } from "../src/types/enums";

const OWNER = "issuer-1";
const OTHER = "someone-else";
const INVOICE_ID = "invoice-1";

function makeDocuments(count: number): InvoiceDocument[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${i}`,
    invoiceId: INVOICE_ID,
    cid: `cid-${i}`,
    docType: `type${i}`,
    filename: `file-${i}.pdf`,
    mimeType: "application/pdf",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  })) as unknown as InvoiceDocument[];
}

function makeService(
  documents: InvoiceDocument[],
  fetchFile: jest.Mock,
  tempDir: string,
) {
  const dataSource = {
    getRepository: (entity: unknown) => {
      if (entity === Invoice) {
        return {
          findOneBy: async () =>
            ({ id: INVOICE_ID, sellerId: OWNER, invoiceNumber: "INV-1" }) as unknown as Invoice,
        };
      }
      if (entity === User) {
        return {
          findOneBy: async () => ({ id: OWNER, kycStatus: KYCStatus.APPROVED }) as unknown as User,
        };
      }
      if (entity === Investment) return { exists: async () => false };
      if (entity === InvoiceDocument) return { find: async () => documents };
      throw new Error("unexpected repository");
    },
  };

  return new DocumentExportService({
    dataSource: dataSource as never,
    ipfsService: { fetchFile } as never,
    tempDir,
    signingSecret: "test-secret",
    urlTtlMinutes: 10,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function expectServiceError(fn: () => unknown, code: string, statusCode?: number): void {
  let caught: { code?: string; statusCode?: number } | undefined;
  try {
    fn();
  } catch (error) {
    caught = error as { code?: string; statusCode?: number };
  }
  expect(caught).toBeDefined();
  expect(caught!.code).toBe(code);
  if (statusCode !== undefined) expect(caught!.statusCode).toBe(statusCode);
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<Buffer>((resolve) => {
    release = () => resolve(Buffer.from("data"));
  });
  return { promise, release };
}

describe("DocumentExportService jobs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "export-jobs-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("starts queued with zero progress", async () => {
    const service = makeService(makeDocuments(1), jest.fn(async () => Buffer.from("x")), tempDir);

    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    const job = service.getJobStatus(jobId, OWNER)!;

    expect(job.status).toBe("queued");
    expect(job.progress).toBe(0);

    // Stop the queued job before teardown removes its output directory.
    service.cancelJob(jobId, OWNER);
  });

  it("reports monotonic, bounded progress and reaches 100 only on completion", async () => {
    const seen: number[] = [];
    let service!: DocumentExportService;
    let jobId = "";
    const fetchFile = jest.fn(async () => {
      seen.push(service.getJobStatus(jobId, OWNER)!.progress);
      return Buffer.from("x");
    });
    service = makeService(makeDocuments(4), fetchFile, tempDir);

    ({ jobId } = await service.requestExport(INVOICE_ID, OWNER));
    await waitFor(() => service.getJobStatus(jobId, OWNER)!.status === "completed");

    const job = service.getJobStatus(jobId, OWNER)!;
    expect(seen).toEqual([0, 25, 50, 75]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.every((value) => value >= 0 && value < 100)).toBe(true);
    expect(job.progress).toBe(100);
    expect(job.processedDocuments).toBe(4);
    expect(job.totalDocuments).toBe(4);
    expect(job.downloadToken).toBeDefined();
  });

  it("hides jobs from users other than the requester", async () => {
    const service = makeService(makeDocuments(1), jest.fn(async () => Buffer.from("x")), tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);

    expect(service.getJobStatus(jobId, OTHER)).toBeUndefined();
    expect(service.getJobStatus("exp_missing", OWNER)).toBeUndefined();
    expectServiceError(() => service.cancelJob(jobId, OTHER), "export_job_not_found", 404);
    // The failed attempt did not cancel the owner's job.
    expect(service.getJobStatus(jobId, OWNER)!.status).not.toBe("cancelled");

    service.cancelJob(jobId, OWNER);
  });

  it("cancels a queued job before any work starts", async () => {
    const fetchFile = jest.fn(async () => Buffer.from("x"));
    const service = makeService(makeDocuments(2), fetchFile, tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);

    const cancelled = service.cancelJob(jobId, OWNER);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(cancelled.status).toBe("cancelled");
    expect(service.getJobStatus(jobId, OWNER)!.status).toBe("cancelled");
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("cancels a running job, stops fetching and never completes it", async () => {
    const gate = deferred();
    const fetchFile = jest.fn(() => gate.promise);
    const service = makeService(makeDocuments(3), fetchFile, tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(() => fetchFile.mock.calls.length === 1);
    expect(service.getJobStatus(jobId, OWNER)!.status).toBe("running");

    service.cancelJob(jobId, OWNER);
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const job = service.getJobStatus(jobId, OWNER)!;
    expect(job.status).toBe("cancelled");
    expect(job.downloadToken).toBeUndefined();
    expect(job.zipPath).toBeUndefined();
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expectServiceError(() => service.getDownloadPath(jobId, "any"), "export_not_ready");
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it("treats a repeated cancel as a no-op", async () => {
    const service = makeService(makeDocuments(1), jest.fn(async () => Buffer.from("x")), tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);

    const first = service.cancelJob(jobId, OWNER);
    const second = service.cancelJob(jobId, OWNER);

    expect(second.status).toBe("cancelled");
    expect(second.cancelledAt).toBe(first.cancelledAt);
  });

  it("refuses to cancel a completed job", async () => {
    const service = makeService(makeDocuments(1), jest.fn(async () => Buffer.from("x")), tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(() => service.getJobStatus(jobId, OWNER)!.status === "completed");

    expectServiceError(() => service.cancelJob(jobId, OWNER), "export_not_cancellable", 409);
    expect(service.getJobStatus(jobId, OWNER)!.status).toBe("completed");
  });

  it("marks a job failed when a document cannot be fetched, and keeps it failed", async () => {
    const fetchFile = jest.fn(async () => {
      throw new Error("gateway down");
    });
    const service = makeService(makeDocuments(2), fetchFile, tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(() => service.getJobStatus(jobId, OWNER)!.status === "failed");

    const job = service.getJobStatus(jobId, OWNER)!;
    expect(job.error).toBe("gateway down");
    expect(job.progress).toBeLessThan(100);
    expectServiceError(() => service.cancelJob(jobId, OWNER), "export_not_cancellable", 409);
  });

  it("fails a job whose invoice has no documents", async () => {
    const service = makeService([], jest.fn(), tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(() => service.getJobStatus(jobId, OWNER)!.status === "failed");

    expect(service.getJobStatus(jobId, OWNER)!.error).toMatch(/no documents/i);
  });
});
