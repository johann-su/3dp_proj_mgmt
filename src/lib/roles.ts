// Instance-wide user roles (issue #54). Two elevated tiers on top of the
// default "user":
//  - moderator: owner-equivalent on content — passes every owner-only gate
//    (trash/restore/purge any model, delete any collection, delete any
//    generated variant) and sees everyone's trash.
//  - admin: everything a moderator can do, plus user management
//    (Settings → Users: the user list and role changes).
// This is deliberately not per-resource RBAC — the instance stays a trusted
// group with collaborative editing; roles only extend the few owner-gated
// destructive actions to designated people. The first admin comes from
// INITIAL_ADMIN_EMAIL — see src/lib/admin.ts.

export const USER_ROLES = ["user", "moderator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function parseUserRole(raw: unknown): UserRole | null {
  return USER_ROLES.includes(raw as UserRole) ? (raw as UserRole) : null;
}

// Role checks take the raw session value: unknown role strings (or a missing
// value on sessions created before the column existed) degrade to plain
// "user" instead of granting anything.
export function isAdmin(role: string | null | undefined): boolean {
  return role === "admin";
}

export function isModerator(role: string | null | undefined): boolean {
  return role === "moderator" || role === "admin";
}

// The standard gate for owner-scoped actions: the owner themselves, or a
// moderator/admin acting owner-equivalent.
export function canActAsOwner(
  user: { id: string; role?: string | null },
  ownerId: string,
): boolean {
  return user.id === ownerId || isModerator(user.role);
}

// Maps an OIDC `groups` claim onto a role. `mapping` holds the exact group
// names as configured in the IdP (OIDC_ADMIN_GROUP / OIDC_MODERATOR_GROUP).
// Returns null when no mapping is configured OR the claim is missing or
// malformed — callers must leave the stored role untouched then, so an IdP
// that stops sending the claim can't mass-demote everyone. With a usable
// claim the result is authoritative for that login: membership in neither
// mapped group means plain "user" (removal from the group revokes the role).
export function roleFromOidcGroups(
  groups: unknown,
  mapping: { adminGroup?: string | null; moderatorGroup?: string | null },
): UserRole | null {
  if (!mapping.adminGroup && !mapping.moderatorGroup) return null;
  if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string")) {
    return null;
  }
  if (mapping.adminGroup && groups.includes(mapping.adminGroup)) return "admin";
  if (mapping.moderatorGroup && groups.includes(mapping.moderatorGroup)) {
    return "moderator";
  }
  return "user";
}
