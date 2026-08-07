import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inlineProxyDefinitions,
  selectProxyCandidates,
} from "../src/clash-profile-merge";

test("selects candidates fairly across multiple Clash configs", () => {
  const selected = selectProxyCandidates([
    [
      { name: "HK A1", type: "ss", server: "a1.example", port: 443 },
      { name: "HK A2", type: "ss", server: "a2.example", port: 443 },
    ],
    [
      { name: "HK B1", type: "ss", server: "b1.example", port: 443 },
      { name: "HK B2", type: "ss", server: "b2.example", port: 443 },
    ],
  ], 2);

  assert.deepEqual(selected.map((proxy) => proxy.server), ["a1.example", "b1.example"]);
});

test("rejects provider-backed and chained proxy configs explicitly", () => {
  assert.throws(() => inlineProxyDefinitions({
    "proxy-providers": { remote: { type: "http", url: "https://example.invalid/sub" } },
    proxies: [{ name: "inline", type: "ss" }],
  }), /proxy-providers/);
  assert.throws(() => inlineProxyDefinitions({
    proxies: [{ name: "chain", type: "ss", "dialer-proxy": "base" }],
  }), /dialer-proxy/);
  assert.throws(() => inlineProxyDefinitions({ proxies: [] }), /内联代理节点/);
});
