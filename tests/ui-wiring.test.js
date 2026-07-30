import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const html = read("index.html");
const app = read("src/ui/app.js");

// These are static checks on the source, not on a running page: they catch
// the wiring mistakes that leave a button silently dead, which is exactly
// how the sign-in dialog stopped opening.
describe("câblage de l'interface", () => {
  test("chaque identifiant utilisé par le JS existe dans index.html", () => {
    // Un `el("id")` qui ne trouve rien renvoie null, et le
    // `.addEventListener` qui suit leve — ce qui, au demarrage, tuait des
    // pans entiers de l'interface sans le moindre message.
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const missing = [];
    for (const file of readdirSync(new URL("src/ui/", root))) {
      const source = read(`src/ui/${file}`);
      for (const match of source.matchAll(/\bel\("([^"]+)"\)/g)) {
        if (!ids.has(match[1])) missing.push(`src/ui/${file} → #${match[1]}`);
      }
      for (const match of source.matchAll(/getElementById\("([^"]+)"\)/g)) {
        if (!ids.has(match[1])) missing.push(`src/ui/${file} → #${match[1]}`);
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });

  test("la connexion est câblée avant les autres écrans", () => {
    // L'ordre compte : c'est ce qui garantit qu'une panne ailleurs ne prive
    // pas l'organisateur de la connexion.
    const body = app.slice(app.indexOf("async function init()"));
    const auth = body.indexOf("initAuth");
    const form = body.indexOf("initTournamentForm");
    const edit = body.indexOf("initTournamentEdit");
    assert.ok(auth !== -1 && form !== -1 && edit !== -1);
    assert.ok(auth < form, "initAuth doit venir avant initTournamentForm");
    assert.ok(auth < edit, "initAuth doit venir avant initTournamentEdit");
  });

  test("chaque étape du démarrage est isolée", () => {
    const body = app.slice(app.indexOf("async function init()"));
    for (const initialiser of ["initAuth", "initTournamentForm", "initTournamentEdit"]) {
      assert.match(
        body,
        new RegExp(`step\\("[^"]+", ${initialiser}\\)`),
        `${initialiser} doit passer par step(), pour qu'un echec n'emporte pas le reste`
      );
    }
  });

  test("un démarrage qui échoue le dit à l'utilisateur", () => {
    // Sans cela l'erreur reste dans la console, invisible pour l'arbitre.
    assert.match(app, /init\(\)\.catch\(/);
    assert.match(app, /el\("startup-error"\)/);
    assert.ok(html.includes('id="startup-error"'));
  });
});

describe("écran de définition du mot de passe", () => {
  const passwordSetup = read("src/ui/password-setup.js");
  const data = read("src/data.js");
  const invite = read("supabase/functions/invite-admin/index.ts");

  test("le rappel d'invitation est lu avant toute initialisation Supabase", () => {
    // C'est l'invariant qui fait tenir tout le flux : le client Supabase vide
    // `location.hash` des qu'il demarre, et le marqueur `type=invite`
    // n'existe nulle part ailleurs. Le lire apres, c'est le perdre.
    const body = app.slice(app.indexOf("async function init()"));
    const capture = body.indexOf("captureAuthCallback");
    const auth = body.indexOf("initAuth");
    assert.ok(capture !== -1, "captureAuthCallback doit etre appele au demarrage");
    assert.ok(capture < auth, "captureAuthCallback doit venir avant initAuth");
    assert.match(body, /step\("[^"]+", captureAuthCallback\)/);
    assert.match(body, /step\("[^"]+", initPasswordSetup\)/);
  });

  test("l'écran préempte toutes les autres routes", () => {
    const body = app.slice(app.indexOf("async function route()"));
    const gate = body.indexOf("isPasswordSetupPending()");
    assert.ok(gate !== -1, "route() doit interroger la porte");
    // Aucune autre vue ne doit pouvoir s'ouvrir avant elle.
    for (const branch of ["#/nouveau-tournoi", "#/corbeille", "#/joueurs", "#/administration/utilisateurs"]) {
      const position = body.indexOf(branch);
      assert.ok(position === -1 || gate < position, `${branch} est atteignable avant la porte`);
    }
    assert.ok(app.includes('"view-password-setup"'), "la vue doit figurer dans VIEWS");
    assert.ok(html.includes('id="view-password-setup"'));
  });

  test("le formulaire valide lui-même, en français", () => {
    // novalidate : sans cela le navigateur affiche ses propres bulles, dans
    // sa langue, et nos messages ne s'affichent jamais.
    const form = html.slice(html.indexOf('id="password-setup-form"'));
    assert.match(form.slice(0, form.indexOf(">")), /novalidate/);
    assert.match(passwordSetup, /validateNewPassword\(/);
  });

  test("aucun mot de passe ni jeton n'est journalisé", () => {
    for (const [name, source] of [["password-setup.js", passwordSetup], ["data.js", data]]) {
      assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/, `${name} ne doit rien journaliser ici`);
    }
    // Le message d'erreur vient de nos propres libellés, jamais de la valeur
    // saisie ni de l'exception brute renvoyée par Supabase.
    assert.doesNotMatch(passwordSetup, /newPassword\.value\s*\+|\$\{[^}]*password[^}]*\}/i);
  });

  test("l'URL de redirection de l'invitation ne porte aucun fragment", () => {
    // Supabase concatene `redirectTo + "#" + jetons` : un fragment de plus et
    // le client ne retrouve plus un seul jeton.
    assert.match(invite, /url\.hash\s*=\s*""/);
    assert.doesNotMatch(invite, /redirectTo\s*=\s*`[^`]*#/);
  });
});

describe("identité visuelle", () => {
  test("le logo est un fichier versionné, référencé par l'en-tête", () => {
    const size = statSync(new URL("assets/logo.png", root)).size;
    assert.ok(size > 1000, "le logo doit être un vrai fichier");
    assert.ok(size < 300 * 1024, `logo trop lourd pour un en-tête : ${size} octets`);
    assert.match(html, /class="brand-logo" src="\.\/assets\/logo\.png"/);
  });

  test("il garde ses proportions et porte un texte alternatif", () => {
    const tag = html.slice(html.indexOf('class="brand-logo"'));
    const img = tag.slice(0, tag.indexOf(">"));
    assert.match(img, /width="192"/);
    assert.match(img, /height="192"/);
    assert.match(img, /alt="[^"]+"/);
    // Carre affiche dans une boite carree, avec object-fit en filet.
    assert.match(html, /\.brand-logo \{[^}]*object-fit: contain;/s);
  });

  test("le menu profil affiche nom et rôle une fois connecté", () => {
    for (const id of ["profile-button", "profile-menu", "auth-name", "auth-role"]) {
      assert.ok(html.includes(`id="${id}"`), `#${id} manquant`);
    }
    const auth = read("src/ui/auth.js");
    assert.match(auth, /name\.textContent = sessionDisplayName\(session\)/);
    assert.match(auth, /roleName\.textContent = roleLabel\(role\)/);
  });

  test("le bouton profil reste accessible au clavier et aux lecteurs d'écran", () => {
    const button = html.slice(html.indexOf('id="profile-button"'));
    const tag = button.slice(0, button.indexOf(">"));
    assert.match(tag, /aria-label="[^"]+"/);
    assert.match(tag, /aria-expanded="false"/);
    assert.match(tag, /aria-controls="profile-menu"/);
  });
});
