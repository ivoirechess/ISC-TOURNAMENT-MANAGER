import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTIONS,
  ACTION_LABELS,
  MIN_PLAYERS_TO_START,
  STATES,
  STATE_LABELS,
  availableActions,
  canEditEntries,
  canManageTournament,
  cancelConfirmationMessage,
  isFrozen,
  isPubliclyVisible,
  lifecycleState,
  stateLabel,
  startBlockedReason,
  viewActions,
} from "../src/tournament-lifecycle.js";
import { pairRound } from "../src/swiss.js";

const draft = { name: "Open", status: "draft", published_at: null };
const upcoming = { name: "Open", status: "draft", published_at: "2026-07-01T10:00:00Z" };
const ongoing = { name: "Open", status: "ongoing", published_at: "2026-07-01T10:00:00Z",
                  started_at: "2026-07-02T09:00:00Z" };
const finished = { name: "Open", status: "archived", published_at: "2026-07-01T10:00:00Z",
                   started_at: "2026-07-02T09:00:00Z", finished_at: "2026-07-03T18:00:00Z" };
const cancelled = { ...upcoming, cancelled_at: "2026-07-02T08:00:00Z" };

describe("lifecycleState", () => {
  test("les cinq etats du cahier des charges", () => {
    assert.equal(lifecycleState(draft), "draft");
    assert.equal(lifecycleState(upcoming), "upcoming");
    assert.equal(lifecycleState(ongoing), "ongoing");
    assert.equal(lifecycleState(finished), "finished");
    assert.equal(lifecycleState(cancelled), "cancelled");
  });

  test("l'annulation prime sur tout le reste", () => {
    // Un tournoi annule en pleine course est annule, pas en cours.
    assert.equal(lifecycleState({ ...ongoing, cancelled_at: "x" }), "cancelled");
    assert.equal(lifecycleState({ ...finished, cancelled_at: "x" }), "cancelled");
  });

  test("c'est la publication qui distingue brouillon et a venir", () => {
    assert.equal(lifecycleState({ status: "draft", published_at: null }), "draft");
    assert.equal(lifecycleState({ status: "draft", published_at: "x" }), "upcoming");
  });

  test("sans tournoi, aucun etat", () => {
    assert.equal(lifecycleState(null), null);
    assert.equal(stateLabel(null), "");
  });

  test("chaque etat a un libelle francais", () => {
    assert.deepEqual(Object.keys(STATE_LABELS).sort(), [...STATES].sort());
    assert.equal(stateLabel(upcoming), "À venir");
    assert.equal(stateLabel(cancelled), "Annulé");
  });
});

describe("isPubliclyVisible", () => {
  test("un brouillon non publie n'est jamais public", () => {
    assert.equal(isPubliclyVisible(draft), false);
  });

  test("publie, en cours, termine : public", () => {
    for (const t of [upcoming, ongoing, finished]) {
      assert.equal(isPubliclyVisible(t), true);
    }
  });

  test("annule apres publication : la page reste ; sinon non", () => {
    assert.equal(isPubliclyVisible(cancelled), true);
    assert.equal(isPubliclyVisible({ status: "draft", published_at: null, cancelled_at: "x" }), false);
  });

  test("supprime : plus rien", () => {
    assert.equal(isPubliclyVisible({ ...ongoing, deleted_at: "x" }), false);
  });
});

describe("gel et inscriptions", () => {
  test("termine et annule sont geles ; les autres non", () => {
    assert.equal(isFrozen(finished), true);
    assert.equal(isFrozen(cancelled), true);
    for (const t of [draft, upcoming, ongoing]) assert.equal(isFrozen(t), false);
  });

  test("les inscriptions restent modifiables avant le demarrage seulement", () => {
    assert.equal(canEditEntries(draft), true);
    assert.equal(canEditEntries(upcoming), true);
    for (const t of [ongoing, finished, cancelled]) assert.equal(canEditEntries(t), false);
  });
});

