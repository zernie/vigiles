/**
 * Egress allowlist test suite: pure helpers — parseGetent family split, resolveAllow (injected resolver), parseResolvers, buildEgressNft (policy drop, DNS allow, per-host v4/ip6 rules, comment sanitize, log+drop tail), buildEgressBwrapArgv (caps/info-fd/`VIG_*` env/sh -c tail), parseNftCounters (v4+v6 sum, drop aggregate), countersToResult, probeEgressAvailable short-circuit
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  parseGetent,
  resolveAllow,
  parseResolvers,
  buildEgressNft,
  buildEgressBwrapArgv,
  parseNftCounters,
  countersToResult,
  probeEgressAvailable,
  egressAvailable,
} from "./egress.js";

test("parseGetent splits unique IPs by family, ignores junk", () => {
  const out = parseGetent(
    [
      "104.20.22.46  STREAM example.com",
      "104.20.22.46  DGRAM",
      "104.20.23.46  STREAM",
      "2606:4700::6810:162e STREAM example.com",
      "2606:4700::6810:162e DGRAM",
      "   ", // blank
      "not-an-ip here",
    ].join("\n"),
  );
  assert.deepEqual(out.v4, ["104.20.22.46", "104.20.23.46"]);
  assert.deepEqual(out.v6, ["2606:4700::6810:162e"]);
});

test("resolveAllow maps each host through the injected resolver", () => {
  const fake = (host: string) =>
    host === "a.com" ? { v4: ["1.1.1.1"], v6: [] } : { v4: [], v6: ["::1"] };
  const out = resolveAllow(["a.com", "b.com"], fake);
  assert.deepEqual(out, [
    { host: "a.com", v4: ["1.1.1.1"], v6: [] },
    { host: "b.com", v4: [], v6: ["::1"] },
  ]);
});

test("resolveAllow defaults to the real getent resolver", () => {
  // no injected lookup → exercises the default getentLookup (shells out to
  // getent; the verdict is host/env-dependent, but the shape is invariant).
  const out = resolveAllow([]);
  assert.deepEqual(out, []);
  const [r] = resolveAllow(["localhost"]);
  assert.equal(r?.host, "localhost");
  assert.ok(Array.isArray(r?.v4) && Array.isArray(r?.v6));
});

test("parseResolvers reads nameservers, falls back to 8.8.8.8", () => {
  assert.deepEqual(
    parseResolvers("# comment\nnameserver 1.1.1.1\nnameserver 8.8.4.4\n"),
    ["1.1.1.1", "8.8.4.4"],
  );
  assert.deepEqual(parseResolvers("search lan\n"), ["8.8.8.8"]);
});

test("parseResolvers drops loopback stubs (netns can't reach 127.0.0.53)", () => {
  // GitHub runners' systemd-resolved stub → no routable resolver → public fallback
  assert.deepEqual(parseResolvers("nameserver 127.0.0.53\n"), ["8.8.8.8"]);
  assert.deepEqual(parseResolvers("nameserver ::1\n"), ["8.8.8.8"]);
  // a routable resolver alongside the stub is kept; the stub is dropped
  assert.deepEqual(
    parseResolvers("nameserver 127.0.0.53\nnameserver 9.9.9.9\n"),
    ["9.9.9.9"],
  );
});

test("buildEgressNft: policy drop, DNS allow, per-host v4/v6 rules, log+drop tail", () => {
  const nft = buildEgressNft({
    allow: [
      {
        host: "registry.npmjs.org",
        v4: ["104.20.22.46"],
        v6: ["2606:4700::1"],
      },
      { host: "v4only.test", v4: ["9.9.9.9"], v6: [] },
    ],
    resolvers: ["8.8.8.8"],
  });
  // the wall: default drop + loopback/established escapes
  assert.match(nft, /policy drop;/);
  assert.match(nft, /oifname "lo" accept/);
  assert.match(nft, /ct state established,related accept/);
  // DNS to the resolver, both protocols
  assert.match(nft, /ip daddr 8\.8\.8\.8 udp dport 53 counter accept/);
  assert.match(nft, /ip daddr 8\.8\.8\.8 tcp dport 53 counter accept/);
  // per-host: v4 via `ip daddr`, v6 via `ip6 daddr`, both labelled with the host
  assert.match(
    nft,
    /ip daddr \{ 104\.20\.22\.46 \} counter accept comment "allow:registry.npmjs.org"/,
  );
  assert.match(
    nft,
    /ip6 daddr \{ 2606:4700::1 \} counter accept comment "allow:registry.npmjs.org"/,
  );
  // a v4-only host emits no ip6 rule
  assert.match(
    nft,
    /ip daddr \{ 9\.9\.9\.9 \} counter accept comment "allow:v4only.test"/,
  );
  assert.doesNotMatch(nft, /ip6 daddr \{ 9\.9\.9\.9/);
  // the catch-all record + drop
  assert.match(nft, /log prefix "vig-drop " counter drop/);
});

test("buildEgressNft emits an ip6 rule for an IPv6 resolver", () => {
  const nft = buildEgressNft({
    allow: [],
    resolvers: ["2001:4860:4860::8888"],
  });
  assert.match(
    nft,
    /ip6 daddr 2001:4860:4860::8888 udp dport 53 counter accept comment "dns"/,
  );
});

test("buildEgressNft sanitizes a hostname so it can't break the comment", () => {
  const nft = buildEgressNft({
    allow: [{ host: 'evil"\nhost', v4: ["1.2.3.4"], v6: [] }],
    resolvers: ["8.8.8.8"],
  });
  assert.match(nft, /comment "allow:evil__host"/);
  assert.doesNotMatch(nft, /evil"/);
});

test("buildEgressBwrapArgv: caps, info-fd, VIG_* env, and the sh -c wrapper tail", () => {
  const argv = buildEgressBwrapArgv({
    base: ["--unshare-all", "--clearenv"],
    setenv: ["--setenv", "GUARD", "ok"],
    files: {
      ioDir: "/io",
      netready: "/io/netready",
      nft: "/io/rules.nft",
      event: "/io/event.json",
      counters: "/io/counters.txt",
    },
    command: "my-hook",
    wrapper: "WRAP",
    resolvConf: "/io/resolv.conf",
  });
  // the generated resolv.conf is bound over the host's (loopback-stub) one …
  const rb = argv.indexOf("/io/resolv.conf");
  assert.ok(rb > 0 && argv[rb - 1] === "--ro-bind");
  assert.equal(argv[rb + 1], "/etc/resolv.conf");
  // the in-netns wrapper needs CAP_NET_ADMIN to load nft …
  assert.ok(argv.includes("--cap-add") && argv.includes("CAP_NET_ADMIN"));
  // … the orchestrator learns the child PID via the info fd …
  assert.deepEqual(argv.slice(-5, -3), ["--info-fd", "3"]);
  // … the hook env is added back, and the VIG_* paths are passed through …
  assert.ok(argv.includes("GUARD"));
  assert.equal(argv[argv.indexOf("VIG_HOOK") + 1], "my-hook");
  assert.equal(argv[argv.indexOf("VIG_COUNTERS") + 1], "/io/counters.txt");
  // … and the payload is the wrapper under `sh -c`.
  assert.deepEqual(argv.slice(-3), ["sh", "-c", "WRAP"]);
});

test("parseNftCounters sums v4+v6 per host and reads the drop aggregate", () => {
  const text = [
    '    ip daddr 8.8.8.8 udp dport 53 counter packets 2 bytes 120 accept comment "dns"',
    '    ip daddr { 104.20.22.46 } counter packets 3 bytes 180 accept comment "allow:registry.npmjs.org"',
    '    ip6 daddr { 2606:4700::1 } counter packets 1 bytes 60 accept comment "allow:registry.npmjs.org"',
    '    log prefix "vig-drop " counter packets 11 bytes 660 drop',
  ].join("\n");
  const c = parseNftCounters(text);
  assert.deepEqual(c.allowed, [
    { host: "registry.npmjs.org", packets: 4, bytes: 240 },
  ]);
  assert.deepEqual(c.dropped, { packets: 11, bytes: 660 });
  // DNS counters are not surfaced as egress attempts
  assert.equal(
    c.allowed.find((a) => a.host === "dns"),
    undefined,
  );
});

test("parseNftCounters tolerates empty / countersless text", () => {
  const c = parseNftCounters("");
  assert.deepEqual(c.allowed, []);
  assert.deepEqual(c.dropped, { packets: 0, bytes: 0 });
});

test("countersToResult: reached hosts become allowed attempts; zero-traffic dropped", () => {
  const { egress, egressDropped } = countersToResult(
    {
      allowed: [
        { host: "registry.npmjs.org", packets: 4, bytes: 240 },
        { host: "unused.test", packets: 0, bytes: 0 }, // never contacted → omitted
      ],
      dropped: { packets: 0, bytes: 0 },
    },
    1234,
  );
  assert.equal(egress.length, 1);
  assert.deepEqual(egress[0], {
    host: "registry.npmjs.org",
    port: 0,
    ts: 1234,
    allowed: true,
    packets: 4,
    bytes: 240,
  });
  assert.deepEqual(egressDropped, { packets: 0, bytes: 0 });
});

test("probeEgressAvailable requires the bwrap probe AND the tools", () => {
  // available:false short-circuits regardless of the host's tools
  assert.equal(probeEgressAvailable(false), false);
  // available:true runs the real `command -v` PATH probe for slirp4netns/nft;
  // the verdict is host-dependent (true only where both resolve) but the probe
  // itself executes either way — a boolean, never a throw.
  assert.equal(typeof probeEgressAvailable(true), "boolean");
});

test("egressAvailable caches the probe verdict", () => {
  // first call runs probeEgressAvailable, then memoizes; both calls agree.
  const first = egressAvailable(false);
  assert.equal(typeof first, "boolean");
  assert.equal(egressAvailable(true), first); // cached → ignores the new arg
});
