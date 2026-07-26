import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateOrReservedIp } from "@/lib/net-guard";

test("blocks loopback, RFC1918, and the cloud metadata address", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.5", "169.254.169.254"]) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
});

test("allows ordinary public IPv4 addresses", () => {
  for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1"]) {
    assert.equal(isPrivateOrReservedIp(ip), false, ip);
  }
});

test("blocks IPv6 loopback and unique-local/link-local ranges", () => {
  for (const ip of ["::1", "fd12:3456:789a::1", "fe80::1"]) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
});

test("unwraps IPv4-mapped and NAT64 IPv6 addresses before checking", () => {
  // A raw v6 literal can smuggle a private v4 target past a naive v6-only check.
  assert.equal(isPrivateOrReservedIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("64:ff9b::169.254.169.254"), true);
  assert.equal(isPrivateOrReservedIp("::ffff:8.8.8.8"), false);
});

test("allows ordinary public IPv6 addresses", () => {
  assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false);
});
