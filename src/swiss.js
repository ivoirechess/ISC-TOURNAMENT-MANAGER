// Moteur d'appariement suisse simplifie. Logique pure : pas de DOM, pas de
// fetch, pas de Supabase, pas de Date.now(), pas de Math.random().
//
// Modele d'etat :
//   {
//     players: [{ id, name, rating?, withdrawn? }],
//     rounds: [{ pairings: [{ white, black, result }] }],
//   }
// Un bye est represente par { white: id, black: null, result: 'bye' }.
// Resultats possibles : '1-0', '0-1', '1/2-1/2', 'bye', null (pas encore joue).

// Plafond volontairement inferieur au round-robin complet (n-1 si pair, n si
// impair) : a l'approche du round-robin, l'appariement par score voisin peut
// tomber a court d'adversaires inedits (voir CLAUDE.md, section "limites
// assumees"). Au-dela, on oriente vers le format Toutes rondes (round-robin
// par la methode du cercle), qui ne connait pas ce probleme.
/** Nombre maximal de rondes pour n joueurs (garde-fou, ne pas depasser). */
export function maxRounds(n) {
  if (n <= 1) return 0;
  return n % 2 === 0 ? n - 2 : n - 1;
}

/** Nombre de rondes recommande pour degager un vainqueur net. */
export function recommendedRounds(n) {
  if (n <= 1) return 0;
  return Math.ceil(Math.log2(n));
}

/** Nombre de rondes propose par defaut : recommande, plafonne au maximum autorise. */
export function suggestedRounds(n) {
  if (n <= 1) return 0;
  return Math.min(recommendedRounds(n), maxRounds(n));
}

/**
 * Valide un nombre de rondes demande pour n joueurs.
 * @returns {{ max: number, recommended: number, blocked: boolean, warning: boolean, message: string|null }}
 */
export function validateRoundCount(n, requested) {
  const max = maxRounds(n);
  const recommended = recommendedRounds(n);
  const blocked = requested > max;
  return {
    max,
    recommended,
    blocked,
    warning: requested < recommended,
    message: blocked
      ? "Ce nombre de rondes depasse le maximum autorise en format suisse. Utilisez le format Toutes rondes pour un tournoi de cette taille."
      : null,
  };
}

/** Points obtenus par playerId sur l'ensemble des rondes de l'etat. */
export function score(state, playerId) {
  let total = 0;
  for (const round of state.rounds) {
    for (const pairing of round.pairings) {
      if (pairing.white === playerId) {
        if (pairing.result === "bye" || pairing.result === "1-0") total += 1;
        else if (pairing.result === "1/2-1/2") total += 0.5;
      } else if (pairing.black === playerId) {
        if (pairing.result === "0-1") total += 1;
        else if (pairing.result === "1/2-1/2") total += 0.5;
      }
    }
  }
  return total;
}

/** Une ronde est terminee quand toutes ses parties ont un resultat. */
export function isRoundComplete(round) {
  return round.pairings.every((p) => p.result !== null && p.result !== undefined);
}

function colorBalance(record) {
  let balance = 0;
  for (const color of record.colorHistory) {
    balance += color === "W" ? 1 : -1;
  }
  return balance;
}

// Choisit qui joue blanc/noir pour deux joueurs, en respectant l'ecart
// maximal de |blancs - noirs| <= 2. Retourne null si aucune des deux
// affectations ne respecte la contrainte pour les deux joueurs.
function chooseColors(p1, p2) {
  const b1 = colorBalance(p1);
  const b2 = colorBalance(p2);

  const optionA = { white: p1, black: p2, next1: b1 + 1, next2: b2 - 1 };
  const optionB = { white: p2, black: p1, next1: b1 - 1, next2: b2 + 1 };

  const validA = Math.abs(optionA.next1) <= 2 && Math.abs(optionA.next2) <= 2;
  const validB = Math.abs(optionB.next1) <= 2 && Math.abs(optionB.next2) <= 2;

  if (!validA && !validB) return null;
  if (validA && !validB) return { white: optionA.white.id, black: optionA.black.id };
  if (validB && !validA) return { white: optionB.white.id, black: optionB.black.id };

  // Les deux affectations respectent la contrainte : on prend celle qui
  // rapproche le plus les deux joueurs de l'equilibre, et en cas d'egalite
  // on alterne par rapport a la derniere couleur jouee.
  const costA = Math.abs(optionA.next1) + Math.abs(optionA.next2);
  const costB = Math.abs(optionB.next1) + Math.abs(optionB.next2);
  if (costA < costB) return { white: optionA.white.id, black: optionA.black.id };
  if (costB < costA) return { white: optionB.white.id, black: optionB.black.id };

  const last1 = p1.colorHistory[p1.colorHistory.length - 1];
  if (last1 === "W") return { white: p2.id, black: p1.id };
  return { white: p1.id, black: p2.id };
}

function haveMet(p1, p2) {
  return p1.opponents.includes(p2.id);
}

// Recherche par backtracking d'un appariement complet de `remaining` (deja
// trie par score decroissant). Retourne un tableau de { white, black } ou
// null si aucun appariement complet n'est possible. Backtracking complet
// (pas seulement local aux voisins de score) : correct et suffisamment
// rapide pour un effectif de club.
function search(remaining) {
  if (remaining.length === 0) return [];

  const [p1, ...rest] = remaining;
  for (let i = 0; i < rest.length; i++) {
    const p2 = rest[i];
    if (haveMet(p1, p2)) continue;

    const colors = chooseColors(p1, p2);
    if (!colors) continue;

    const nextRemaining = rest.slice(0, i).concat(rest.slice(i + 1));
    const result = search(nextRemaining);
    if (result !== null) {
      return [colors, ...result];
    }
  }
  return null;
}

