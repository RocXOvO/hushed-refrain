import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import tls, { type TLSSocket } from "node:tls";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface QQMusicProxyFetchOptions {
  proxyUrl: string;
  connectTimeoutMs?: number;
  /** Intended only for loopback tests with a self-signed target. */
  targetRejectUnauthorized?: boolean;
  /** Intended only for a self-signed HTTPS proxy. */
  proxyRejectUnauthorized?: boolean;
  /** Maximum reusable proxy tunnels created by one lane. */
  maxSockets?: number;
}

export type QQMusicProxyFetch = typeof fetch & { close(): void };

export class QQMusicProxyError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "QQMusicProxyError";
  }
}

interface NormalizedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: Buffer;
  signal: AbortSignal;
}

/**
 * Creates a fetch-compatible transport that never falls back to a direct request.
 * QQ's HTTPS endpoints use an HTTP CONNECT tunnel for both HTTP and HTTPS proxies.
 */
export function createQQMusicProxyFetch(options: QQMusicProxyFetchOptions): QQMusicProxyFetch {
  const proxy = validateProxyUrl(options.proxyUrl);
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const maxSockets = options.maxSockets ?? 8;
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error("QQ proxy connectTimeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(maxSockets) || maxSockets <= 0) {
    throw new Error("QQ proxy maxSockets must be a positive integer.");
  }
  const targetRejectUnauthorized = options.targetRejectUnauthorized ?? true;
  const proxyRejectUnauthorized = options.proxyRejectUnauthorized ?? true;
  const tunnelAgent = new QQHttpsProxyAgent(proxy, {
    maxSockets,
    connectTimeoutMs,
    proxyRejectUnauthorized,
    targetRejectUnauthorized,
  });
  const forwardAgent = proxy.protocol === "https:"
    ? new https.Agent({ keepAlive: true, maxSockets, rejectUnauthorized: proxyRejectUnauthorized })
    : new http.Agent({ keepAlive: true, maxSockets });

  const proxyFetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const normalized = await normalizeRequest(input, init);
    const target = normalized.url;
    if (target.protocol === "https:") {
      return tunnelHttpsRequest(tunnelAgent, target, normalized, {
        targetRejectUnauthorized,
      });
    }
    if (target.protocol === "http:") {
      return forwardHttpRequest(proxy, target, normalized, {
        connectTimeoutMs,
        proxyRejectUnauthorized,
        agent: forwardAgent,
      });
    }
    throw new Error("QQ proxy fetch supports only http:// and https:// targets.");
  }) as QQMusicProxyFetch;
  proxyFetch.close = (): void => {
    tunnelAgent.destroy();
    forwardAgent.destroy();
  };
  return proxyFetch;
}

function tunnelHttpsRequest(
  agent: QQHttpsProxyAgent,
  target: URL,
  request: NormalizedRequest,
  options: {
    targetRejectUnauthorized: boolean;
  },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const requestToken = agent.nextRequestToken();
    const signal = request.signal;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let upstreamRequest: ReturnType<typeof https.request> | undefined;
    let settled = false;

    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      agent.cancelPending(requestToken);
      upstreamRequest?.destroy();
      // Only this request/socket is failed. Destroying the shared Agent here
      // would also tear down unrelated healthy CONNECT tunnels on this lane.
      // The lane owner closes the Agent when the lane itself is retired.
      reject(error);
    };
    const finishResolve = (response: Response): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const abort = (): void => finishReject(abortError());
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    upstreamRequest = https.request({
      protocol: "https:",
      hostname: target.hostname,
      port: numberPort(target.port, 443),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: requestHeaders(request.headers, target, request.body),
      agent,
      rejectUnauthorized: options.targetRejectUnauthorized,
      __qqRequestToken: requestToken,
    } as https.RequestOptions, (incoming) => collectResponse(incoming).then(finishResolve, finishReject));
    upstreamRequest.once("error", finishReject);
    if (request.body) upstreamRequest.write(request.body);
    upstreamRequest.end();
  });
}

class QQHttpsProxyAgent extends https.Agent {
  private readonly pending = new Map<number, ReturnType<typeof http.request>>();
  private requestToken = 0;

  constructor(
    private readonly proxy: URL,
    private readonly tunnelOptions: {
      maxSockets: number;
      connectTimeoutMs: number;
      proxyRejectUnauthorized: boolean;
      targetRejectUnauthorized: boolean;
    },
  ) {
    super({ keepAlive: true, maxSockets: tunnelOptions.maxSockets });
  }

  nextRequestToken(): number {
    this.requestToken += 1;
    return this.requestToken;
  }

