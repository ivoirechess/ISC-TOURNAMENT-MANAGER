import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canClearResult,
  deleteConfirmationMessage,
  confirmsPurge,
} from "../src/tournament-delete.js";

function tournament(overrides = {}) {
  return { id: "t1", name: "Open de Cocody", status: "ongoing", ...overrides };
}

const game = { id: "p1", white: "a", black: "b", result: "1-0" };

describe("canClearResult", () => {
  test("autorise sur un tournoi en cours, partie jouee", () => {
    assert.equal(canClearResult(tournament(), game).ok, true);
  });

  test("refuse hors d'un tournoi en cours", () => {
    for (const status of ["draft", "archived"]) {
      const result = canClearResult(tournament({ status }), game);
      assert.equal(result.ok, false, `statut ${status}`);
      assert.match(result.reason, /en cours/);
    }
  });

  test("refuse d'effacer un exempt", () => {
    const bye = { id: "p2", white: "a", black: null, result: "bye" };
    const result = canClearResult(tournament(), bye);
    assert.equal(result.ok, false);
    assert.match(result.reason, /exempt/);
  });

  test("refuse une partie sans resultat", () => {
    const unplayed = { id: "p3", white: "a", black: "b", result: null };
    assert.equal(canClearResult(tournament(), unplayed).ok, false);
  });

  test("refuse sur des entrees manquantes", () => {
    assert.equal(canClearResult(null, game).ok, false);
    assert.equal(canClearResult(tournament(), null).ok, false);
  });
});

describe("deleteConfirmationMessage", () => {
  test("nomme le tournoi, ce n'est pas un « etes-vous sur ? » generique", () => {
    const message = deleteConfirmationMessage(tournament());
    assert.ok(message.includes("Open de Cocody"), "le nom doit apparaitre");
    assert.ok(!/^Êtes-vous sûr/.test(message));
  });

  test("annonce que seul un super-admin pourra restaurer", () => {
    assert.match(deleteConfirmationMessage(tournament()), /super-admin/);
  });
});

describe("confirmsPurge", () => {
  test("accepte le nom exact", () => {
    assert.equal(confirmsPurge(tournament(), "Open de Cocody"), true);
  });

  test("tolere espaces et casse, rien de plus", () => {
    assert.equal(confirmsPurge(tournament(), "  open DE cocody "), true);
    assert.equal(confirmsPurge(tournament(), "Open de Cocod"), false);
    assert.equal(confirmsPurge(tournament(), "Open de Cocody 2"), false);
    assert.equal(confirmsPurge(tournament(), "autre chose"), false);
  });

  test("une saisie vide ne confirme jamais", () => {
    assert.equal(confirmsPurge(tournament(), ""), false);
    assert.equal(confirmsPurge(tournament(), "   "), false);
    // Meme pour un tournoi au nom vide, qui ne devrait pas exister.
    assert.equal(confirmsPurge(tournament({ name: "" }), ""), false);
  });

  test("refuse les entrees non textuelles", () => {
    assert.equal(confirmsPurge(tournament(), null), false);
    assert.equal(confirmsPurge(tournament(), undefined), false);
    assert.equal(confirmsPurge(null, "Open de Cocody"), false);
  });
});

describe("les regles de suppression tiennent cote serveur", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260731120000_tournament_soft_delete.sql", import.meta.url),
    "utf8"
  );

  test("un tournoi supprime devient invisible, sauf pour un super_admin", () => {
    assert.match(migration, /using \(deleted_at is null or public\.is_super_admin\(\)\)/);
  });

  test("les tables filles suivent la visibilite de leur tournoi", () => {
    // Sans cela, rondes et appariements d'un tournoi supprime resteraient
    // lisibles et le tournoi serait reconstituable.
    for (const table of ["tournament_players", "rounds"]) {
      assert.ok(
        migration.includes(`drop policy "${table} are readable by everyone" on public.${table};`),
        `l'ancienne politique de ${table} doit etre remplacee`
      );
    }
    assert.match(migration, /drop policy "pairings are readable by everyone" on public\.pairings;/);
    assert.match(migration, /exists \(select 1 from public\.tournaments t where t\.id = tournament_id\)/);
    assert.match(migration, /exists \(select 1 from public\.rounds r where r\.id = round_id\)/);
  });

  test("aucun DELETE reel pour un admin : seul un super_admin detruit", () => {
    assert.match(migration, /drop policy "owner or super_admin deletes tournaments" on public\.tournaments;/);
    const deletePolicy = migration.slice(
      migration.indexOf('create policy "only super_admin deletes tournaments for good"')
    );
    assert.match(deletePolicy.slice(0, 200), /for delete\s+to authenticated\s+using \(public\.is_super_admin\(\)\)/);
  });

  test("un tournoi supprime est gele : plus aucune ecriture dessus", () => {
    assert.match(migration, /and t\.deleted_at is null/);
  });

  test("effacer un resultat exige un tournoi en cours", () => {
    assert.match(migration, /if new\.result is null and old\.result is not null then/);
    assert.match(migration, /parent_status is distinct from 'ongoing'/);
  });

  test("les refus portent le SQLSTATE applicatif", () => {
    const raises = [...migration.matchAll(/raise exception/g)].length;
    const codes = [...migration.matchAll(/errcode = 'ISC01'/g)].length;
    assert.equal(raises, codes);
  });

  test("la fonction de marquage n'est pas ouverte a l'anonyme", () => {
    assert.match(migration, /revoke execute on function public\.soft_delete_tournament\(uuid\) from public;/);
    assert.match(migration, /grant execute on function public\.soft_delete_tournament\(uuid\) to authenticated;/);
  });

  test("elle refait elle-meme le controle de propriete", () => {
    // Elle est SECURITY DEFINER : sans ce controle, tout authentifie pourrait
    // supprimer n'importe quel tournoi.
    const fn = migration.slice(
      migration.indexOf("create or replace function public.soft_delete_tournament"),
      migration.indexOf("revoke execute on function")
    );
    assert.match(fn, /security definer/);
    assert.match(fn, /set search_path = ''/);
    assert.match(fn, /public\.is_super_admin\(\)/);
    assert.match(fn, /t\.created_by = auth\.uid\(\)/);
    assert.match(fn, /raise exception 'Vous n''avez pas le droit de supprimer ce tournoi\.'/);
  });
});

describe("les lectures filtrent les tournois supprimes", () => {
  // Le RLS masque deja ces lignes pour tout le monde sauf le super_admin :
  // sans ce filtre explicite, un super_admin verrait les tournois supprimes
  // reapparaitre dans l'annuaire public, la vue tournoi et le classement.
  const data = readFileSync(new URL("../src/data.js", import.meta.url), "utf8");

  for (const fn of ["listTournaments", "getTournament", "getTournamentResults"]) {
    test(`${fn} filtre sur deleted_at is null`, () => {
      const start = data.indexOf(`export async function ${fn}(`);
      assert.notEqual(start, -1, `${fn} introuvable`);
      const body = data.slice(start, data.indexOf("\n}", start));
      assert.ok(
        body.includes('.is("deleted_at", null)'),
        `${fn} doit filtrer les tournois supprimes`
      );
    });
  }

  test("la corbeille, elle, ne lit que les tournois supprimes", () => {
    const start = data.indexOf("export async function listDeletedTournaments(");
    const body = data.slice(start, data.indexOf("\n}", start));
    assert.ok(body.includes('.not("deleted_at", "is", null)'));
  });
});
