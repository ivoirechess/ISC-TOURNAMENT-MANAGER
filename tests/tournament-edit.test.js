import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GAME_RESULTS,
  RESULT_LABELS,
  validateTournamentName,
  canEditRoundsPlanned,
  validateRoundsPlannedEdit,
  validateResultEdit,
} from "../src/tournament-edit.js";
import { maxRounds } from "../src/swiss.js";

function tournament(overrides = {}) {
  return { id: "t1", name: "Open", format: "swiss", rounds_planned: 5, status: "draft", ...overrides };
}

describe("validateTournamentName", () => {
  test("un nom non vide est accepte", () => {
    assert.equal(validateTournamentName("Open de Cocody").ok, true);
  });

  test("nom vide ou blanc refuse", () => {
    for (const name of ["", "   ", undefined, null, 42]) {
      assert.equal(validateTournamentName(name).ok, false, `nom ${JSON.stringify(name)}`);
    }
  });
});

describe("canEditRoundsPlanned", () => {
  test("autorise sur un brouillon suisse", () => {
    assert.equal(canEditRoundsPlanned(tournament()).ok, true);
  });

  test("refuse des que le tournoi est lance", () => {
    for (const status of ["ongoing", "archived"]) {
      const result = canEditRoundsPlanned(tournament({ status }));
      assert.equal(result.ok, false, `statut ${status}`);
      assert.match(result.reason, /lancé/);
    }
  });

  test("refuse des qu'une ronde existe, meme en brouillon", () => {
    // Test de fond : `status` seul ne suffirait pas, le proprietaire pouvant
    // repasser son tournoi en brouillon pour rouvrir la regle.
    const result = canEditRoundsPlanned(tournament({ status: "draft" }), 1);
    assert.equal(result.ok, false);
    assert.match(result.reason, /déjà des rondes/);
  });

  test("un retour en brouillon ne rouvre pas la modification", () => {
    const reverted = tournament({ status: "draft" });
    assert.equal(canEditRoundsPlanned(reverted, 3).ok, false);
    assert.equal(canEditRoundsPlanned(reverted, 0).ok, true);
  });

  test("refuse sur les formats en cercle, meme en brouillon", () => {
    // Le calendrier entier est deja ecrit : deplacer la cible le desyncroniserait.
    for (const format of ["round_robin", "double_round_robin"]) {
      const result = canEditRoundsPlanned(tournament({ format, status: "draft" }));
      assert.equal(result.ok, false, `format ${format}`);
      assert.match(result.reason, /toutes les rencontres/);
    }
  });

  test("le motif du format prime, dans le meme ordre que le trigger", () => {
    // Un round-robin lance cumule les refus : le message doit rester celui
    // qui explique la cause structurelle, cote client comme cote serveur.
    const result = canEditRoundsPlanned(tournament({ format: "round_robin", status: "ongoing" }), 5);
    assert.equal(result.ok, false);
    assert.match(result.reason, /toutes les rencontres/);
  });
});

