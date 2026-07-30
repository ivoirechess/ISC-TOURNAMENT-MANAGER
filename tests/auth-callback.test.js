import test from "node:test";
import assert from "node:assert/strict";

import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  PASSWORD_SETUP_HASH,
  authCallbackFailureMessage,
  parseAuthCallback,
  passwordSetupIntro,
  passwordSetupLanding,
  validateNewPassword,
} from "../src/auth-callback.js";

// Exactly what GoTrue builds, parameters sorted by url.Values.Encode().
const TOKENS =
  "access_token=jeton&expires_at=9999999999&expires_in=3600" +
  "&refresh_token=rafraichissement&sb=&token_type=bearer";

test("lien d'invitation", async (t) => {
  await t.test("un fragment simple livre ses jetons", () => {
    const callback = parseAuthCallback(`#${TOKENS}&type=invite`);
    assert.equal(callback.present, true);
    assert.equal(callback.blocking, true);
    assert.equal(callback.type, "invite");
    assert.equal(callback.accessToken, "jeton");
    assert.equal(callback.refreshToken, "rafraichissement");
    assert.equal(callback.route, null);
    assert.equal(callback.failed, false);
  });

  await t.test("un lien de réinitialisation bloque aussi", () => {
    const callback = parseAuthCallback(`#${TOKENS}&type=recovery`);
    assert.equal(callback.blocking, true);
    assert.equal(callback.type, "recovery");
  });

  // The redirect URL used to carry the application route, so Supabase
  // appended a second fragment behind the first. The Supabase client reads
  // nothing out of that shape; this module has to.
  await t.test("un fragment double reste lisible, route comprise", () => {
    const callback = parseAuthCallback(`#/administration/utilisateurs#${TOKENS}&type=invite`);
    assert.equal(callback.blocking, true);
    assert.equal(callback.accessToken, "jeton");
    assert.equal(callback.route, "#/administration/utilisateurs");
  });

  await t.test("le '#' de tête est facultatif", () => {
    assert.equal(parseAuthCallback(`${TOKENS}&type=invite`).accessToken, "jeton");
  });

  await t.test("une route sans jeton n'est pas un rappel", () => {
    for (const hash of ["", "#/", "#/joueurs", "#/tournoi/open-abidjan?onglet=standings"]) {
      const callback = parseAuthCallback(hash);
      assert.equal(callback.present, false, hash);
      assert.equal(callback.blocking, false, hash);
      assert.equal(callback.accessToken, null, hash);
    }
  });

  // A magic link or a signup confirmation is not our business: the account
  // already has a password, and blocking it would be a dead end.
  await t.test("un autre type de rappel ne bloque pas", () => {
    const callback = parseAuthCallback(`#${TOKENS}&type=magiclink`);
    assert.equal(callback.present, true);
    assert.equal(callback.blocking, false);
    assert.equal(callback.type, "magiclink");
  });
});

test("lien mort", async (t) => {
  await t.test("un lien expiré est signalé, sans jeton", () => {
    const callback = parseAuthCallback(
      "#error=access_denied&error_code=otp_expired" +
      "&error_description=Email+link+is+invalid+or+has+expired"
    );
    assert.equal(callback.failed, true);
    assert.equal(callback.blocking, true);
    assert.equal(callback.accessToken, null);
    assert.equal(callback.errorCode, "otp_expired");
    assert.equal(callback.errorDescription, "Email link is invalid or has expired");
  });

  await t.test("une erreur peut arriver derrière une route", () => {
    const callback = parseAuthCallback(
      "#/administration/utilisateurs#error=access_denied&error_code=otp_expired"
    );
    assert.equal(callback.blocking, true);
    assert.equal(callback.route, "#/administration/utilisateurs");
  });

  await t.test("une erreur en query string compte aussi", () => {
    const callback = parseAuthCallback("#/", "?error=server_error&error_code=unexpected_failure");
    assert.equal(callback.failed, true);
    assert.equal(callback.blocking, true);
  });

  await t.test("chaque cas a un message actionnable en français", () => {
    for (const errorCode of ["otp_expired", "access_denied", "unexpected_failure", null]) {
      const message = authCallbackFailureMessage({ errorCode });
      assert.match(message, /super-administrateur/);
      assert.doesNotMatch(message, /[A-Za-z]+_[a-z]+/);
    }
  });
});

test("validation du mot de passe", async (t) => {
  await t.test("un mot de passe conforme passe", () => {
    assert.deepEqual(validateNewPassword("Tournoi2026!Abidjan", "Tournoi2026!Abidjan"), {
      ok: true,
      errors: [],
    });
  });

  await t.test("trop court", () => {
    const check = validateNewPassword("court", "court");
    assert.equal(check.ok, false);
    assert.match(check.errors[0], new RegExp(String(MINIMUM_PASSWORD_LENGTH)));
  });

  await t.test("la limite est inclusive des deux côtés", () => {
    assert.equal(validateNewPassword("a".repeat(MINIMUM_PASSWORD_LENGTH), "a".repeat(MINIMUM_PASSWORD_LENGTH)).ok, true);
    assert.equal(validateNewPassword("a".repeat(MAXIMUM_PASSWORD_LENGTH), "a".repeat(MAXIMUM_PASSWORD_LENGTH)).ok, true);
    assert.equal(validateNewPassword("a".repeat(MAXIMUM_PASSWORD_LENGTH + 1), "a".repeat(MAXIMUM_PASSWORD_LENGTH + 1)).ok, false);
  });

  await t.test("confirmation différente", () => {
    const check = validateNewPassword("Tournoi2026!Abidjan", "Tournoi2026!Bouake");
    assert.equal(check.ok, false);
    assert.match(check.errors.join(" "), /ne correspondent pas/);
  });

  await t.test("des espaces seuls ne font pas un mot de passe", () => {
    assert.equal(validateNewPassword(" ".repeat(20), " ".repeat(20)).ok, false);
  });

  await t.test("aucun message ne répète le mot de passe", () => {
    const secret = "MotDePasseEnClair2026";
    const messages = [
      ...validateNewPassword(secret, "autre").errors,
      ...validateNewPassword("x", "x").errors,
    ].join(" ");
    assert.doesNotMatch(messages, new RegExp(secret));
  });

  await t.test("une entrée absente est refusée sans lever", () => {
    assert.equal(validateNewPassword(undefined, undefined).ok, false);
    assert.equal(validateNewPassword(null, "").ok, false);
  });
});

test("atterrissage après définition du mot de passe", async (t) => {
  await t.test("le super-admin revient à l'administration", () => {
    assert.equal(passwordSetupLanding("super_admin"), "#/administration/utilisateurs");
  });

  await t.test("un organisateur va à l'accueil, où sont ses tournois", () => {
    // #/administration/utilisateurs would bounce them straight back.
    assert.equal(passwordSetupLanding("admin"), "#/");
    assert.equal(passwordSetupLanding(null), "#/");
  });

  await t.test("l'écran a sa propre route", () => {
    assert.equal(PASSWORD_SETUP_HASH, "#/definir-mot-de-passe");
    assert.equal(parseAuthCallback(PASSWORD_SETUP_HASH).blocking, false);
  });

  await t.test("l'introduction distingue invitation et réinitialisation", () => {
    assert.match(passwordSetupIntro("invite"), /invitation/i);
    assert.match(passwordSetupIntro("recovery"), /réinitialisation/i);
    assert.match(passwordSetupIntro(null), /invitation/i);
  });
});
