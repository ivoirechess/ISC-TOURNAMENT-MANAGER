// Authentication UI: discreet login link, login form, session status,
// admin/public visual mode. All Supabase access goes through src/data.js.
//
// Visual admin mode is interface comfort only: RLS enforces the rules
// server-side whatever this file displays.

import { signIn, signOut, getSession, onAuthChange, getCurrentRole } from "../data.js";
import { isAdminRole, roleLabel } from "../roles.js";

function el(id) {
  return document.getElementById(id);
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

  const status = el("auth-status");
  const logoutButton = el("logout-button");
  const loginLink = el("login-link");

  if (session) {
    status.textContent = `${roleLabel(role)} — ${session.user?.email ?? ""}`;
    logoutButton.hidden = false;
    loginLink.hidden = true;
  } else {
    status.textContent = "";
    logoutButton.hidden = true;
    loginLink.hidden = false;
  }
}

function showLoginView(show) {
  el("login-view").hidden = !show;
  if (show) el("login-email").focus();
}

export async function initAuth() {
  el("login-link").addEventListener("click", (event) => {
    event.preventDefault();
    showLoginView(true);
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
