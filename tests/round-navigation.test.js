import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectDefaultRound } from "../src/round-entry.js";
import { startDoneMessage, startHint } from "../src/ui/lifecycle-actions.js";

function rounds(count, validatedThrough = 0) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    released_at: "now",
    validated_at: index < validatedThrough ? "now" : null,
    pairings: [{ result: index < validatedThrough ? "1-0" : null }],
  }));
}

test("Toutes rondes 10 joueurs : ouvre la première des 9 rondes à jouer", () => {
  const tournament = { status: "ongoing", format: "round_robin", rounds_planned: 9 };
  assert.equal(selectDefaultRound(tournament, rounds(9, 3)), 4);
  assert.equal(selectDefaultRound(tournament, rounds(9, 3), 2), 2);
});

test("un Suisse ouvre sa première ronde débloquée non validée", () => {
  const tournament = { status: "ongoing", format: "swiss", rounds_planned: 5 };
  assert.equal(selectDefaultRound(tournament, rounds(3, 2)), 3);
});

test("un tournoi terminé et un tournoi entièrement validé ouvrent la dernière ronde", () => {
  assert.equal(selectDefaultRound({ status: "archived" }, rounds(9, 9)), 9);
  assert.equal(selectDefaultRound({ status: "ongoing" }, rounds(9, 9)), 9);
  assert.equal(selectDefaultRound({ status: "draft" }, rounds(9)), 1);
  assert.equal(selectDefaultRound({ status: "draft" }, []), null);
});

test("les messages de démarrage distinguent Suisse et calendriers préparés", () => {
  assert.equal(startDoneMessage({ format: "swiss" }), "Tournoi démarré. Ronde 1 générée.");
  assert.equal(
    startDoneMessage({ format: "round_robin" }),
    "Tournoi démarré. Le calendrier est maintenant actif."
  );
  assert.match(startHint({ format: "double_round_robin" }), /active le calendrier préparé/);
});

test("le routeur accepte ?ronde= et les onglets remplacent l'URL sans recharger", () => {
  const app = readFileSync(new URL("../src/ui/app.js", import.meta.url), "utf8");
  const view = readFileSync(new URL("../src/ui/rounds.js", import.meta.url), "utf8");
  assert.match(app, /URLSearchParams/);
  assert.match(app, /query\.get\("ronde"\)/);
  assert.match(view, /history\.replaceState/);
  assert.match(view, /\?onglet=pairings&ronde=\$\{roundNumber\}/);
});

test("les écrans utilisent stateLabel plutôt que STATUS_LABELS", () => {
  for (const file of ["home.js", "standings.js", "tournament-edit.js", "trash.js", "tournament-page.js"]) {
    const source = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /STATUS_LABELS/);
    assert.match(source, /stateLabel/);
  }
});