  cancelPending(requestToken: number): void {
    this.pending.get(requestToken)?.destroy(abortError());
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | undefined {
    if (!callback) throw new Error("QQ proxy tunnel requires an asynchronous connection callback.");
    const hostname = String(options.hostname ?? options.host ?? "");
    const requestToken = Number((options as https.RequestOptions & { __qqRequestToken?: number }).__qqRequestToken);
    const port = typeof options.port === "number"
      ? options.port
      : numberPort(String(options.port ?? ""), 443);
    let settled = false;
    let proxySocket: Socket | undefined;
    let tlsSocket: TLSSocket | undefined;
    const finish = (error?: Error, stream?: TLSSocket): void => {
      if (settled) return;
      settled = true;
      if (Number.isInteger(requestToken)) this.pending.delete(requestToken);
      if (error) {
        tlsSocket?.destroy();
        proxySocket?.destroy();
      }
      callback(error ?? null, stream ?? (undefined as unknown as Duplex));
    };
    const connectRequest = proxyRequest(this.proxy, {
      method: "CONNECT",
      path: authority(hostname, port),
      headers: {
        host: authority(hostname, port),
        "proxy-connection": "keep-alive",
        ...proxyAuthorization(this.proxy),
      },
      rejectUnauthorized: this.tunnelOptions.proxyRejectUnauthorized,
    });
    if (Number.isInteger(requestToken)) this.pending.set(requestToken, connectRequest);
    connectRequest.setTimeout(this.tunnelOptions.connectTimeoutMs, () => {
      const error = new QQMusicProxyError("QQ proxy CONNECT timed out.");
      connectRequest.destroy(error);
      finish(error);
    });
    connectRequest.once("socket", (socket) => { proxySocket = socket; });
    connectRequest.once("error", (error) => finish(error));
    connectRequest.once("connect", (response, socket, head) => {
      connectRequest.setTimeout(0);
      proxySocket = socket;
      if (response.statusCode !== 200) {
        response.resume();
        finish(new QQMusicProxyError(
          `QQ proxy CONNECT failed with status ${response.statusCode ?? 0}.`,
          response.statusCode,
        ));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      tlsSocket = tls.connect({
        socket,
        servername: hostname,
        rejectUnauthorized: this.tunnelOptions.targetRejectUnauthorized,
      });
      tlsSocket.once("error", (error) => finish(error));
      tlsSocket.once("secureConnect", () => finish(undefined, tlsSocket));
    });
    connectRequest.end();
    return undefined;
  }

  override destroy(): void {
    for (const request of this.pending.values()) request.destroy(abortError());
    this.pending.clear();
    super.destroy();
  }
}

function forwardHttpRequest(
  proxy: URL,
  target: URL,
  requestInit: NormalizedRequest,
  options: {
    connectTimeoutMs: number;
    proxyRejectUnauthorized: boolean;
    agent: http.Agent | https.Agent;
  },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (requestInit.signal.aborted) {
      reject(abortError());
      return;
    }
    const request = proxyRequest(proxy, {
      method: requestInit.method,
      path: target.toString(),
      headers: {
        ...requestHeaders(requestInit.headers, target, requestInit.body),
        ...proxyAuthorization(proxy),
      },
      rejectUnauthorized: options.proxyRejectUnauthorized,
      agent: options.agent,
    }, (incoming) => collectResponse(incoming).then(resolve, reject));
    const abort = (): void => {
      request.destroy(abortError());
    };
    requestInit.signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => requestInit.signal.removeEventListener("abort", abort));
    request.setTimeout(options.connectTimeoutMs, () => {
      request.destroy(new QQMusicProxyError("QQ proxy request timed out."));
    });
    request.once("error", reject);
    if (requestInit.body) request.write(requestInit.body);
    request.end();
  });
}

function proxyRequest(
  proxy: URL,
  options: http.RequestOptions & { rejectUnauthorized?: boolean },
  callback?: (response: IncomingMessage) => void,
): ReturnType<typeof http.request> {
  const request = proxy.protocol === "https:" ? https.request : http.request;
  return request({
    hostname: proxy.hostname,
    port: numberPort(proxy.port, proxy.protocol === "https:" ? 443 : 80),
    servername: proxy.protocol === "https:" ? proxy.hostname : undefined,
    ...options,
  }, callback);
}

async function collectResponse(incoming: IncomingMessage): Promise<Response> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const status = incoming.statusCode ?? 502;
  const body = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
  return new Response(body, {
    status,
    statusText: incoming.statusMessage,
    headers: responseHeaders(incoming.headers),
  });
}

function requestHeaders(
  input: HeadersInit | undefined,
  target: URL,
  body: Buffer | undefined,
): Record<string, string> {
  const headers = new Headers(input);
  headers.delete("proxy-authorization");
  headers.delete("proxy-connection");
  headers.set("host", target.host);
  if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}

function responseHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function proxyAuthorization(proxy: URL): Record<string, string> {
  if (!proxy.username && !proxy.password) return {};
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return {
    "proxy-authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
}

function validateProxyUrl(value: string): URL {
  const proxy = new URL(value);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error("QQ proxy must use http:// or https://.");
  }
  if (!proxy.hostname) throw new Error("QQ proxy hostname is required.");
  if (proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw new Error("QQ proxy URL must not contain a path, query, or fragment.");
  }
  return proxy;
}

async function normalizeRequest(
  input: string | URL | Request,
  init: RequestInit,
): Promise<NormalizedRequest> {
  const request = new Request(input, init);
  return {
    url: new URL(request.url),
    method: request.method,
    headers: request.headers,
    body: request.body ? Buffer.from(await request.arrayBuffer()) : undefined,
    signal: request.signal,
  };
}

function numberPort(value: string, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("Invalid network port.");
  return port;
}

function authority(hostname: string, port: number): string {
  return `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

function abortError(): Error {
  const error = new Error("The QQ proxy request was aborted.");
  error.name = "AbortError";
  return error;
}