describe("availableActions", () => {
  test("brouillon : enregistrer, previsualiser, publier, supprimer", () => {
    assert.deepEqual(availableActions(draft), ["save", "preview", "publish", "delete"]);
  });

  test("a venir : depublier, demarrer, annuler", () => {
    assert.deepEqual(availableActions(upcoming), ["unpublish", "start", "cancel"]);
  });

  test("en cours : cloturer et annuler, jamais depublier", () => {
    assert.deepEqual(availableActions(ongoing), ["finish", "cancel"]);
    assert.ok(!availableActions(ongoing).includes("unpublish"));
  });

  test("termine et annule : plus aucune action", () => {
    assert.deepEqual(availableActions(finished), []);
    assert.deepEqual(availableActions(cancelled), []);
  });

  test("chaque action a un libelle", () => {
    for (const state of STATES) {
      for (const action of ACTIONS[state]) {
        assert.ok(ACTION_LABELS[action], `libelle manquant pour ${action}`);
      }
    }
  });
});

describe("viewActions", () => {
  test("la vue tournoi propose publier et supprimer sur un brouillon", () => {
    // « Enregistrer » et « Previsualiser » appartiennent a l'ecran de
    // modification : c'est la que sont les champs qu'ils enregistrent.
    assert.deepEqual(viewActions(draft), ["publish", "delete"]);
  });

  test("a venir : depublier, demarrer, annuler", () => {
    assert.deepEqual(viewActions(upcoming), ["unpublish", "start", "cancel"]);
  });

  test("en cours : annuler seulement, la cloture ayant deja son bouton", () => {
    assert.deepEqual(viewActions(ongoing), ["cancel"]);
  });

  test("termine et annule : rien", () => {
    assert.deepEqual(viewActions(finished), []);
    assert.deepEqual(viewActions(cancelled), []);
  });

  test("la vue n'ajoute jamais une action que l'etat n'autorise pas", () => {
    const byState = { draft, upcoming, ongoing, finished, cancelled };
    for (const state of STATES) {
      for (const action of viewActions(byState[state])) {
        assert.ok(ACTIONS[state].includes(action), `${action} n'est pas permis en ${state}`);
      }
    }
  });
});

describe("canManageTournament", () => {
  const owned = { ...draft, created_by: "u1" };

  test("le proprietaire administre son tournoi", () => {
    assert.equal(canManageTournament(owned, "admin", "u1"), true);
  });

  test("un autre organisateur, non", () => {
    assert.equal(canManageTournament(owned, "admin", "u2"), false);
  });

  test("un super-admin administre tout", () => {
    assert.equal(canManageTournament(owned, "super_admin", "u2"), true);
  });

  test("un visiteur, non", () => {
    assert.equal(canManageTournament(owned, null, null), false);
    assert.equal(canManageTournament(owned, "viewer", "u1"), false);
  });

  test("sans identifiant de session, un admin n'administre rien", () => {
    // Sinon un created_by absent des deux cotes se comparerait a lui-meme.
    assert.equal(canManageTournament({ ...draft, created_by: null }, "admin", null), false);
  });

  test("un tournoi supprime n'a plus d'actions, pour personne", () => {
    const deleted = { ...owned, deleted_at: "2026-07-05T10:00:00Z" };
    assert.equal(canManageTournament(deleted, "admin", "u1"), false);
    assert.equal(canManageTournament(deleted, "super_admin", "u2"), false);
  });
});

describe("startBlockedReason", () => {
  test("un tournoi a venir avec assez de joueurs peut demarrer", () => {
    assert.equal(startBlockedReason(upcoming, 2), null);
  });

  test("moins de deux joueurs actifs : refuse", () => {
    assert.equal(MIN_PLAYERS_TO_START, 2);
    for (const count of [0, 1, null, 1.5]) {
      assert.match(startBlockedReason(upcoming, count), /au moins 2 joueurs/);
    }
  });

  test("deja demarre, termine, annule : refuse", () => {
    assert.match(startBlockedReason(ongoing, 8), /déjà démarré/);
    assert.match(startBlockedReason(finished, 8), /déjà démarré/);
    assert.match(startBlockedReason(cancelled, 8), /annulé/);
  });
});

