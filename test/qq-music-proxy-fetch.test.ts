import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import { createQQMusicProxyFetch, QQMusicProxyError } from "../src/qq-music/proxy-fetch";

test("QQ proxy fetch preserves Request input through HTTP absolute-form forwarding", async (context) => {
  let observedUrl = "";
  let observedAuth = "";
  let observedBody = "";
  const proxy = http.createServer(async (request, response) => {
    observedUrl = request.url ?? "";
    observedAuth = String(request.headers["proxy-authorization"] ?? "");
    for await (const chunk of request) observedBody += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(proxy);
  context.after(() => close(proxy));

  const fetchViaProxy = createQQMusicProxyFetch({
    proxyUrl: `http://user:secret@127.0.0.1:${port}`,
  });
  const response = await fetchViaProxy(new Request("http://example.test/path?q=1", {
    method: "POST",
    headers: { "x-qq-test": "request-input" },
    body: "payload",
  }));

  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(observedUrl, "http://example.test/path?q=1");
  assert.equal(observedAuth, `Basic ${Buffer.from("user:secret").toString("base64")}`);
  assert.equal(observedBody, "payload");
});

test("QQ HTTPS CONNECT succeeds without leaking proxy credentials to the target", async (context) => {
  let targetProxyAuth: string | undefined;
  const target = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (request, response) => {
    targetProxyAuth = request.headers["proxy-authorization"] as string | undefined;
    response.end("through-tunnel");
  });
  const targetPort = await listen(target);
  context.after(() => close(target));

  let connectAuth = "";
  const tunnelSockets = new Set<net.Socket>();
  const proxy = http.createServer();
  proxy.on("connect", (request, clientSocket, head) => {
    tunnelSockets.add(clientSocket);
    clientSocket.once("close", () => tunnelSockets.delete(clientSocket));
    connectAuth = String(request.headers["proxy-authorization"] ?? "");
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    tunnelSockets.add(upstream);
    upstream.once("close", () => tunnelSockets.delete(upstream));
    upstream.on("error", () => clientSocket.destroy());
  });
  const proxyPort = await listen(proxy);
  context.after(() => {
    for (const socket of tunnelSockets) socket.destroy();
    return close(proxy);
  });

  const fetchViaProxy = createQQMusicProxyFetch({
    proxyUrl: `http://proxy-user:proxy-secret@127.0.0.1:${proxyPort}`,
    targetRejectUnauthorized: false,
  });
  const response = await fetchViaProxy(`https://localhost:${targetPort}/comments`, {
    headers: { "proxy-authorization": "must-not-reach-target" },
  });
  assert.equal(await response.text(), "through-tunnel");
  assert.equal(
    connectAuth,
    `Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`,
  );
  assert.equal(targetProxyAuth, undefined);
});

test("QQ HTTPS proxy transport reuses a healthy CONNECT and disposes it explicitly", async (context) => {
  const target = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (_request, response) => {
    response.end("ok");
  });
  const targetPort = await listen(target);
  context.after(() => close(target));
  let connectCount = 0;
  const tunnelSockets = new Set<net.Socket>();
  const proxy = http.createServer();
  proxy.on("connect", (_request, clientSocket, head) => {
    connectCount += 1;
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    for (const socket of [clientSocket, upstream]) {
      tunnelSockets.add(socket);
      socket.once("close", () => tunnelSockets.delete(socket));
    }
    upstream.on("error", () => clientSocket.destroy());
  });
  const proxyPort = await listen(proxy);
  context.after(() => {
    for (const socket of tunnelSockets) socket.destroy();
    return close(proxy);
  });
  const fetchViaProxy = createQQMusicProxyFetch({
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    targetRejectUnauthorized: false,
  });

  assert.equal(await (await fetchViaProxy(`https://localhost:${targetPort}/one`)).text(), "ok");
  assert.equal(await (await fetchViaProxy(`https://localhost:${targetPort}/two`)).text(), "ok");
  assert.equal(connectCount, 1);
  fetchViaProxy.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal([...tunnelSockets].filter((socket) => !socket.destroyed).length, 0);
});

