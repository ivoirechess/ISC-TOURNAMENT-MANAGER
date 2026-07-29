import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeError } from "../src/data.js";

describe("describeError", () => {
  test("laisse passer nos propres refus, deja ecrits pour etre lus", () => {
    const message = describeError(
      { code: "ISC01", message: "Un exempt ne peut pas etre efface." },
      "Peu importe."
    );
    assert.equal(message, "Un exempt ne peut pas etre efface.");
  });

  test("expose toujours le code et le message Postgres reels", () => {
    // C'est le point de la correction : « droits insuffisants ? » ne
    // permettait aucun diagnostic et ne laissait rien a rapporter.
    const message = describeError(
      {
        code: "42501",
        message: 'new row violates row-level security policy for table "tournaments"',
      },
      "La creation du tournoi a echoue."
    );
    assert.ok(message.includes("42501"), "le code doit apparaitre");
    assert.ok(
      message.includes('new row violates row-level security policy for table "tournaments"'),
      "le message du serveur doit apparaitre"
    );
    assert.ok(message.startsWith("La creation du tournoi a echoue."));
  });

  test("un refus RLS nomme les causes habituelles", () => {
    // PostgreSQL ne dira jamais quel predicat a echoue : nommer les
    // suspects est le maximum honnete.
    const message = describeError({ code: "42501", message: "..." }, "Echec.");
    assert.match(message, /profiles/);
    assert.match(message, /appartient pas/);
  });

  test("les autres codes courants recoivent une explication", () => {
    assert.match(describeError({ code: "23505", message: "x" }, "Echec."), /unique/);
    assert.match(describeError({ code: "23502", message: "x" }, "Echec."), /obligatoire/);
    assert.match(describeError({ code: "23514", message: "x" }, "Echec."), /validit/);
  });

  test("un code inconnu passe quand meme le detail", () => {
    const message = describeError({ code: "08006", message: "connection failure" }, "Echec.");
    assert.equal(message, "Echec. [08006 - connection failure]");
  });

  test("sans erreur, le message de repli suffit", () => {
    assert.equal(describeError(null, "Echec."), "Echec.");
    assert.equal(describeError(undefined, "Echec."), "Echec.");
  });

  test("une erreur sans code ni message ne casse rien", () => {
    assert.equal(describeError({}, "Echec."), "Echec.");
  });
});

describe("plus aucun message d'ecriture n'est opaque", () => {
  const data = readFileSync(new URL("../src/data.js", import.meta.url), "utf8");

  test("le message « droits insuffisants » n'est plus leve", () => {
    // Il subsiste dans le commentaire qui explique son retrait ; ce qui
    // compte est qu'aucun throw ne le porte plus.
    assert.ok(
      !/throw new Error\([^)]*droits insuffisants/.test(data),
      "ce message ne permettait aucun diagnostic"
    );
  });

  test("les echecs des tables et RPC passent tous par describeError", () => {
    // Chaque `if (error)` d'un appel PostgREST doit remonter le detail du
    // serveur, sinon la prochaine regression sera de nouveau muette.
    //
    // L'authentification est exclue a dessein : signIn rend volontairement
    // le meme message quelle que soit la cause, pour ne pas reveler quels
    // comptes existent. Y remonter l'erreur du serveur serait une
    // regression de securite, pas une amelioration.
    const authSection = data.slice(
      data.indexOf("// Authentication"),
      data.indexOf("// Players directory")
    );
    const opaque = [];
    const lines = data.split("\n");
    lines.forEach((line, index) => {
      if (!/^\s*if \(error\) \{/.test(line)) return;
      const body = lines.slice(index + 1, index + 4).join(" ");
      if (authSection.includes(lines[index + 1])) return;
      if (body.includes("throw") && !body.includes("describeError") &&
          !body.includes("editErrorMessage")) {
        opaque.push(`ligne ${index + 1} : ${body.trim().slice(0, 70)}`);
      }
    });
    assert.deepEqual(opaque, [], `messages opaques restants :\n${opaque.join("\n")}`);
  });

  test("signIn reste volontairement muet sur la cause", () => {
    const authSection = data.slice(
      data.indexOf("export async function signIn"),
      data.indexOf("export async function signOut")
    );
    assert.ok(!authSection.includes("describeError"));
    assert.match(authSection, /identifiants invalides/);
  });
});

describe("la politique INSERT n'a pas ete supprimee, seulement resserree", () => {
  const initial = readFileSync(
    new URL("../supabase/migrations/20260728120000_initial_schema.sql", import.meta.url),
    "utf8"
  );
  const guard = readFileSync(
    new URL("../supabase/migrations/20260801120000_tournament_insert_guard.sql", import.meta.url),
    "utf8"
  );
  const tiebreaks = readFileSync(
    new URL("../supabase/migrations/20260729120000_tournament_tiebreaks.sql", import.meta.url),
    "utf8"
  );
  const softDelete = readFileSync(
    new URL("../supabase/migrations/20260731120000_tournament_soft_delete.sql", import.meta.url),
    "utf8"
  );

  test("ni les departages ni la suppression n'ont touche a une politique INSERT", () => {
    // Diagnostic de la regression signalee : la piste « une migration a
    // remplace une politique INSERT » ne tient pas, et ce test la ferme.
    for (const [name, migration] of [["departages", tiebreaks], ["suppression", softDelete]]) {
      const drops = [...migration.matchAll(/drop policy "([^"]+)"/g)].map((m) => m[1]);
      for (const dropped of drops) {
        assert.ok(
          !/insert|create/i.test(dropped),
          `la migration ${name} supprime la politique « ${dropped} », qui semble concerner l'INSERT`
        );
      }
    }
  });

  test("les deux politiques INSERT d'origine existent toujours", () => {
    assert.match(initial, /create policy "admins create their own tournaments"/);
    assert.match(initial, /create policy "owner or super_admin inserts tournament_players"/);
  });

  test("la correction n'ajoute qu'une condition, sans changer le controle de role", () => {
    assert.match(guard, /deleted_at is null/);
    assert.match(guard, /public\.is_super_admin\(\)/);
    assert.match(guard, /public\.is_admin\(\) and created_by = auth\.uid\(\)/);
  });
});