describe("cancelConfirmationMessage", () => {
  test("nomme le tournoi et annonce le gel", () => {
    const message = cancelConfirmationMessage({ name: "Open de Cocody" });
    assert.ok(message.includes("Open de Cocody"));
    assert.match(message, /gelé/);
    assert.match(message, /page/);
  });
});

// ---------------------------------------------------------------------------
// Contrôle croisé : la ronde 1 est tirée en SQL par start_tournament, pas par
// le moteur, parce qu'elle doit tomber dans la même transaction. Ces deux
// tests fixent la forme que le moteur produit ; supabase/tests/rls_checks.sql
// fixe la même forme côté SQL. Si l'un des deux bouge, l'autre le dit.
// ---------------------------------------------------------------------------
describe("ronde 1 : forme partagee entre le moteur et start_tournament", () => {
  const players = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `J${i + 1}` }));

  test("effectif pair : appariements deux a deux dans l'ordre des identifiants", () => {
    const { pairings } = pairRound({ players: players(4), rounds: [] });
    assert.deepEqual(
      pairings.map((p) => [p.white, p.black]),
      [["p1", "p2"], ["p3", "p4"]]
    );
  });

  test("effectif impair : le dernier de l'ordre est exempt", () => {
    const { pairings } = pairRound({ players: players(5), rounds: [] });
    const bye = pairings.find((p) => p.black === null);
    assert.equal(bye.white, "p5");
    assert.equal(bye.result, "bye");
    assert.deepEqual(
      pairings.filter((p) => p.black !== null).map((p) => [p.white, p.black]),
      [["p1", "p2"], ["p3", "p4"]]
    );
  });

  test("le SQL suit la meme regle", () => {
    // Lecture de la migration : l'ordre de tirage et le sort du siege impair
    // doivent y etre ecrits noir sur blanc.
    const migration = readFileSync(
      new URL("../supabase/migrations/20260803120000_tournament_lifecycle.sql", import.meta.url),
      "utf8"
    );
    const fn = migration.slice(migration.indexOf("create or replace function public.start_tournament"));
    // Ancre de fin de ligne : « order by tp.player_id desc » inverserait le
    // tirage sans que la verification s'en apercoive.
    assert.match(fn, /order by tp\.player_id\n/);
    assert.match(fn, /values \(new_round, pending, seat\.player_id, null, board_no\)/);
    assert.match(fn, /values \(new_round, pending, null, 'bye', board_no\)/);
  });
});

