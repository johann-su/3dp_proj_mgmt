import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bambuTokenHealth,
  EXPIRY_WARNING_DAYS,
  formatDaysLeft,
  jwtExpiry,
  resolveTokenExpiry,
} from "@/lib/bambu/token-expiry";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-01-01T00:00:00Z");

function jwt(payload: object): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc(payload)}.sig`;
}

test("jwtExpiry reads the exp claim of a pasted MakerWorld cookie", () => {
  const exp = Math.floor(now.getTime() / 1000) + 3600;
  assert.equal(jwtExpiry(jwt({ exp }))?.getTime(), exp * 1000);
});

test("jwtExpiry is null for opaque tokens and JWTs without exp", () => {
  assert.equal(jwtExpiry("not-a-jwt"), null);
  assert.equal(jwtExpiry("a.%%%.c"), null);
  assert.equal(jwtExpiry(jwt({ sub: "x" })), null);
});

test("resolveTokenExpiry prefers the login response's expiresIn over the JWT", () => {
  // expiresIn is what Bambu says about *this* token; the claim may be absent.
  const token = jwt({ exp: Math.floor(now.getTime() / 1000) + 10 });
  const got = resolveTokenExpiry(token, 7776000, now);
  assert.equal(got?.getTime(), now.getTime() + 7776000 * 1000);
});

test("resolveTokenExpiry falls back to the JWT claim, then to unknown", () => {
  const exp = Math.floor(now.getTime() / 1000) + 60;
  assert.equal(resolveTokenExpiry(jwt({ exp }), undefined, now)?.getTime(), exp * 1000);
  // Never invent a date — an unknown expiry must not trigger reminders.
  assert.equal(resolveTokenExpiry("opaque", undefined, now), null);
  assert.equal(resolveTokenExpiry("opaque", 0, now), null);
});

test("bambuTokenHealth: unknown expiry counts as valid", () => {
  assert.deepEqual(bambuTokenHealth(null, null, now), { state: "valid", daysLeft: null });
});

test("bambuTokenHealth warns inside the reminder window", () => {
  const far = new Date(now.getTime() + 30 * DAY);
  assert.equal(bambuTokenHealth(far, null, now).state, "valid");
  const soon = new Date(now.getTime() + (EXPIRY_WARNING_DAYS - 1) * DAY + 1000);
  assert.deepEqual(bambuTokenHealth(soon, null, now), {
    state: "expiring",
    daysLeft: EXPIRY_WARNING_DAYS - 1,
  });
});

test("bambuTokenHealth: past expiry is expired", () => {
  const past = new Date(now.getTime() - 1000);
  assert.equal(bambuTokenHealth(past, null, now).state, "expired");
});

test("bambuTokenHealth: a token Bambu rejected is expired even with a future date", () => {
  // A 401 during import is ground truth; the stored expiry may be wrong.
  const far = new Date(now.getTime() + 60 * DAY);
  assert.equal(bambuTokenHealth(far, new Date(now), now).state, "expired");
});

test("formatDaysLeft: day 0 reads as 'less than a day', not '0 days'", () => {
  assert.equal(formatDaysLeft(0), "less than a day");
  assert.equal(formatDaysLeft(1), "1 day");
  assert.equal(formatDaysLeft(5), "5 days");
});