test("aborting one QQ request does not destroy another healthy tunnel on the shared lane agent", async (context) => {
  let slowStarted!: () => void;
  const sawSlow = new Promise<void>((resolve) => { slowStarted = resolve; });
  let healthyStarted!: () => void;
  const sawHealthy = new Promise<void>((resolve) => { healthyStarted = resolve; });
  const target = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (request, response) => {
    if (request.url === "/slow") {
      slowStarted();
      return;
    }
    healthyStarted();
    setTimeout(() => response.end("healthy"), 30);
  });
  const targetPort = await listen(target);
  context.after(() => close(target));
  const tunnelSockets = new Set<net.Socket>();
  const proxy = http.createServer();
  proxy.on("connect", (_request, clientSocket, head) => {
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    for (const socket of [clientSocket, upstream]) {
      tunnelSockets.add(socket);
      socket.once("close", () => tunnelSockets.delete(socket));
    }
    upstream.on("error", () => clientSocket.destroy());
  });
  const proxyPort = await listen(proxy);
  context.after(() => {
    for (const socket of tunnelSockets) socket.destroy();
    return close(proxy);
  });
  const fetchViaProxy = createQQMusicProxyFetch({
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    targetRejectUnauthorized: false,
    maxSockets: 2,
  });
  context.after(() => fetchViaProxy.close());

  const slowAbort = new AbortController();
  const slow = fetchViaProxy(`https://localhost:${targetPort}/slow`, { signal: slowAbort.signal });
  await sawSlow;
  const healthy = fetchViaProxy(`https://localhost:${targetPort}/healthy`);
  await sawHealthy;
  slowAbort.abort();

  await assert.rejects(slow, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(await (await healthy).text(), "healthy");
});

test("QQ proxy CONNECT is fail-closed on non-200 response", async (context) => {
  const proxy = http.createServer();
  proxy.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  const port = await listen(proxy);
  context.after(() => close(proxy));
  const fetchViaProxy = createQQMusicProxyFetch({ proxyUrl: `http://127.0.0.1:${port}` });

  await assert.rejects(
    fetchViaProxy("https://does-not-resolve.invalid/comments"),
    (error: unknown) => error instanceof QQMusicProxyError && error.status === 502,
  );
});

test("QQ proxy abort closes a pending CONNECT before any tunneled request starts", async (context) => {
  let connectSeen = (): void => {};
  const connected = new Promise<void>((resolve) => { connectSeen = resolve; });
  let tunneledBytes = 0;
  let proxySocket: net.Socket | undefined;
  const proxy = http.createServer();
  proxy.on("connect", (_request, socket) => {
    proxySocket = socket;
    socket.on("error", () => {});
    socket.on("data", (chunk) => { tunneledBytes += chunk.length; });
    connectSeen();
  });
  const port = await listen(proxy);
  context.after(() => {
    proxySocket?.destroy();
    return close(proxy);
  });
  const fetchViaProxy = createQQMusicProxyFetch({
    proxyUrl: `http://127.0.0.1:${port}`,
    connectTimeoutMs: 1_000,
  });
  const controller = new AbortController();
  const pending = fetchViaProxy("https://example.invalid/comments", { signal: controller.signal });
  await connected;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
  if (proxySocket && !proxySocket.destroyed) {
    proxySocket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {});
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tunneledBytes, 0);
});

test("QQ proxy CONNECT timeout is bounded", async (context) => {
  let proxySocket: net.Socket | undefined;
  const proxy = http.createServer();
  proxy.on("connect", (_request, socket) => { proxySocket = socket; });
  const port = await listen(proxy);
  context.after(() => {
    proxySocket?.destroy();
    return close(proxy);
  });
  const fetchViaProxy = createQQMusicProxyFetch({
    proxyUrl: `http://127.0.0.1:${port}`,
    connectTimeoutMs: 20,
  });
  await assert.rejects(fetchViaProxy("https://example.invalid/comments"), /CONNECT timed out/);
});

function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Expected TCP address."));
      else resolve(address.port);
    });
  });
}

