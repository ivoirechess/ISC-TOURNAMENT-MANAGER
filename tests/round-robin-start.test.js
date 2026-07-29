// Starting a round-robin tournament, whose calendar exists before it starts.
//
// The bug this covers: `start_tournament` refused any tournament that
// already had rounds. That is the right guard for the Swiss, whose round 1
// the function draws itself, and exactly the wrong one for the circle
// formats, whose whole schedule is written at creation. They could never
// leave 'draft', and since entry only opens on a running tournament, their
// boards stayed unreachable.
//
// Two sides are checked here: the entry rule (pure), and the guards written
// in the migration. What the database actually does with a complete calendar
// is checked against a real PostgreSQL in supabase/tests/rls_checks.sql —
// reading SQL is not the same as watching it accept or refuse.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canEnterResults, nextRoundAction } from "../src/round-entry.js";
import { generateSchedule, scheduleLength } from "../src/roundrobin.js";
import { startBlockedReason } from "../src/tournament-lifecycle.js";

const players = ["p1", "p2", "p3", "p4"];

/**
 * A round-robin exactly as creation leaves it: still a draft, with every
 * round of its calendar already recorded.
 */
function preparedRoundRobin(overrides = {}) {
  const schedule = generateSchedule(players, { doubled: false });
  return {
    tournament: {
      id: "t-rr",
      name: "Toutes rondes",
      format: "round_robin",
      rounds_planned: schedule.length,
      status: "draft",
      published_at: "2026-07-01T10:00:00Z",
      ...overrides,
    },
    rounds: schedule.map((pairings, index) => ({
      number: index + 1,
      pairings: pairings.map((pairing, board) => ({
        id: `r${index + 1}-b${board + 1}`,
        board: board + 1,
        white: pairing.white,
        black: pairing.black,
        result: pairing.result,
      })),
    })),
  };
}

describe("un toutes-rondes prepare mais pas demarre", () => {
  test("son calendrier complet est deja en base", () => {
    const { tournament, rounds } = preparedRoundRobin();
    assert.equal(rounds.length, scheduleLength(players.length, { doubled: false }));
    assert.equal(rounds.length, tournament.rounds_planned);
    assert.ok(rounds.every((round) => round.pairings.length > 0));
  });

  test("la saisie reste fermee tant qu'il est en brouillon", () => {
    // Le point du bug : c'est le statut qui ouvre la saisie, jamais la
    // presence de rondes. Sinon un calendrier prepare a l'avance serait
    // saisissable avant le demarrage officiel.
    const { tournament } = preparedRoundRobin();
    const allowed = canEnterResults(tournament);
    assert.equal(allowed.ok, false);
    assert.match(allowed.reason, /pas encore démarré/);
  });

  test("rien ne lui est propose non plus dans la vue des rondes", () => {
    const { tournament, rounds } = preparedRoundRobin();
    assert.equal(nextRoundAction(tournament, rounds), null);
  });

  test("son calendrier ne l'empeche pas de demarrer", () => {
    // startBlockedReason est le miroir cote interface de start_tournament :
    // il ne doit pas refuser ce que la base accepte maintenant.
    const { tournament } = preparedRoundRobin();
    assert.equal(startBlockedReason(tournament, players.length), null);
  });

  test("une fois demarre, la saisie s'ouvre sur le meme calendrier", () => {
    const { tournament, rounds } = preparedRoundRobin({ status: "ongoing" });
    assert.equal(canEnterResults(tournament).ok, true);
    // Et le moteur n'a rien a tirer : les rondes suivantes sont deja la.
    assert.equal(nextRoundAction(tournament, rounds.slice(0, 1)), null);
  });

  test("annule ou cloture, elle se referme", () => {
    for (const overrides of [
      { status: "ongoing", cancelled_at: "2026-07-02T08:00:00Z" },
      { status: "archived" },
    ]) {
      assert.equal(canEnterResults(preparedRoundRobin(overrides).tournament).ok, false);
    }
  });

  test("la saisie s'ouvre sur « ongoing » et sur rien d'autre", () => {
    // Liste blanche : un statut ajoute plus tard reste ferme par defaut,
    // plutot que de passer au travers.
    const { tournament } = preparedRoundRobin();
    for (const status of ["draft", "archived", "paused", "", null, undefined]) {
      assert.equal(
        canEnterResults({ ...tournament, status }).ok,
        false,
        `le statut ${String(status)} ne doit pas ouvrir la saisie`
      );
    }
    assert.equal(canEnterResults({ ...tournament, status: "ongoing" }).ok, true);
  });
});

