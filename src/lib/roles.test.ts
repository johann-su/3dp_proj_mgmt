import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canActAsOwner,
  isAdmin,
  isModerator,
  parseUserRole,
  roleFromOidcGroups,
} from "@/lib/roles";

test("parseUserRole accepts exactly the three known roles", () => {
  assert.equal(parseUserRole("user"), "user");
  assert.equal(parseUserRole("moderator"), "moderator");
  assert.equal(parseUserRole("admin"), "admin");
  // Anything else — including casing variants — is rejected, so a crafted
  // action input can't invent a role.
  assert.equal(parseUserRole("Admin"), null);
  assert.equal(parseUserRole("owner"), null);
  assert.equal(parseUserRole(""), null);
  assert.equal(parseUserRole(null), null);
  assert.equal(parseUserRole(42), null);
});

test("admin counts as moderator (tiers nest, not fork)", () => {
  assert.equal(isModerator("admin"), true);
  assert.equal(isModerator("moderator"), true);
  assert.equal(isAdmin("moderator"), false);
});

test("unknown or missing roles degrade to plain user", () => {
  // Sessions from before the role column existed carry no role; they must
  // never pass an elevated check.
  for (const role of [undefined, null, "", "superuser"]) {
    assert.equal(isModerator(role), false);
    assert.equal(isAdmin(role), false);
  }
});

test("OIDC group mapping is authoritative when a usable claim arrives", () => {
  const mapping = { adminGroup: "homelab-admins", moderatorGroup: "mods" };
  assert.equal(roleFromOidcGroups(["homelab-admins"], mapping), "admin");
  assert.equal(roleFromOidcGroups(["mods"], mapping), "moderator");
  // Admin group wins when the user is in both.
  assert.equal(roleFromOidcGroups(["mods", "homelab-admins"], mapping), "admin");
  // In neither mapped group → demoted to plain user, so removing someone
  // from the IdP group revokes the role on their next login.
  assert.equal(roleFromOidcGroups(["other"], mapping), "user");
  assert.equal(roleFromOidcGroups([], mapping), "user");
  // Group names match exactly — no substring/casing tolerance.
  assert.equal(roleFromOidcGroups(["Homelab-Admins"], mapping), "user");
});

test("OIDC group mapping stays inert without config or without a claim", () => {
  // No groups configured → mapping is off entirely.
  assert.equal(roleFromOidcGroups(["homelab-admins"], {}), null);
  // Mapping configured but the claim is missing or malformed → leave the
  // stored role alone (an IdP that stops sending `groups` must not demote
  // every user on their next login).
  const mapping = { adminGroup: "homelab-admins" };
  assert.equal(roleFromOidcGroups(undefined, mapping), null);
  assert.equal(roleFromOidcGroups("homelab-admins", mapping), null);
  assert.equal(roleFromOidcGroups([42], mapping), null);
});

test("canActAsOwner passes for the owner and for moderators/admins", () => {
  assert.equal(canActAsOwner({ id: "a", role: "user" }, "a"), true);
  assert.equal(canActAsOwner({ id: "b", role: "user" }, "a"), false);
  assert.equal(canActAsOwner({ id: "b", role: "moderator" }, "a"), true);
  assert.equal(canActAsOwner({ id: "b", role: "admin" }, "a"), true);
  // The owner passes even without a role value (pre-migration session).
  assert.equal(canActAsOwner({ id: "a" }, "a"), true);
});
