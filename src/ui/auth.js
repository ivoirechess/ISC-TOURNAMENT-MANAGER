// Authentication UI: profile menu, login dialog, session status and
// admin/public visual mode. All Supabase access goes through src/data.js.
//
// Visual admin mode is interface comfort only: RLS enforces the rules
// server-side whatever this file displays.

import {
  signIn, signOut, getSession, onAuthChange, getCurrentRole, requestPasswordReset,
} from "../data.js";
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

let currentSession = null;
let authSubscriptionStarted = false;
let lastFocusedElement = null;

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
  currentSession = session;
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

export function showLoginView(show) {
  const dialog = el("login-view");
  if (show) {
    lastFocusedElement = document.activeElement;
    setMenuOpen(false);
    dialog.hidden = false;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else {
        dialog.setAttribute("open", "");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.classList.add("dialog-fallback");
      }
    }
    queueMicrotask(() => el("login-email").focus());
  } else {
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    dialog.classList.remove("dialog-fallback");
    el("login-error").textContent = "";
    const focusTarget = lastFocusedElement?.isConnected ? lastFocusedElement : el("profile-button");
    focusTarget?.focus();
  }
}

function recoveryRedirectUrl() {
  const url = new URL(window.location.href);
  url.hash = "/mot-de-passe";
  return url.href;
}

export function initAuth({ onStateChange } = {}) {
  // Install every local handler synchronously. Network and Supabase setup run
  // afterwards and can never prevent an anonymous visitor opening the dialog.
  el("profile-button").addEventListener("click", () => {
    if (currentSession) setMenuOpen(el("profile-menu").hidden);
    else showLoginView(true);
  });

  el("login-button").addEventListener("click", () => {
    showLoginView(true);
  });

  // Keep this small menu predictable on desktop, keyboard and touch screens.
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && !event.target.closest(".profile")) setMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setMenuOpen(false);
      if (el("login-view").open) {
        event.preventDefault();
        showLoginView(false);
      }
    }
  });

  el("login-cancel").addEventListener("click", () => {
    showLoginView(false);
  });

  el("login-view").addEventListener("click", (event) => {
    if (event.target === el("login-view")) showLoginView(false);
  });
  el("login-view").addEventListener("cancel", (event) => {
    event.preventDefault();
    showLoginView(false);
  });

  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = el("login-error");
    const submit = el("login-submit");
    errorBox.textContent = "";
    submit.disabled = true;
    submit.textContent = "Connexion…";
    try {
      await signIn(el("login-email").value.trim(), el("login-password").value);
      el("login-form").reset();
      showLoginView(false);
    } catch (err) {
      errorBox.textContent = "Connexion impossible. Vérifiez vos identifiants et votre réseau.";
    } finally {
      submit.disabled = false;
      submit.textContent = "Se connecter";
    }
    await refreshAuthState();
  });

  el("forgot-password").addEventListener("click", async () => {
    const email = el("login-email");
    const feedback = el("login-error");
    if (!email.reportValidity()) return;
    feedback.textContent = "Envoi du lien…";
    try {
      await requestPasswordReset(email.value.trim(), recoveryRedirectUrl());
      feedback.textContent = "Si ce compte existe, un lien de réinitialisation a été envoyé.";
    } catch (error) {
      feedback.textContent = error.message;
    }
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

  void refreshAuthState();
  if (!authSubscriptionStarted) {
    authSubscriptionStarted = true;
    void onAuthChange(async () => {
      await refreshAuthState();
      onStateChange?.();
    }).catch(() => {
      // Without configuration the site stays usable in public mode.
    });
  }
}