describe("la migration du cycle de vie", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260803120000_tournament_lifecycle.sql", import.meta.url),
    "utf8"
  );

  test("ajoute toutes les colonnes demandees", () => {
    for (const column of [
      "slug", "description", "starts_at", "ends_at", "timezone", "venue_name",
      "venue_address", "city", "organizer_name", "public_contact_email",
      "registration_url", "poster_url", "rating_type", "published_at",
      "started_at", "finished_at", "cancelled_at", "cancellation_reason",
      "updated_at", "last_activity_at",
    ]) {
      assert.ok(
        new RegExp(`add column ${column}\\b`).test(migration),
        `colonne ${column} absente de la migration`
      );
    }
  });

  test("le fuseau par defaut est Africa/Abidjan", () => {
    assert.match(migration, /add column timezone text not null default 'Africa\/Abidjan'/);
  });

  test("slug unique parmi les tournois non supprimes, et dates ordonnees", () => {
    assert.match(migration, /create unique index tournaments_slug_unique\s+on public\.tournaments \(slug\)\s+where deleted_at is null;/);
    assert.match(migration, /check \(ends_at is null or starts_at is null or ends_at >= starts_at\)/);
  });

  test("les index demandes existent", () => {
    for (const index of [
      "tournaments_status_idx", "tournaments_published_idx",
      "tournaments_starts_at_idx", "tournaments_last_activity_idx",
      "tournaments_slug_unique",
    ]) {
      assert.ok(migration.includes(index), `index ${index} absent`);
    }
  });

  test("un trigger tient updated_at a jour", () => {
    assert.match(migration, /create or replace trigger tournaments_touch_updated_at\s+before update on public\.tournaments/);
  });

  test("le backfill ne rend aucun brouillon public", () => {
    // published_at n'est retro-rempli que pour ce qui etait deja visible.
    assert.match(migration, /set published_at = created_at\s+where published_at is null\s+and status in \('ongoing', 'archived'\)/);
    assert.ok(!/set published_at = created_at[\s\S]{0,80}status = 'draft'/.test(migration));
  });

  test("les cinq transitions sont des fonctions verrouillees", () => {
    for (const fn of [
      "publish_tournament", "unpublish_tournament", "start_tournament",
      "finish_tournament", "cancel_tournament",
    ]) {
      const body = migration.slice(migration.indexOf(`create or replace function public.${fn}`));
      assert.match(body.slice(0, 400), /security definer/, `${fn} doit etre SECURITY DEFINER`);
      assert.match(body.slice(0, 400), /set search_path = ''/, `${fn} doit epingler search_path`);
      assert.ok(migration.includes(`revoke execute on function %s from anon`) ||
                migration.includes("'public." + fn), `${fn} doit voir ses droits restreints`);
    }
  });

  test("demarrer verrouille la ligne pour departager deux onglets", () => {
    assert.match(migration, /for update/);
    const start = migration.slice(migration.indexOf("create or replace function public.start_tournament"));
    assert.match(start.slice(0, 1200), /assert_tournament_writable/);
    assert.match(start.slice(0, 2000), /Ce tournoi a deja demarre/);
    assert.match(start.slice(0, 2000), /au moins deux joueurs actifs/);
  });

  test("la politique de lecture n'interroge jamais sa propre table", () => {
    // Une politique qui relit sa table ne peut pas etre satisfaite par un
    // INSERT ... RETURNING — la ligne n'y est pas encore — et la creation
    // echoue en 42501 opaque. Le test du proprietaire porte donc sur les
    // colonnes de la ligne elle-meme.
    const policy = migration.slice(
      migration.indexOf('create policy "tournaments are readable once public"'),
      migration.indexOf("-- Life-cycle transitions")
    );
    // On retire les commentaires avant de chercher l'appel : le commentaire
    // qui explique le choix cite forcement la fonction ecartee.
    const expression = policy.replace(/^\s*--.*$/gm, "");
    assert.ok(
      !expression.includes("can_write_tournament"),
      "la politique SELECT ne doit pas appeler can_write_tournament"
    );
    assert.match(policy, /public\.is_admin\(\) and created_by = auth\.uid\(\)/);
  });

  test("depublier un annule est refuse cote serveur", () => {
    const fn = migration.slice(
      migration.indexOf("create or replace function public.unpublish_tournament"),
      migration.indexOf("create or replace function public.start_tournament")
    );
    assert.match(fn, /row_data\.cancelled_at is not null/);
  });

  test("demarrer verifie qu'aucune ronde n'existe deja", () => {
    const fn = migration.slice(migration.indexOf("create or replace function public.start_tournament"));
    assert.match(fn.slice(0, 2500), /exists \(select 1 from public\.rounds r where r\.tournament_id = t_id\)/);
  });

  test("un brouillon non publie n'est jamais lisible publiquement", () => {
    const policy = migration.slice(migration.indexOf('create policy "tournaments are readable once public"'));
    assert.match(policy.slice(0, 400), /published_at is not null/);
    assert.match(policy.slice(0, 400), /status in \('ongoing', 'archived'\)/);
    assert.match(policy.slice(0, 400), /deleted_at is null/);
  });

  test("archive et annule sont geles en ecriture", () => {
    const fn = migration.slice(migration.indexOf("create or replace function public.can_write_tournament"));
    assert.match(fn.slice(0, 700), /t\.status <> 'archived'/);
    assert.match(fn.slice(0, 700), /t\.cancelled_at is null/);
    assert.match(fn.slice(0, 700), /t\.deleted_at is null/);
  });
});
