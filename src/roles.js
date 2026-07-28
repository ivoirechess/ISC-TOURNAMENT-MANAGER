// Role helpers. PURE LOGIC — no DOM, no Supabase.
//
// Reminder (CLAUDE.md): who-can-write is enforced server-side by RLS.
// Everything in this module is interface comfort, never a protection.

export const ADMIN_ROLES = ["admin", "super_admin"];

/** True when the role (as stored in profiles.role) grants organizer UI. */
export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

/** Label displayed next to the session state, in French (UI language). */
export function roleLabel(role) {
  if (role === "super_admin") return "Super-admin";
  if (role === "admin") return "Organisateur";
  return "Visiteur";
}
