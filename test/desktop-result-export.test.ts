import assert from "node:assert/strict";
import { mkdtemp, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesktopResultExportError,
  runDesktopResultExport,
  writeDesktopResultPdf,
  type DesktopResultExportRuntime,
  type DesktopResultExportStage,
  type DesktopResultReportSession,
} from "../src/desktop-result-export";
import type { DesktopResultExportRequest } from "../src/window-shell";

const request: DesktopResultExportRequest = {
  platform: "qq",
  mode: "likes",
  jobId: "a8d7e2b4-62c5-4b30-875d-8a4371513cc9",
  target: { kind: "encryptUin", value: "synthetic-target" },
};

const identity = {
  platform: "qq",
  mode: "likes",
  jobId: request.jobId,
  targetKind: "encryptUin",
  target: "synthetic-target",
};

test("desktop PDF export writes a validated PDF and closes the hidden session", async () => {
  let written: Buffer | undefined;
  let closed = 0;
  const progress: string[] = [];
  const result = await runDesktopResultExport(request, runtime({
    close: () => { closed += 1; },
  }, {
    write: async (_destination, pdf) => { written = pdf; },
    onProgress: ({ stage }) => progress.push(stage),
  }));

  assert.deepEqual(result, { status: "saved", path: "C:\\Users\\Synthetic\\report.pdf" });
  assert.equal(written?.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(closed, 1);
  assert.deepEqual(progress, ["save-dialog", "load-report", "fonts", "print", "write", "saved"]);
});

test("desktop PDF export attaches monotonic elapsed time to every progress event", async () => {
  const progress: Array<{ stage: string; elapsedMs: number }> = [];
  await runDesktopResultExport(request, runtime({}, {
    onProgress: (value) => progress.push(value),
  }));
  assert.deepEqual(progress.map((value) => value.stage), ["save-dialog", "load-report", "fonts", "print", "write", "saved"]);
  assert.equal(progress.every((value) => Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0), true);
  assert.equal(progress.every((value, index) => index === 0 || value.elapsedMs >= progress[index - 1].elapsedMs), true);
});

test("desktop PDF export reports cancellation without creating a hidden session", async () => {
  let created = 0;
  const result = await runDesktopResultExport(request, runtime({}, {
    chooseDestination: async () => undefined,
    createSession: () => { created += 1; return session(); },
  }));
  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(created, 0);
});

test("desktop PDF export cancels a stuck hidden stage, closes it, and releases progress", async () => {
  const controller = new AbortController();
  let closed = 0;
  const progress: string[] = [];
  const exporting = runDesktopResultExport(request, runtime({
    print: async () => new Promise<Buffer>(() => {}),
    close: () => { closed += 1; },
  }, {
    signal: controller.signal,
    onProgress: ({ stage }) => {
      progress.push(stage);
      if (stage === "print") controller.abort(new Error("synthetic user cancellation"));
    },
  }));

  assert.deepEqual(await exporting, { status: "cancelled" });
  assert.equal(closed, 1);
  assert.deepEqual(progress, ["save-dialog", "load-report", "fonts", "print", "cancelled"]);
});

test("desktop PDF export classifies hidden-session construction after destination selection as load-report", async () => {
  const cause = new Error("synthetic hidden window failure");
  await assert.rejects(
    runDesktopResultExport(request, runtime({}, {
      createSession: () => { throw cause; },
    })),
    (error: unknown) => {
      assert.equal(error instanceof DesktopResultExportError, true);
      assert.equal((error as DesktopResultExportError).stage, "load-report");
      assert.equal((error as DesktopResultExportError).cause, cause);
      return true;
    },
  );
});

for (const stage of ["load-report", "fonts", "print", "write"] as DesktopResultExportStage[]) {
  test(`desktop PDF export bounds the ${stage} stage and closes the session`, async () => {
    let closed = 0;
    const never = new Promise<never>(() => {});
    const overrides: Partial<DesktopResultReportSession> = { close: () => { closed += 1; } };
    const runtimeOverrides: Partial<DesktopResultExportRuntime> = {};
    if (stage === "load-report") overrides.load = () => never;
    if (stage === "fonts") overrides.waitForReadyReport = () => never;
    if (stage === "print") overrides.print = () => never;
    if (stage === "write") runtimeOverrides.write = () => never;

    await assert.rejects(
      runDesktopResultExport(request, runtime(overrides, {
        ...runtimeOverrides,
        timeouts: { [stage]: 5 },
      })),
      (error: unknown) => {
        assert.equal(error instanceof DesktopResultExportError, true);
        assert.equal((error as DesktopResultExportError).stage, stage);
        assert.equal((error as DesktopResultExportError).code, "timeout");
        return true;
      },
    );
    assert.equal(closed, 1);
  });
}

test("desktop PDF export rejects stale report identity before printing", async () => {
  let printed = 0;
  await assert.rejects(
    runDesktopResultExport(request, runtime({
      waitForReadyReport: async () => ({ ...identity, jobId: "different" }),
      print: async () => { printed += 1; return Buffer.from("%PDF-test"); },
    })),
    (error: unknown) => error instanceof DesktopResultExportError
      && error.code === "identity-mismatch",
  );
  assert.equal(printed, 0);
});

test("desktop PDF write timeout aborts a late writer before it can commit", async () => {
  let committed = false;
  let observedAbort = false;
  await assert.rejects(
    runDesktopResultExport(request, runtime({}, {
      write: async (_destination, _pdf, signal) => new Promise<void>((resolve) => {
        setTimeout(() => {
          observedAbort = signal.aborted;
          if (!signal.aborted) committed = true;
          resolve();
        }, 20);
      }),
      timeouts: { write: 5 },
    })),
    (error: unknown) => error instanceof DesktopResultExportError
      && error.stage === "write"
      && error.code === "timeout",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(observedAbort, true);
  assert.equal(committed, false);
});

test("a rename already in progress settles before a same-path retry commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-pdf-retry-lock-"));
  const destination = join(root, "report.pdf");
  const firstAbort = new AbortController();
  let enteredRename!: () => void;
  const renameEntered = new Promise<void>((resolve) => { enteredRename = resolve; });
  let releaseRename!: () => void;
  const renameBarrier = new Promise<void>((resolve) => { releaseRename = resolve; });
  const firstWrite = writeDesktopResultPdf(
    destination,
    Buffer.from("%PDF-first", "ascii"),
    firstAbort.signal,
    {
      randomId: () => "first",
      renameFile: async (source, target) => {
        enteredRename();
        await renameBarrier;
        await rename(source, target);
      },
    },
  );
  await renameEntered;
  firstAbort.abort(new DesktopResultExportError("write", "timeout"));

  let retryEnteredRename = false;
  const retry = writeDesktopResultPdf(
    destination,
    Buffer.from("%PDF-second", "ascii"),
    new AbortController().signal,
    {
      randomId: () => "second",
      renameFile: async (source, target) => {
        retryEnteredRename = true;
        await rename(source, target);
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(retryEnteredRename, false);

  releaseRename();
  await firstWrite;
  await retry;
  assert.equal(retryEnteredRename, true);
  assert.equal(await readFile(destination, "ascii"), "%PDF-second");
});

function runtime(
  sessionOverrides: Partial<DesktopResultReportSession> = {},
  overrides: Partial<DesktopResultExportRuntime> = {},
): DesktopResultExportRuntime {
  return {
    chooseDestination: async () => "C:\\Users\\Synthetic\\report.pdf",
    reportUrl: "http://127.0.0.1:4321/report/results",
    createSession: () => session(sessionOverrides),
    write: async () => {},
    timeouts: { "load-report": 50, fonts: 50, print: 50, write: 50 },
    ...overrides,
  };
}

function session(overrides: Partial<DesktopResultReportSession> = {}): DesktopResultReportSession {
  return {
    load: async () => {},
    waitForReadyReport: async () => identity,
    print: async () => Buffer.from("%PDF-test"),
    close: () => {},
    ...overrides,
  };
}
