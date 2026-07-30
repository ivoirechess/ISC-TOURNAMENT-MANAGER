// The blocking "set your password" screen, shown when someone arrives through
// an invitation or a password-reset e-mail link.
//
// Order matters here. The Supabase client clears `location.hash` as soon as it
// initialises, and the `type=invite` marker exists nowhere else — so
// `captureAuthCallback()` has to run before anything creates that client. It
// is synchronous and touches nothing but the URL for exactly that reason.
//
// This is an interface gate, not a protection: the session the link carries is
// a genuine Supabase session, and RLS decides what it may write either way.
// What the screen guarantees is that the account ends up with a password —
// without one, the invitee could never sign in again.

import {
  PASSWORD_SETUP_HASH,
  authCallbackFailureMessage,
  parseAuthCallback,
  passwordSetupIntro,
  passwordSetupLanding,
  validateNewPassword,
} from "../auth-callback.js";
import { getCurrentRole, getSession, setSessionFromEmailLink, updatePassword } from "../data.js";

// Survives a reload of the same tab: the credentials leave the URL on arrival,
// so without this marker refreshing the page would walk straight past the
// screen. sessionStorage, not localStorage — the gate belongs to this visit.
const PENDING_KEY = "isc.password-setup";

let pending = null;
let sessionOpened = false;

function el(id) {
  return document.getElementById(id);
}

/** True while the password screen must preempt every other route. */
export function isPasswordSetupPending() {
  return pending !== null;
}

function replaceHash(hash) {
  // replaceState rather than an assignment: the tokens must leave the address
  // bar and the history entry, not gain a second one next to it.
  if (typeof history?.replaceState === "function") {
    history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
  } else {
    location.hash = hash;
  }
}

/**
 * Reads the invitation / reset link out of the URL and strips it. MUST run
 * before the first Supabase call of the page.
 * @returns {boolean} true when the blocking screen has to open
 */
export function captureAuthCallback() {
  const callback = parseAuthCallback(window.location.hash, window.location.search);
  if (callback.blocking) {
    pending = callback;
    sessionOpened = false;
    sessionStorage.setItem(PENDING_KEY, callback.failed ? "failed" : callback.type ?? "invite");
    replaceHash(PASSWORD_SETUP_HASH);
    return true;
  }

  const resumed = sessionStorage.getItem(PENDING_KEY);
  if (resumed) {
    // Same visit, page reloaded: the tokens are gone, but the session they
    // opened is still there. Carry on with the session alone.
    pending = { ...parseAuthCallback(""), blocking: true, failed: resumed === "failed", type: resumed === "failed" ? null : resumed };
    sessionOpened = !pending.failed;
    replaceHash(PASSWORD_SETUP_HASH);
    return true;
  }

  pending = null;
  return false;
}

function showForm(show) {
  el("password-setup-form").hidden = !show;
}

function fail(message) {
  el("password-setup-title").textContent = "Lien expiré ou déjà utilisé";
  el("password-setup-intro").textContent =
    "Le lien que vous avez suivi ne permet plus de définir un mot de passe.";
  el("password-setup-error").textContent = message;
  showForm(false);
}

/** Opens (or re-opens) the screen. Idempotent: the router may call it again. */
export async function openPasswordSetup() {
  if (!pending) return;
  document.body.classList.add("auth-gate");
  if (location.hash !== PASSWORD_SETUP_HASH) replaceHash(PASSWORD_SETUP_HASH);

  if (pending.failed) {
    fail(authCallbackFailureMessage(pending));
    return;
  }

  el("password-setup-title").textContent = "Définir votre mot de passe";
  el("password-setup-intro").textContent = passwordSetupIntro(pending.type);

  if (!sessionOpened) {
    try {
      await setSessionFromEmailLink(pending);
      sessionOpened = true;
      // Consumed: a second attempt with the same tokens would be refused.
      pending = { ...pending, accessToken: null, refreshToken: null };
    } catch {
      // The message deliberately ignores the exception: a token is never
      // worth quoting back to the person holding it.
      fail(authCallbackFailureMessage(pending));
      return;
    }
  } else if (!(await hasSession())) {
    fail("Votre session n'est plus valide. Demandez au super-administrateur de vous renvoyer une invitation.");
    return;
  }

  el("password-setup-error").textContent = "";
  showForm(true);
  el("password-setup-new").focus();
}

async function hasSession() {
  try {
    return (await getSession()) !== null;
  } catch {
    return false;
  }
}

async function finish() {
  pending = null;
  sessionOpened = false;
  sessionStorage.removeItem(PENDING_KEY);
  document.body.classList.remove("auth-gate");

  let role = null;
  try {
    role = await getCurrentRole();
  } catch {
    // Unreadable role: the home page is the safe landing for anyone.
    role = null;
  }
  window.location.hash = passwordSetupLanding(role);
}

/** Binds the form once, at start-up. */
export function initPasswordSetup() {
  const form = el("password-setup-form");
  const newPassword = el("password-setup-new");
  const confirmation = el("password-setup-confirm");
  const errorBox = el("password-setup-error");
  const submit = el("password-setup-submit");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.textContent = "";

    const check = validateNewPassword(newPassword.value, confirmation.value);
    if (!check.ok) {
      errorBox.textContent = check.errors.join(" ");
      return;
    }

    submit.disabled = true;
    try {
      await updatePassword(newPassword.value);
    } catch (error) {
      // data.js maps Supabase codes to French sentences; none of them can
      // contain the password, and the raw exception is not logged.
      errorBox.textContent = error.message;
      submit.disabled = false;
      return;
    }

    // Nothing keeps the plaintext in the DOM once it has been accepted.
    form.reset();
    submit.disabled = false;
    await finish();
  });
}