function close(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC3f7n8WF9xB1as
nZlytQnycRwjgAjFYoVcwe+vspe4LM1Y3bXEjkIVv5T3ULvQE+n/N4ePi3oyll+s
td8JOTj4eTeb3g1S9XLzKRnLxN1qUL+ElwBrmI+Gm4isjhjyiNoOUwhn2fEaK8uh
8tiKBWo7gNUozxL3JsohLdRhrZ9cpKU5PpjAVta95uyEdSct1s6ABdAWYqFC7F5f
+gkqSxBjHfuBzCtOgfYndsj64i7dcF5ByExjF8bhviCMNNoSXcLxISCoOgl/CTyS
NKiHKImR62dJXz/djEOdZy4QqRTTFoN8bjgtJdyai+Dr/GEqRbvoF8029Oi1C3J2
fwYp4drPAgMBAAECggEBAIyNulEvA9QY8ewAP6RcRYU93HbYwF8oysw1BLoIyyvY
rWXPVUZ8TORJvfn+Dg4g4tCJoT1zcaNECX7KRE/VU+0HNHAgkwYjWewlZEvvvEWO
GlSeMUU5M17AzdyWb0d/Sb9FHKAnkQUh3LVsxS5bXXa8hQngKz/Cp3roltBG5FVZ
vYxsbEMLbCbgs9wk4rfSl5+GqpGQqgxy+A62Gda5GCUVD4KB22xXkdBuUippK0/U
Lqh9St/Jc/dSTmvuH/vDEMe4h0unsj0HVWrLCf7ubW4ITwwdi2rirfoBz93riX13
oqYolibMBX1TLJZrdv1fxaoJTJ5iLrXBZRW+MBC4f0kCgYEA9ClK96Uv9T0m/Q1N
1BQDSMEX/6SRqeQumJ68aJSwAbpGJLlUjWmluHwLyWNWJEsxPLu3lDBpsOimSWiX
EymKkQm8IXCo6uqhW2HasL8rq45dZGaQBIijP1cU74npYqaUPe10HWXF/icHDVOP
Ylv3V799ZyA++T2RJ9Qf5YueigsCgYEAwGVyxtdrUq8oZNs2Cbe3ckEPzFVDCIeu
fwyRUNIiaL6xvb7olfPmPZkj0uuBwGLKlb9i37cU+oxHhNGJ9cGEJuEhaRYBegYd
tRDKyiodNSz4g1hn179hnsrNbFFmFPhrfFNEuM0lfwyhA1dFjVk33uofKo0hxKZh
Dxwdi9Rp8M0CgYB9NzgVLQgdUxFNsab6XpEYnL58AqAZasZiyvWBBNAG8srKRqmQ
JGAy7pr02xbwYgeMSBDr1LA/Y/DzsMnZr/I6U63B0I8wesfpn5OSFViGEOrgdKDj
Ule2QiigeC/Swe9AmyhzcyBJKSa6tOHR5axBuhjL7IOfOu3YaTc6d5IE5QKBgFj+
E+sZtZDXaE3Of95a1kXJBm+zeIA3kmU+APFrYXMl0b080wSZfoQ7k7B6Mtg0WhSO
JEPqwY9q16H98lx0mJYLSJL9FM3GinM4QzTj6gKwvHq0p8PJyHPUxtQ1ioxkpAMr
2PvKGG/9/XQ4J/nLrOY1URkzks0NUJPWo2wMYrx5AoGAeql01qMFEc9m40FeEqka
7Mm1+i4r1T2enXgAT6MahFZKUImXIJxGeX7MKbS4OAGBoVXoxxCuIVb8c4CnXy2f
ub4jjX2gEkqN68IGxTLcuH69xvGH3zbqf/MZQZ04mGNCthtgvJ7REVqRQi3WVMh7
XeVk26sM76UMLS8zhylUepg=
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQD7/bstD1DO5TANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjYwODA3MDg0MjU0WhcNMzYwODA0MDg0MjU0WjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC3
f7n8WF9xB1asnZlytQnycRwjgAjFYoVcwe+vspe4LM1Y3bXEjkIVv5T3ULvQE+n/
N4ePi3oyll+std8JOTj4eTeb3g1S9XLzKRnLxN1qUL+ElwBrmI+Gm4isjhjyiNoO
Uwhn2fEaK8uh8tiKBWo7gNUozxL3JsohLdRhrZ9cpKU5PpjAVta95uyEdSct1s6A
BdAWYqFC7F5f+gkqSxBjHfuBzCtOgfYndsj64i7dcF5ByExjF8bhviCMNNoSXcLx
ISCoOgl/CTySNKiHKImR62dJXz/djEOdZy4QqRTTFoN8bjgtJdyai+Dr/GEqRbvo
F8029Oi1C3J2fwYp4drPAgMBAAEwDQYJKoZIhvcNAQELBQADggEBADMPhII7DO+V
Z5y5SHBxTjbzxlxoAp/SnkhzOcbq65wmgUJzyheICwEyco7LX6sPJFYqNdUh58EE
ZzYV7tsaciKPieN7nIVgj6r6LS+ZWFGQOPTdWqM1I0bqe+o+2EWuN6y6BNDl41v8
F3yXn3Xvfsi25T7JNvicx3sjHaxGt1jzWp39aA2gNebJuCHkghYfO0LL+7heHiyW
p+eZBS+Wu5rcc39e32bTfYFXdPqPRXHQHCoDN6SuPjE9bfLGe54AUQdhe41sbhZc
++FMafu5u7nHI4USQ0z8IrUxHJ0jxiFnGdjNWNIvu/buxBCLUZ3OZvVWZXNzW4EF
fQQXZjLvlNo=
-----END CERTIFICATE-----`;
