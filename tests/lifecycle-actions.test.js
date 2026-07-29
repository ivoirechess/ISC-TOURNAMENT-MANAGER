// Behavioural tests for the life-cycle buttons.
//
// The module is driven for real — its own render and click code runs — on a
// DOM stub small enough to be read in one sitting, with the data layer
// replaced by a recording backend. What is checked here is exactly what a
// static reading of the source cannot promise: that the buttons are the ones
// the state allows, that they go down for the whole call, that a declined
// confirmation calls nothing at all, and that a start opens round 1.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// A DOM stub: only what src/ui/lifecycle-actions.js touches.
// ---------------------------------------------------------------------------
class StubNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = [];
    this.textContent = "";
    this.className = "";
    this.disabled = false;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  addEventListener(type, handler) {
    if (type === "click") this.listeners.push(handler);
  }

  /**
   * Returns the handlers' promises so a test can await the click.
   * A disabled button ignores clicks, as it does in a browser — that is
   * precisely what makes the double-submission guard worth anything.
   */
  click() {
    if (this.disabled) return Promise.resolve([]);
    return Promise.all(this.listeners.map((handler) => handler()));
  }

  set innerHTML(value) {
    assert.equal(value, "", "le stub ne sait qu'effacer");
    this.children = [];
  }

  get innerHTML() {
    return "";
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

function installDom() {
  const nodes = new Map(
    ["tournament-actions", "tournament-actions-feedback"].map((id) => [id, new StubNode("div")])
  );
  globalThis.document = {
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: (tag) => new StubNode(tag),
  };
  return nodes;
}

const nodes = installDom();
const { openLifecycleActions, confirmAction, LIVE_BACKEND } = await import(
  "../src/ui/lifecycle-actions.js"
);

const slot = () => nodes.get("tournament-actions");
const feedback = () => nodes.get("tournament-actions-feedback");
const buttons = () => slot().descendants().filter((node) => node.tagName === "button");
const buttonFor = (action) => buttons().find((node) => node.dataset.action === action);
const shownActions = () => buttons().map((node) => node.dataset.action);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const OWNER = "user-owner";

function tournament(overrides = {}) {
  return {
    id: "t1",
    name: "Open de Cocody",
    status: "draft",
    published_at: null,
    created_by: OWNER,
    ...overrides,
  };
}

const upcoming = () => tournament({ published_at: "2026-07-01T10:00:00Z" });
const ongoing = () => tournament({ status: "ongoing", published_at: "2026-07-01T10:00:00Z" });
const finished = () => tournament({ status: "archived", published_at: "2026-07-01T10:00:00Z" });

/** A backend that records what was called and answers as told. */
function recorder({ role = "admin", userId = OWNER, fail = null, block = null } = {}) {
  const calls = [];
  const transition = (name) => async (...args) => {
    calls.push([name, ...args]);
    if (block) await block;
    if (fail) throw new Error(fail);
    return null;
  };
  return {
    calls,
    role: async () => role,
    userId: async () => userId,
    publish: transition("publish"),
    unpublish: transition("unpublish"),
    start: transition("start"),
    cancel: transition("cancel"),
    delete: transition("delete"),
  };
}

/** Dialog stub: answers `confirm`/`prompt` as told, records the wording. */
function dialogs({ confirm = true, prompt = "" } = {}) {
  const seen = { confirms: [], prompts: [] };
  return {
    seen,
    location: { hash: "#/tournoi/t1" },
    confirm(message) {
      seen.confirms.push(message);
      return confirm;
    },
    prompt(message) {
      seen.prompts.push(message);
      return prompt;
    },
  };
}

const reloads = () => {
  const calls = [];
  return { calls, reload: async (options) => calls.push(options) };
};

beforeEach(() => {
  slot().children = [];
  feedback().textContent = "";
});

// ---------------------------------------------------------------------------

describe("qui voit les boutons", () => {
  test("le proprietaire du tournoi, oui", async () => {
    await openLifecycleActions(tournament(), null, { backend: recorder(), dialogs: dialogs() });
    assert.deepEqual(shownActions(), ["publish", "delete"]);
  });

  test("un autre organisateur, non", async () => {
    // RLS refuserait de toute facon : ce filtre evite d'offrir un bouton
    // dont la seule reponse possible serait un refus.
    await openLifecycleActions(tournament(), null, {
      backend: recorder({ userId: "user-autre" }),
      dialogs: dialogs(),
    });
    assert.deepEqual(shownActions(), []);
  });

  test("un super-admin, sur le tournoi d'autrui, oui", async () => {
    await openLifecycleActions(tournament(), null, {
      backend: recorder({ role: "super_admin", userId: "user-autre" }),
      dialogs: dialogs(),
    });
    assert.deepEqual(shownActions(), ["publish", "delete"]);
  });

  test("un visiteur sans compte, non", async () => {
    await openLifecycleActions(tournament(), null, {
      backend: recorder({ role: null, userId: null }),
      dialogs: dialogs(),
    });
    assert.deepEqual(shownActions(), []);
  });

  test("une session illisible ne fait pas tomber l'ecran", async () => {
    const backend = recorder();
    backend.role = async () => {
      throw new Error("session illisible");
    };
    await openLifecycleActions(tournament(), null, { backend, dialogs: dialogs() });
    assert.deepEqual(shownActions(), []);
  });
});

describe("quels boutons, selon l'etat", () => {
  test("brouillon : publier et supprimer", async () => {
    await openLifecycleActions(tournament(), null, { backend: recorder(), dialogs: dialogs() });
    assert.deepEqual(shownActions(), ["publish", "delete"]);
    assert.equal(buttonFor("publish").textContent, "Publier");
    assert.equal(buttonFor("delete").textContent, "Supprimer");
  });

  test("a venir : depublier, demarrer, annuler", async () => {
    await openLifecycleActions(upcoming(), null, { backend: recorder(), dialogs: dialogs() });
    assert.deepEqual(shownActions(), ["unpublish", "start", "cancel", "delete"]);
    assert.equal(buttonFor("start").textContent, "Démarrer le tournoi");
    assert.equal(buttonFor("unpublish").textContent, "Dépublier");
  });

  test("en cours : plus de depublication", async () => {
    // Depublier un tournoi lance retirerait la page que les joueurs suivent.
    await openLifecycleActions(ongoing(), null, { backend: recorder(), dialogs: dialogs() });
    assert.ok(!shownActions().includes("unpublish"));
    assert.ok(!shownActions().includes("publish"));
  });

  test("la cloture n'est pas doublee ici", async () => {
    // Elle a deja son bouton dans la vue des rondes, a cote de la derniere
    // ronde qu'elle cloture. Deux boutons pour une transition, c'est un de
    // trop.
    await openLifecycleActions(ongoing(), null, { backend: recorder(), dialogs: dialogs() });
    assert.ok(!shownActions().includes("finish"));
  });

  test("termine : plus aucun bouton", async () => {
    await openLifecycleActions(finished(), null, { backend: recorder(), dialogs: dialogs() });
    assert.deepEqual(shownActions(), []);
  });

  test("annule : suppression douce disponible", async () => {
    await openLifecycleActions(tournament({ cancelled_at: "2026-07-02T08:00:00Z" }), null, {
      backend: recorder(),
      dialogs: dialogs(),
    });
    assert.deepEqual(shownActions(), ["delete"]);
  });

  test("l'etat courant est ecrit a cote des boutons", async () => {
    await openLifecycleActions(upcoming(), null, { backend: recorder(), dialogs: dialogs() });
    const labels = slot().descendants().map((node) => node.textContent);
    assert.ok(labels.includes("À venir"));
  });
});

describe("chaque bouton appelle sa transition", () => {
  test("publier, depublier, demarrer", async () => {
    for (const [row, action] of [
      [tournament(), "publish"],
      [upcoming(), "unpublish"],
      [upcoming(), "start"],
    ]) {
      const backend = recorder();
      const { reload, calls } = reloads();
      await openLifecycleActions(row, reload, { backend, dialogs: dialogs() });
      await buttonFor(action).click();
      assert.deepEqual(backend.calls, [[action, "t1"]]);
      assert.equal(calls.length, 1, `${action} doit rafraichir la vue`);
    }
  });

  test("annuler transmet la raison saisie", async () => {
    const backend = recorder();
    await openLifecycleActions(upcoming(), null, {
      backend,
      dialogs: dialogs({ prompt: "  Salle indisponible  " }),
    });
    await buttonFor("cancel").click();
    assert.deepEqual(backend.calls, [["cancel", "t1", "Salle indisponible"]]);
  });

  test("une raison vide n'envoie rien plutot qu'une chaine vide", async () => {
    const backend = recorder();
    await openLifecycleActions(upcoming(), null, { backend, dialogs: dialogs({ prompt: "   " }) });
    await buttonFor("cancel").click();
    assert.deepEqual(backend.calls, [["cancel", "t1", null]]);
  });
});

describe("les confirmations", () => {
  test("annuler demande confirmation, et nomme le tournoi", async () => {
    const backend = recorder();
    const talk = dialogs({ confirm: false });
    await openLifecycleActions(upcoming(), null, { backend, dialogs: talk });
    await buttonFor("cancel").click();
    assert.deepEqual(backend.calls, [], "un refus n'appelle rien");
    assert.equal(talk.seen.confirms.length, 1);
    assert.ok(talk.seen.confirms[0].includes("Open de Cocody"));
    assert.equal(buttonFor("cancel").disabled, false);
  });

  test("fermer la fenetre de la raison annule le geste entier", async () => {
    // Fermer une fenetre n'est pas repondre « oui, sans raison ».
    const backend = recorder();
    await openLifecycleActions(upcoming(), null, {
      backend,
      dialogs: dialogs({ prompt: null }),
    });
    await buttonFor("cancel").click();
    assert.deepEqual(backend.calls, []);
  });

  test("supprimer demande confirmation, et nomme le tournoi", async () => {
    const backend = recorder();
    const talk = dialogs({ confirm: false });
    await openLifecycleActions(tournament(), null, { backend, dialogs: talk });
    await buttonFor("delete").click();
    assert.deepEqual(backend.calls, []);
    assert.ok(talk.seen.confirms[0].includes("Open de Cocody"));
  });

  test("publier et demarrer ne posent pas de question", async () => {
    // Publier se defait en depubliant, demarrer est le geste attendu : une
    // fenetre de plus ne protegerait rien et serait cliquee sans la lire.
    for (const [row, action] of [[tournament(), "publish"], [upcoming(), "start"]]) {
      const talk = dialogs();
      await openLifecycleActions(row, null, { backend: recorder(), dialogs: talk });
      await buttonFor(action).click();
      assert.deepEqual(talk.seen.confirms, []);
    }
  });

  test("la confirmation d'annulation annonce le gel et la page publique", () => {
    const message = confirmAction("cancel", tournament(), dialogs({ confirm: false }));
    assert.equal(message, null);
  });
});

describe("double soumission", () => {
  test("tout le groupe est desactive pendant l'appel", async () => {
    // Deux transitions lancees ensemble sur le meme tournoi se marchent
    // dessus ; la seconde revient avec un refus qui n'explique rien.
    let release;
    const block = new Promise((resolve) => {
      release = resolve;
    });
    const backend = recorder({ block });
    await openLifecycleActions(upcoming(), reloads().reload, { backend, dialogs: dialogs() });

    const running = buttonFor("start").click();
    assert.deepEqual(
      buttons().map((node) => node.disabled),
      [true, true, true, true],
      "tous les boutons doivent tomber, pas seulement celui clique"
    );
    // Un second clic pendant l'appel n'ajoute rien.
    await buttonFor("start").click();
    assert.equal(backend.calls.length, 1);

    release();
    await running;
  });

  test("un echec rend la main et affiche le message du serveur", async () => {
    const backend = recorder({ fail: "Il faut au moins deux joueurs actifs pour demarrer." });
    const { reload, calls } = reloads();
    await openLifecycleActions(upcoming(), reload, { backend, dialogs: dialogs() });
    await buttonFor("start").click();

    assert.match(feedback().textContent, /au moins deux joueurs/);
    assert.equal(feedback().className, "error");
    assert.deepEqual(buttons().map((node) => node.disabled), [false, false, false, false]);
    assert.deepEqual(calls, [], "un echec ne rafraichit pas la vue");
  });
});

describe("apres la transition", () => {
  test("demarrer ouvre la ronde 1 fraichement tiree", async () => {
    const { reload, calls } = reloads();
    await openLifecycleActions(upcoming(), reload, { backend: recorder(), dialogs: dialogs() });
    await buttonFor("start").click();
    assert.deepEqual(calls, [{ focusRound: 1 }]);
    assert.match(feedback().textContent, /Ronde 1/);
    assert.equal(feedback().className, "success");
  });

  test("les autres transitions rafraichissent sans changer de ronde", async () => {
    const { reload, calls } = reloads();
    await openLifecycleActions(tournament(), reload, { backend: recorder(), dialogs: dialogs() });
    await buttonFor("publish").click();
    assert.deepEqual(calls, [{ focusRound: null }]);
  });

  test("supprimer renvoie a l'accueil, sans recharger une page devenue invisible", async () => {
    // Apres la suppression, RLS masque la ligne meme a son auteur : rester
    // ici n'afficherait plus que « Tournoi introuvable ».
    const { reload, calls } = reloads();
    const talk = dialogs();
    await openLifecycleActions(tournament(), reload, { backend: recorder(), dialogs: talk });
    await buttonFor("delete").click();
    assert.equal(talk.location.hash, "#/");
    assert.deepEqual(calls, []);
  });
});

describe("cablage reel", () => {
  const source = readFileSync(new URL("../src/ui/lifecycle-actions.js", import.meta.url), "utf8");

  test("le backend de production nomme les enveloppes RPC de data.js", () => {
    // Le stub ci-dessus ne dit rien de ce que fait le vrai bouton : ce test
    // fixe la correspondance action -> fonction de src/data.js.
    for (const [action, fn] of [
      ["publish", "publishTournament"],
      ["unpublish", "unpublishTournament"],
      ["start", "startTournament"],
      ["cancel", "cancelTournament"],
      ["delete", "softDeleteTournament"],
    ]) {
      assert.match(
        source,
        new RegExp(`${action}: \\(id[^)]*\\) => ${fn}\\(`),
        `${action} doit passer par ${fn}`
      );
      assert.ok(Object.hasOwn(LIVE_BACKEND, action), `${action} absent du backend reel`);
    }
    assert.equal(typeof LIVE_BACKEND.role, "function");
    assert.equal(typeof LIVE_BACKEND.userId, "function");
  });

  test("aucun acces direct a Supabase depuis la vue", () => {
    // Regle CLAUDE.md : src/data.js est le seul module qui parle a Supabase.
    assert.ok(!source.includes("createClient"));
    assert.ok(!source.includes("supabase-js"));
  });

  test("la vue tournoi branche le module et lui passe la ronde a ouvrir", () => {
    const app = readFileSync(new URL("../src/ui/app.js", import.meta.url), "utf8");
    assert.match(app, /openLifecycleActions\(/);
    assert.match(app, /focusRound/);
    const rounds = readFileSync(new URL("../src/ui/rounds.js", import.meta.url), "utf8");
    assert.match(rounds, /focusRound/);
  });
});
