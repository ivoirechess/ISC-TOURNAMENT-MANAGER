// Guards against the documentation drifting away from the code.
//
// This suite exists because CLAUDE.md had gone stale in both directions at
// once: its roadmap left finished work unchecked, while its architecture
// listed a file (scripts/fide_civ.py) that had never been written. Neither
// showed up anywhere, because nothing was checking.
//
// It also pins the CI gate: the whole point of running the RLS checks before
// a merge is lost the day someone quietly drops the step.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const claudeMd = read("CLAUDE.md");
const workflow = read(".github/workflows/test.yml");
const scripts = JSON.parse(read("package.json")).scripts;

describe("CLAUDE.md decrit le depot reel", () => {
  test("chaque chemin cite dans l'architecture existe", () => {
    // Le bloc d'architecture est une carte : une entree qui ne correspond a
    // rien envoie le lecteur — humain ou agent — chercher un fichier absent.
    const block = claudeMd.slice(
      claudeMd.indexOf("## Architecture"),
      claudeMd.indexOf("### Décisions déjà prises")
    );
    const paths = [...block.matchAll(/^(src\/[\w.*-]+|tests\/|scripts\/|index\.html|supabase\/[\w/]+)/gm)]
      .map((match) => match[1])
      .filter((path) => !path.includes("*"));

    assert.ok(paths.length >= 5, "l'architecture doit lister les chemins du projet");
    const missing = paths.filter((path) => !existsSync(new URL(path, root)));
    assert.deepEqual(missing, [], "chemins cites mais absents du depot");
  });

  test("ce qui n'est pas ecrit est annonce comme tel", () => {
    // scripts/fide_civ.py etait presente comme un fichier du projet alors
    // qu'il n'a jamais existe. S'il arrive un jour, cette phrase doit
    // disparaitre — et ce test le rappellera.
    const promised = "scripts/fide_civ.py";
    if (existsSync(new URL(promised, root))) {
      assert.ok(
        !claudeMd.includes("Pas encore écrit"),
        "fide_civ.py existe : retirer la reserve dans l'architecture"
      );
    } else {
      assert.match(claudeMd, /Pas encore écrit[\s\S]{0,200}fide_civ\.py/);
    }
  });

  test("la feuille de route ne coche que ce qui est la", () => {
    const roadmap = claudeMd.slice(claudeMd.indexOf("## Feuille de route"));
    const done = [...roadmap.matchAll(/^- \[x\] (.+)$/gm)].map((m) => m[1]);
    const todo = [...roadmap.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1]);
    assert.ok(done.length > 0 && todo.length > 0);

    // Les fonctions cochees doivent avoir un fichier a montrer.
    const evidence = {
      "Moteur suisse": "src/swiss.js",
      "Moteur toutes rondes": "src/roundrobin.js",
      "Schéma Supabase": "supabase/migrations",
      "Authentification": "src/ui/auth.js",
      "Interface tournoi": "src/ui/rounds.js",
      "Cycle de vie": "src/tournament-lifecycle.js",
      "Suppression douce": "src/ui/trash.js",
      "Temps réel": "src/ui/standings.js",
      "Intégration continue": ".github/workflows/test.yml",
    };
    for (const [label, path] of Object.entries(evidence)) {
      assert.ok(
        done.some((line) => line.startsWith(label)),
        `« ${label} » devrait etre coche : ${path} existe`
      );
      assert.ok(existsSync(new URL(path, root)), `${path} manquant`);
    }
  });

  test("l'annuaire des joueurs et l'import FIDE restent a faire", () => {
    // Le jour ou l'ecran existe, ce test tombe : c'est le signal qu'il faut
    // cocher la case plutot que de laisser la feuille de route mentir.
    assert.ok(!existsSync(new URL("src/ui/players.js", root)));
    assert.ok(!existsSync(new URL("scripts/fide_civ.py", root)));
    const roadmap = claudeMd.slice(claudeMd.indexOf("## Feuille de route"));
    assert.match(roadmap, /- \[ \] Annuaire des joueurs/);
    assert.match(roadmap, /- \[ \] Import FIDE mensuel automatisé/);
  });

  test("les chantiers connus mais absents sont ecrits noir sur blanc", () => {
    const roadmap = claudeMd.slice(claudeMd.indexOf("## Feuille de route"));
    for (const chantier of ["Clubs", "Invitations", "Exports", "Audit de version"]) {
      assert.match(
        roadmap,
        new RegExp(`- \\[ \\] ${chantier}`),
        `${chantier} doit figurer dans la feuille de route`
      );
    }
  });
});

describe("la CI bloque une fusion sur les memes suites qu'en local", () => {
  test("npm test et npm run test:rls tournent tous les deux", () => {
    // Sans les verifications RLS avant fusion, une politique cassee entre
    // sur main et n'est vue qu'au deploiement.
    assert.match(workflow, /run: npm test$/m);
    assert.match(workflow, /run: npm run test:rls$/m);
  });

  test("chaque script appele par la CI existe dans package.json", () => {
    // C'est ce qui manquait pour voir la derive : un workflow peut nommer un
    // script inexistant, et personne ne le remarque avant l'echec.
    const called = [...workflow.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    assert.ok(called.length > 0);
    for (const name of called) {
      assert.ok(scripts[name], `la CI appelle « npm run ${name} », absent de package.json`);
    }
  });

  test("les verifications RLS tournent dans le job deja requis", () => {
    // Un second job apparaitrait sous un nouveau nom de check, que la
    // protection de branche n'exige pas tant que personne ne l'a ajoute —
    // et le trou resterait ouvert entre-temps.
    // Depuis `jobs:` seulement : les declencheurs `push:` et `pull_request:`
    // vivent au meme niveau d'indentation et ne sont pas des jobs.
    const block = workflow.slice(workflow.indexOf("\njobs:"));
    const jobs = [...block.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);
    assert.deepEqual(jobs, ["test"], "un seul job, sinon le nom du check requis change");
  });

  test("la CI se declenche bien sur les PR vers main", () => {
    assert.match(workflow, /pull_request:\s*\n\s*branches: \[main\]/);
  });
});