function sortByScoreDesc(records) {
  return [...records].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// Reconstruit, a partir de l'historique des rondes, l'etat necessaire a
// l'appariement pour chaque joueur actif : score, historique de couleurs,
// adversaires deja rencontres, et si un bye a deja ete recu.
function buildPlayerRecords(state) {
  const active = state.players.filter((p) => !p.withdrawn);
  const records = new Map(
    active.map((p) => [p.id, { id: p.id, score: 0, colorHistory: [], opponents: [], hadBye: false }])
  );

  for (const round of state.rounds) {
    for (const pairing of round.pairings) {
      const { white, black } = pairing;
      if (black === null) {
        if (records.has(white)) records.get(white).hadBye = true;
        continue;
      }
      if (records.has(white)) {
        records.get(white).opponents.push(black);
        records.get(white).colorHistory.push("W");
      }
      if (records.has(black)) {
        records.get(black).opponents.push(white);
        records.get(black).colorHistory.push("B");
      }
    }
  }

  for (const p of active) {
    records.get(p.id).score = score(state, p.id);
  }

  return [...records.values()];
}

// Recherche par backtracking d'un appariement complet de `remaining`
// autorisant au plus `maxAllowed` revanches au total (la couleur reste une
// contrainte stricte : jamais violee). Retourne un tableau de { white,
// black } ou null si aucun appariement n'existe avec ce plafond de revanches.
function searchWithMaxRematches(remaining, maxAllowed) {
  function helper(rem, used) {
    if (rem.length === 0) return [];

    const [p1, ...rest] = rem;
    for (let i = 0; i < rest.length; i++) {
      const p2 = rest[i];
      const colors = chooseColors(p1, p2);
      if (!colors) continue;

      const nextUsed = used + (haveMet(p1, p2) ? 1 : 0);
      if (nextUsed > maxAllowed) continue;

      const nextRemaining = rest.slice(0, i).concat(rest.slice(i + 1));
      const result = helper(nextRemaining, nextUsed);
      if (result !== null) {
        return [colors, ...result];
      }
    }
    return null;
  }
  return helper(remaining, 0);
}

// Trouve l'appariement qui minimise le nombre de revanches (approfondissement
// iteratif : le premier seuil satisfaisable est le minimum, puisque tous les
// seuils inferieurs ont deja echoue). La couleur, elle, n'est jamais
// sacrifiee : chooseColors rejette toute affectation hors de |blancs-noirs| <= 2.
function bestEffortMatching(remaining) {
  for (let maxAllowed = 0; maxAllowed <= remaining.length; maxAllowed++) {
    const pairs = searchWithMaxRematches(remaining, maxAllowed);
    if (pairs) return pairs;
  }
  return null;
}

/**
 * Genere la prochaine ronde d'appariements pour l'etat donne. Ne leve jamais
 * d'erreur pour un simple defaut d'appariement parfait : si aucune
 * configuration sans revanche n'existe (effectif proche du round-robin),
 * elle retourne le moins mauvais appariement possible - en minimisant le
 * nombre de revanches, sans jamais sacrifier l'equilibre des couleurs - et
 * consigne chaque revanche forcee dans `warnings`, a valider par l'arbitre.
 * @param {{players: Array, rounds: Array}} state
 * @returns {{ pairings: Array<{white: string, black: string|null, result: string|null}>, warnings: string[] }}
 */
export function pairRound(state) {
  for (const round of state.rounds) {
    if (!isRoundComplete(round)) {
      throw new Error("Impossible de generer une nouvelle ronde : une ronde precedente n'est pas terminee");
    }
  }

  const records = buildPlayerRecords(state);
  if (records.length === 0) {
    return { pairings: [], warnings: [] };
  }

  const sorted = sortByScoreDesc(records);

  let byeCandidate = null;
  let toMatch = sorted;
  if (sorted.length % 2 === 1) {
    // Le bye revient au joueur le moins bien classe qui n'en a pas encore recu un.
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (!sorted[i].hadBye) {
        byeCandidate = sorted[i];
        break;
      }
    }
    if (!byeCandidate) {
      throw new Error("Impossible d'attribuer le bye : tous les joueurs actifs en ont deja recu un");
    }
    toMatch = sorted.filter((r) => r.id !== byeCandidate.id);
  }

  let pairs = search(toMatch);
  const warnings = [];
  if (!pairs) {
    pairs = bestEffortMatching(toMatch);
    if (!pairs) {
      throw new Error("Aucun appariement valide trouve, meme en autorisant des revanches");
    }
    const byId = new Map(toMatch.map((r) => [r.id, r]));
    for (const pair of pairs) {
      if (byId.get(pair.white).opponents.includes(pair.black)) {
        warnings.push(`Revanche forcee : ${pair.white} et ${pair.black} se sont deja affrontes`);
      }
    }
  }

  const pairings = pairs.map((p) => ({ white: p.white, black: p.black, result: null }));
  if (byeCandidate) {
    pairings.push({ white: byeCandidate.id, black: null, result: "bye" });
  }
  return { pairings, warnings };
}