describe("validateRoundsPlannedEdit", () => {
  test("accepte une valeur licite sur un brouillon suisse", () => {
    const result = validateRoundsPlannedEdit(tournament(), 4, 10);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  test("applique le meme garde-fou qu'a la creation", () => {
    // 10 joueurs : le suisse plafonne a maxRounds(10) = 8.
    assert.equal(maxRounds(10), 8);
    assert.equal(validateRoundsPlannedEdit(tournament(), 8, 10).ok, true);
    const blocked = validateRoundsPlannedEdit(tournament(), 9, 10);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.errors.some((e) => e.includes("Toutes rondes")));
  });

  test("signale l'avertissement sous le recommande sans bloquer", () => {
    // 16 joueurs : recommande ceil(log2(16)) = 4.
    const result = validateRoundsPlannedEdit(tournament(), 2, 16);
    assert.equal(result.ok, true);
    assert.equal(result.warning, 4);
  });

  test("refuse un entier invalide", () => {
    for (const value of [0, -1, 2.5, NaN, undefined]) {
      assert.equal(validateRoundsPlannedEdit(tournament(), value, 10).ok, false);
    }
  });

  test("refuse d'emblee si l'edition elle-meme est interdite", () => {
    const launched = validateRoundsPlannedEdit(tournament({ status: "ongoing" }), 4, 10);
    assert.equal(launched.ok, false);
    assert.match(launched.errors[0], /lancé/);
  });
});

describe("validateResultEdit", () => {
  const game = { id: "p1", white: "a", black: "b", result: "1-0" };

  test("accepte un autre resultat valide", () => {
    for (const result of ["0-1", "1/2-1/2"]) {
      assert.equal(validateResultEdit(game, result).ok, true, result);
    }
  });

  test("refuse un resultat identique a celui deja enregistre", () => {
    assert.equal(validateResultEdit(game, "1-0").ok, false);
  });

  test("refuse un resultat hors domaine, dont 'bye'", () => {
    for (const result of ["bye", "2-0", "", null, undefined]) {
      assert.equal(validateResultEdit(game, result).ok, false, String(result));
    }
  });

  test("refuse de corriger un exempt", () => {
    const bye = { id: "p2", white: "a", black: null, result: "bye" };
    const result = validateResultEdit(bye, "1-0");
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /exempt/);
  });

  test("refuse une partie sans resultat : il n'y a rien a corriger", () => {
    const unplayed = { id: "p3", white: "a", black: "b", result: null };
    const result = validateResultEdit(unplayed, "1-0");
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /pas encore/);
  });

  test("refuse un appariement inexistant", () => {
    assert.equal(validateResultEdit(null, "1-0").ok, false);
  });

  test("GAME_RESULTS couvre les trois issues, sans le bye", () => {
    assert.deepEqual(GAME_RESULTS, ["1-0", "0-1", "1/2-1/2"]);
    assert.ok(!GAME_RESULTS.includes("bye"));
    for (const key of GAME_RESULTS) {
      assert.ok(RESULT_LABELS[key], `libelle manquant pour ${key}`);
    }
  });
});

describe("les regles tiennent aussi cote serveur", () => {
  // Les memes interdictions doivent figurer dans les triggers : sans elles,
  // ces regles ne seraient que du confort d'interface, ce que CLAUDE.md
  // refuse comme protection. Ce test lit la migration pour que la derive se
  // voie ici plutot qu'en production.
  const migration = readFileSync(
    new URL("../supabase/migrations/20260730120000_tournament_edit_rules.sql", import.meta.url),
    "utf8"
  );

  test("le nombre de rondes est gele des qu'une ronde existe", () => {
    // La regle porte sur la realite (des rondes existent), pas seulement sur
    // le statut, qui peut etre remis a 'draft' par le proprietaire.
    assert.match(migration, /rounds_planned is distinct from old\.rounds_planned/);
    assert.match(migration, /from public\.rounds r where r\.tournament_id = old\.id/);
    assert.match(migration, /old\.status <> 'draft'/);
  });

  test("le nombre de rondes est gele sur les formats en cercle", () => {
    assert.match(migration, /old\.format in \('round_robin', 'double_round_robin'\)/);
  });

  test("un appariement est protege en liste blanche, pas colonne par colonne", () => {
    // La liste noire laissait passer toute colonne ajoutee plus tard. La
    // forme retenue reconstruit la ligne attendue a partir de OLD et ne
    // laisse passer que `result`.
    assert.match(migration, /expected := old;/);
    assert.match(migration, /expected\.result := new\.result;/);
    assert.match(migration, /new is distinct from expected/);
  });

  test("les refus portent un SQLSTATE applicatif, pas une erreur Postgres brute", () => {
    // src/data.js ne remonte le message a l'utilisateur que pour ce code :
    // toute autre erreur reste generique, pour ne pas exposer de noms de
    // relations ou de contraintes.
    const raises = [...migration.matchAll(/raise exception/g)].length;
    const codes = [...migration.matchAll(/errcode = 'ISC01'/g)].length;
    assert.equal(raises, codes, "chaque refus doit porter le SQLSTATE ISC01");
    assert.ok(raises >= 4);
  });

  test("les fonctions trigger epinglent leur search_path", () => {
    const functions = [...migration.matchAll(/language plpgsql\s+set search_path = ''/g)];
    assert.equal(functions.length, 2, "les deux fonctions doivent epingler search_path");
  });

  test("les deux triggers sont bien poses", () => {
    // `create or replace` pour que rejouer la migration reste sans effet.
    assert.match(migration, /create or replace trigger tournaments_enforce_edit_rules\s+before update on public\.tournaments/);
    assert.match(migration, /create or replace trigger pairings_enforce_edit_rules\s+before update on public\.pairings/);
  });
});
