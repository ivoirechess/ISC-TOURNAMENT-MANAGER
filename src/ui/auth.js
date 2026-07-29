// Authentication UI: profile menu, login dialog, session status and
// admin/public visual mode. All Supabase access goes through src/data.js.
//
// Visual admin mode is interface comfort only: RLS enforces the rules
// server-side whatever this file displays.

import { signIn, signOut, getSession, onAuthChange, getCurrentRole } from "../data.js";
import { isAdminRole, roleLabel } from "../roles.js";

function el(id) {
  return document.getElementById(id);
}

/** Best available human-readable identity, with a safe email fallback. */
export function sessionDisplayName(session) {
  const user = session?.user;
  const metadataName = user?.user_metadata?.full_name ?? user?.user_metadata?.name;
  if (typeof metadataName === "string" && metadataName.trim()) return metadataName.trim();
  if (typeof user?.email === "string" && user.email.trim()) return user.email.trim();
  return "Compte organisateur";
}

function setMenuOpen(open) {
  el("profile-menu").hidden = !open;
  el("profile-button").setAttribute("aria-expanded", String(open));
}

async function refreshAuthState() {
  let role = null;
  let session = null;
  try {
    session = await getSession();
    // The visual mode relies on the role stored in profiles, never on the
    // mere presence of a session.
    if (session) role = await getCurrentRole();
  } catch {
    // Missing configuration or network failure: fall back to public mode.
    role = null;
  }

  const admin = isAdminRole(role);
  document.body.classList.toggle("is-admin", admin);

  const identity = el("profile-identity");
  const name = el("auth-name");
  const roleName = el("auth-role");
  const logoutButton = el("logout-button");
  const loginButton = el("login-button");

  if (session) {
    name.textContent = sessionDisplayName(session);
    roleName.textContent = roleLabel(role);
    identity.hidden = false;
    logoutButton.hidden = false;
    loginButton.hidden = true;
  } else {
    name.textContent = "";
    roleName.textContent = "";
    identity.hidden = true;
    logoutButton.hidden = true;
    loginButton.hidden = false;
  }
}

function showLoginView(show) {
  const dialog = el("login-view");
  if (show) {
    setMenuOpen(false);
    // showModal() throws if the dialog is already open, which would abort
    // the handler and leave the click looking like it did nothing.
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    el("login-email").focus();
  } else if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

export async function initAuth() {
  el("profile-button").addEventListener("click", () => {
    setMenuOpen(el("profile-menu").hidden);
  });

  el("login-button").addEventListener("click", () => {
    showLoginView(true);
  });

  // Keep this small menu predictable on desktop, keyboard and touch screens.
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".profile")) setMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setMenuOpen(false);
  });

  el("login-cancel").addEventListener("click", () => {
    el("login-error").textContent = "";
    showLoginView(false);
  });

  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = el("login-error");
    errorBox.textContent = "";
    try {
      await signIn(el("login-email").value.trim(), el("login-password").value);
      el("login-form").reset();
      showLoginView(false);
    } catch (err) {
      errorBox.textContent = err.message;
    }
    await refreshAuthState();
  });

  el("logout-button").addEventListener("click", async () => {
    setMenuOpen(false);
    try {
      await signOut();
    } catch {
      // Even if the server call fails, refresh to reflect the real state.
    }
    await refreshAuthState();
  });

  await refreshAuthState();

  try {
    await onAuthChange(() => {
      refreshAuthState();
    });
  } catch {
    // Without configuration the site stays usable in public mode.
  }
}