describe("la migration corrige la condition de demarrage", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260804120000_round_robin_start.sql", import.meta.url),
    "utf8"
  );
  const start = migration.slice(
    migration.indexOf("create or replace function public.start_tournament")
  );

  test("les formats a calendrier complet sont traites a part", () => {
    assert.match(start, /format in \('round_robin', 'double_round_robin'\)/);
  });

  test("pour eux, le calendrier doit exister en entier", () => {
    // La condition est inversee, pas supprimee : on exige les rondes au lieu
    // de les interdire, et le compte doit tomber juste.
    assert.match(start, /if round_count <> row_data\.rounds_planned/);
    assert.match(start, /calendrier de ce tournoi est incomplet/);
  });

  test("le compte seul ne suffit pas : la numerotation est verifiee", () => {
    // Un organisateur peut ecrire des rondes sur son propre brouillon : un
    // calendrier numerote 1, 2, 9 tomberait juste au compte.
    assert.match(start, /highest_round > row_data\.rounds_planned/);
    assert.match(start, /coalesce\(max\(r\.number\), 0\) into round_count, highest_round/);
  });

  test("le suisse garde son exigence d'absence de rondes", () => {
    assert.match(start, /elsif round_count > 0 then/);
    assert.match(start, /Ce tournoi a deja des rondes/);
  });

  test("le tirage de la ronde 1 reste reserve au suisse", () => {
    const draw = start.slice(start.indexOf("update public.tournaments"));
    assert.match(draw, /if row_data\.format = 'swiss' then/);
    // Et il n'y a qu'un seul insert de ronde dans toute la fonction.
    assert.equal(start.match(/insert into public\.rounds/g).length, 1);
  });

  test("demarrer ecrit bien le statut et la date", () => {
    assert.match(start, /set status = 'ongoing', started_at = moment/);
  });

  test("la fonction reste verrouillee et serialisee", () => {
    // Une reecriture qui perdrait SECURITY DEFINER, le search_path epingle
    // ou le verrou de ligne serait une regression silencieuse.
    assert.match(start.slice(0, 400), /security definer/);
    assert.match(start.slice(0, 400), /set search_path = ''/);
    assert.match(start.slice(0, 1200), /assert_tournament_writable/);
  });
});

describe("la migration ferme la saisie avant le demarrage", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260804120000_round_robin_start.sql", import.meta.url),
    "utf8"
  );
  const trigger = migration.slice(
    migration.indexOf("create or replace function public.enforce_pairing_edit_rules")
  );

  test("un resultat ne se saisit pas sur un brouillon", () => {
    assert.match(trigger, /elsif parent_status = 'draft' then/);
    assert.match(trigger, /ne peut etre saisi qu''une fois le tournoi demarre/);
  });

  test("les deux regles precedentes tiennent toujours", () => {
    // Un appariement ne bouge pas, et un resultat ne s'efface que sur un
    // tournoi en cours : cette migration ajoute une regle, elle n'en
    // remplace aucune.
    assert.match(trigger, /seul le resultat est modifiable/);
    assert.match(trigger, /Un exempt ne peut pas etre efface/);
    assert.match(trigger, /ne peut etre efface que sur un tournoi en cours/);
  });
});
