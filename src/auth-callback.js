// Supabase e-mail links (invitation, password reset). PURE LOGIC — no DOM,
// no fetch, no Supabase. Everything here is derived from the URL the browser
// lands on when the invitee clicks the link in their mailbox.
//
// Why this module exists at all: Supabase Auth uses the *implicit* flow for
// these links (`flowType: 'implicit'` is the default of `createClient`, and
// `detectSessionInUrl` defaults to true). The server redirects to
// `redirectTo + "#" + parameters` — literally, string concatenation — and the
// client reads `location.hash` as if it were a query string.
//
// Two consequences this module has to absorb:
//
//   1. A `redirectTo` that already carries a route produces *two* fragments,
//      `#/une/route#access_token=…`, and the Supabase client then parses
//      `"/une/route#access_token"` as a parameter name and finds no token at
//      all. The invitee lands on the site with no session and no explanation.
//      Invitations sent that way are already in people's mailboxes, so the
//      shape is accepted here rather than only fixed at the source.
//
//   2. The `type=invite` / `type=recovery` marker exists *only* in that URL,
//      at the instant of the click. The session it produces is
//      indistinguishable from an ordinary sign-in afterwards. So the marker
//      has to be read before anything else touches the URL.
//
// Nothing here is a security boundary: the session carried by the link is a
// real session issued by Supabase, and RLS decides what it may write. The
// password screen is what makes the account usable, not what protects it.

/** Link types that must lead to the "set your password" screen. */
export const PASSWORD_LINK_TYPES = ["invite", "recovery"];

/**
 * House rule, stricter than the Supabase default of 6. These accounts run
 * tournaments for a whole club; the extra characters cost one screen, once.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/** bcrypt, which Supabase hashes with, silently ignores anything past 72. */
export const MAXIMUM_PASSWORD_LENGTH = 72;

/** Hash of the blocking screen. */
export const PASSWORD_SETUP_HASH = "#/definir-mot-de-passe";

// A fragment segment holds credentials as soon as it names one of the
// parameters Supabase puts there — the tokens on success, the error triplet
// on a dead link.
const CREDENTIAL_KEYS = ["access_token", "refresh_token", "error", "error_code", "error_description"];

function readParameters(segment) {
  const values = {};
  if (!segment) return values;
  try {
    new URLSearchParams(segment).forEach((value, key) => {
      values[key] = value;
    });
  } catch {
    // Not a query string: nothing to read, and nothing to report either.
  }
  return values;
}

function holdsCredentials(values) {
  return CREDENTIAL_KEYS.some((key) => typeof values[key] === "string" && values[key] !== "");
}

/**
 * Reads an authentication callback out of the URL.
 *
 * @param {string} hash   `window.location.hash`, with or without its '#'
 * @param {string} search `window.location.search`, for the error redirects
 *                        that use the query string instead
 * @returns {{
 *   present: boolean, blocking: boolean, type: string|null, route: string|null,
 *   accessToken: string|null, refreshToken: string|null,
 *   failed: boolean, errorCode: string|null, errorDescription: string|null
 * }}
 */
export function parseAuthCallback(hash = "", search = "") {
  const raw = typeof hash === "string" ? hash.replace(/^#/, "") : "";
  const segments = raw === "" ? [] : raw.split("#");

  // The credentials are always what Supabase appended last; anything before
  // them is the route the redirect URL was carrying.
  let index = -1;
  let values = {};
  for (let position = segments.length - 1; position >= 0; position -= 1) {
    const candidate = readParameters(segments[position]);
    if (holdsCredentials(candidate)) {
      index = position;
      values = candidate;
      break;
    }
  }

  const queryValues = readParameters(typeof search === "string" ? search.replace(/^\?/, "") : "");
  if (index === -1 && holdsCredentials(queryValues)) values = queryValues;
  else if (index !== -1) values = { ...queryValues, ...values };

  const routeSegments = index > 0 ? segments.slice(0, index) : [];
  const route = routeSegments.length ? `#${routeSegments.join("#")}` : null;

  const type = typeof values.type === "string" && values.type !== "" ? values.type : null;
  const errorCode = values.error_code ?? values.error ?? null;
  const failed = Boolean(values.error || values.error_code || values.error_description);
  const present = failed || Boolean(values.access_token);

  return {
    present,
    // An error carries no `type` of its own. The only e-mail links this site
    // sends are invitations and password resets, so a failed callback is one
    // of those and deserves the screen that can explain it.
    blocking: present && (failed || PASSWORD_LINK_TYPES.includes(type)),
    type,
    route,
    accessToken: values.access_token ?? null,
    refreshToken: values.refresh_token ?? null,
    failed,
    errorCode,
    errorDescription: values.error_description ?? null,
  };
}

/**
 * Checks a password and its confirmation. Returns the errors to display; the
 * password itself is never part of a message.
 */
export function validateNewPassword(password, confirmation) {
  const errors = [];
  const value = typeof password === "string" ? password : "";

  if (value.length < MINIMUM_PASSWORD_LENGTH) {
    errors.push(`Le mot de passe doit compter au moins ${MINIMUM_PASSWORD_LENGTH} caractères.`);
  } else if (value.length > MAXIMUM_PASSWORD_LENGTH) {
    errors.push(`Le mot de passe ne peut pas dépasser ${MAXIMUM_PASSWORD_LENGTH} caractères.`);
  } else if (value.trim() === "") {
    errors.push("Le mot de passe ne peut pas être composé uniquement d'espaces.");
  }

  if (value !== (typeof confirmation === "string" ? confirmation : "")) {
    errors.push("Les deux mots de passe ne correspondent pas.");
  }

  return { ok: errors.length === 0, errors };
}

/** Where the account lands once its password is set. */
export function passwordSetupLanding(role) {
  // A super-admin comes back to the screen invitations are managed from. An
  // organizer would only be bounced from it, so they land on the home page,
  // where their own tournaments and the "create" action are.
  return role === "super_admin" ? "#/administration/utilisateurs" : "#/";
}

/** Introductory sentence of the screen, per link type. */
export function passwordSetupIntro(type) {
  if (type === "recovery") {
    return "Vous avez suivi un lien de réinitialisation. Choisissez un nouveau " +
      "mot de passe pour retrouver l'accès à votre compte organisateur.";
  }
  return "Bienvenue. Votre compte organisateur a été créé par invitation : " +
    "choisissez un mot de passe pour pouvoir vous connecter ensuite.";
}

/**
 * Turns a failed callback into something an organizer can act on. The raw
 * `error_description` is written for developers, in English, so it is
 * translated rather than shown.
 */
export function authCallbackFailureMessage(callback = {}) {
  const code = callback.errorCode ?? null;
  if (code === "otp_expired" || code === "access_denied") {
    return "Ce lien a expiré ou a déjà été utilisé. Demandez au " +
      "super-administrateur de vous renvoyer une invitation.";
  }
  return "Ce lien n'a pas pu être vérifié. Demandez au super-administrateur " +
    "de vous renvoyer une invitation.";
}
