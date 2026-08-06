import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import api = require("@neteasecloudmusicapienhanced/api");

interface QrLoginOptions {
  cookiePath: string;
  qrPath: string;
  timeoutSeconds: number;
  pollIntervalMs?: number;
  onReady: (qrUrl: string, qrPath: string) => void;
  onStatus?: (code: number) => void;
}

export async function qrLogin(options: QrLoginOptions): Promise<void> {
  const keyResponse = await api.login_qr_key({});
  const keyBody = asObject(keyResponse.body);
  const key = text(asObject(keyBody.data).unikey);
  if (!key) throw new Error("QR login did not return a unikey.");

  const createResponse = await api.login_qr_create({ key, qrimg: true });
  const data = asObject(asObject(createResponse.body).data);
  const qrUrl = text(data.qrurl);
  const qrImage = text(data.qrimg);
  if (!qrUrl || !qrImage) throw new Error("QR login did not return an image.");

  await mkdir(dirname(options.qrPath), { recursive: true });
  const encoded = qrImage.replace(/^data:image\/png;base64,/, "");
  await writeFile(options.qrPath, Buffer.from(encoded, "base64"));
  options.onReady(qrUrl, options.qrPath);

  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  const pollInterval = options.pollIntervalMs ?? 3_000;
  while (Date.now() < deadline) {
    await sleep(pollInterval);
    const response = await api.login_qr_check({ key });
    const body = asObject(response.body);
    const code = Number(body.code);
    options.onStatus?.(code);

    if (code === 803) {
      const cookie = text(body.cookie);
      if (!cookie) throw new Error("QR login succeeded without a cookie.");
      await mkdir(dirname(options.cookiePath), { recursive: true });
      await writeFile(options.cookiePath, `${cookie.trim()}\n`, "utf8");
      if (process.platform !== "win32") await chmod(options.cookiePath, 0o600);
      return;
    }
    if (code === 800) throw new Error("QR code expired.");
  }
  throw new Error(`QR login timed out after ${options.timeoutSeconds} seconds.`);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
