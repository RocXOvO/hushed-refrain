import {
  desktopResultReportIdentityMatches,
  desktopResultReportLoadError,
  type DesktopResultExportRequest,
} from "./window-shell";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { writeAtomicBuffer, type AtomicWriteOptions } from "./atomic-file";

export type DesktopResultExportStage =
  | "load-report"
  | "fonts"
  | "print"
  | "write";

export type DesktopResultExportProgressStage =
  | "save-dialog"
  | DesktopResultExportStage
  | "saved"
  | "cancelled"
  | "failed";

export interface DesktopResultExportProgress {
  stage: DesktopResultExportProgressStage;
  elapsedMs: number;
}

export type DesktopResultExportResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" };

export interface DesktopResultReportSession {
  load(url: string): Promise<void>;
  waitForReadyReport(): Promise<unknown>;
  print(): Promise<Buffer>;
  close(): void;
}

export interface DesktopResultExportRuntime {
  chooseDestination(): Promise<string | undefined>;
  reportUrl: string;
  createSession(): DesktopResultReportSession;
  write(destination: string, pdf: Buffer, signal: AbortSignal): Promise<void>;
  onProgress?: (progress: DesktopResultExportProgress) => void;
  signal?: AbortSignal;
  timeouts?: Partial<Record<DesktopResultExportStage, number>>;
}

const DEFAULT_TIMEOUTS: Record<DesktopResultExportStage, number> = {
  "load-report": 30_000,
  fonts: 15_000,
  print: 180_000,
  write: 30_000,
};

export class DesktopResultExportError extends Error {
  constructor(
    public readonly stage: DesktopResultExportStage,
    public readonly code: "timeout" | "report-error" | "identity-mismatch" | "invalid-pdf" | "failed",
    cause?: unknown,
  ) {
    super(desktopResultExportFailureMessage(stage, code), { cause });
    this.name = "DesktopResultExportError";
  }
}

/**
 * Serializes writes to the same destination across app instances. A timeout
 * can abort pending atomic work, but an OS rename already in progress cannot
 * be cancelled; retaining this path lock until that call settles guarantees
 * a retry commits after the old writer rather than being overwritten by it.
 */
export async function writeDesktopResultPdf(
  destination: string,
  pdf: Buffer,
  signal: AbortSignal,
  atomicOptions: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const release = await lockfile.lock(destination, {
    realpath: false,
    stale: 300_000,
    update: 30_000,
    retries: { retries: 80, factor: 1.15, minTimeout: 5, maxTimeout: 100, randomize: true },
  });
  try {
    signal.throwIfAborted();
    await writeAtomicBuffer(destination, pdf, { ...atomicOptions, signal });
  } finally {
    await release().catch(() => {});
  }
}

export async function runDesktopResultExport(
  request: DesktopResultExportRequest,
  runtime: DesktopResultExportRuntime,
): Promise<DesktopResultExportResult> {
  const startedAt = Date.now();
  const progress = (stage: DesktopResultExportProgressStage): void => {
    runtime.onProgress?.({ stage, elapsedMs: Math.max(0, Date.now() - startedAt) });
  };
  progress("save-dialog");
  const destination = await runtime.chooseDestination();
  if (!destination) {
    progress("cancelled");
    return { status: "cancelled" };
  }

  let stage: DesktopResultExportStage = "load-report";
  let session: DesktopResultReportSession | undefined;
  try {
    runtime.signal?.throwIfAborted();
    session = runtime.createSession();
    progress(stage);
    await bounded(session.load(runtime.reportUrl), timeoutFor(runtime, stage), stage, undefined, runtime.signal);

    stage = "fonts";
    progress(stage);
    const readyReport = await bounded(
      session.waitForReadyReport(),
      timeoutFor(runtime, stage),
      stage,
      undefined,
      runtime.signal,
    );
    if (desktopResultReportLoadError(readyReport)) {
      throw new DesktopResultExportError("load-report", "report-error");
    }
    if (!desktopResultReportIdentityMatches(readyReport, request)) {
      throw new DesktopResultExportError("load-report", "identity-mismatch");
    }

    stage = "print";
    progress(stage);
    const pdf = await bounded(session.print(), timeoutFor(runtime, stage), stage, undefined, runtime.signal);
    if (pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new DesktopResultExportError("print", "invalid-pdf");
    }

    stage = "write";
    progress(stage);
    const writeAbort = new AbortController();
    await bounded(
      runtime.write(destination, pdf, writeAbort.signal),
      timeoutFor(runtime, stage),
      stage,
      () => writeAbort.abort(new DesktopResultExportError(stage, "timeout")),
      runtime.signal,
      () => writeAbort.abort(runtime.signal?.reason),
    );
    progress("saved");
    return { status: "saved", path: destination };
  } catch (error) {
    if (runtime.signal?.aborted) {
      progress("cancelled");
      return { status: "cancelled" };
    }
    progress("failed");
    if (error instanceof DesktopResultExportError) throw error;
    throw new DesktopResultExportError(stage, "failed", error);
  } finally {
    session?.close();
  }
}

export function desktopResultExportFailureMessage(
  stage: DesktopResultExportStage,
  code: DesktopResultExportError["code"],
): string {
  if (code === "identity-mismatch") return "报告任务已变化，请刷新结果后重试。";
  if (code === "report-error") return "报告数据无法加载，请检查当前结果后重试。";
  if (code === "invalid-pdf") return "系统没有生成有效的 PDF 数据，请重试。";
  const label: Record<DesktopResultExportStage, string> = {
    "load-report": "读取报告",
    fonts: "等待字体",
    print: "生成 PDF",
    write: "写入文件",
  };
  return `${label[stage]}${code === "timeout" ? "超时" : "失败"}，请重试。`;
}

function timeoutFor(runtime: DesktopResultExportRuntime, stage: DesktopResultExportStage): number {
  return runtime.timeouts?.[stage] ?? DEFAULT_TIMEOUTS[stage];
}

function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  stage: DesktopResultExportStage,
  onTimeout?: () => void,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = (): void => {
      onAbort?.();
      finish(() => reject(signal?.reason ?? new Error("cancelled")));
    };
    const timer = setTimeout(() => {
      onTimeout?.();
      finish(() => reject(new DesktopResultExportError(stage, "timeout")));
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
