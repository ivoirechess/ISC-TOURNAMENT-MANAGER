// Rounds view: pairings and results for a tournament.
//
// Public and read-only by default — anyone can browse every round played.
// For the owning admin (or a super_admin) of a running tournament, the same
// rows gain entry buttons. Data access goes through src/data.js; the rules
// live in src/round-entry.js (pure) and, above all, in RLS and triggers.

import {
  getTournamentResults,
  getCurrentRole,
  setPairingResult,
  clearPairingResult,
  createRound,
  archiveTournament,
  onPairingsChange,
} from "../data.js";
import { isAdminRole } from "../roles.js";
import { pairRound } from "../swiss.js";
import { RESULT_LABELS } from "../tournament-edit.js";
import {
  ENTRY_CHOICES,
  canEnterResults,
  engineState,
  isEditablePairing,
  nextRoundAction,
  nextRoundLabel,
  progressLabel,
  resultClickAction,
  warningsConfirmation,
} from "../round-entry.js";

function el(id) {
  return document.getElementById(id);
}

let current = null; // { tournament, state }
let canEdit = false;
let visibleRound = 0; // index into current.state.rounds
let unsubscribe = null;

function setFeedback(message, isError) {
  const node = el("rounds-feedback");
  node.textContent = message;
  node.className = isError ? "error" : "success";
}

function playerName(id) {
  return current.state.players.find((p) => p.id === id)?.name ?? id;
}

// One tab per round played, so spectators can go back through the whole
// tournament and not only the round in progress.
function renderRoundTabs() {
  const box = el("rounds-tabs");
  box.innerHTML = "";
  current.state.rounds.forEach((round, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = index === visibleRound ? "round-tab active" : "round-tab";
    tab.textContent = `Ronde ${round.number ?? index + 1}`;
    tab.addEventListener("click", () => {
      visibleRound = index;
      renderRound();
    });
    box.append(tab);
  });
}

function renderEntryButtons(pairing, row) {
  const group = document.createElement("div");
  group.className = "entry-group";

  for (const choice of ENTRY_CHOICES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = pairing.result === choice.value ? "entry active" : "entry";
    button.textContent = choice.label;
    // Clicking the active button empties the result: that is the cancel.
    button.title =
      pairing.result === choice.value
        ? "Cliquer à nouveau pour annuler ce résultat"
        : `Enregistrer ${choice.label}`;
    button.addEventListener("click", () => onEntryClick(pairing, choice.value, group));
    group.append(button);
  }

  row.append(group);
}

function renderRound() {
  renderRoundTabs();
  const round = current.state.rounds[visibleRound];
  const box = el("rounds-board");
  box.innerHTML = "";

  if (!round) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Aucune ronde n'a encore été appariée.";
    box.append(empty);
    el("rounds-progress").textContent = "";
    renderNextAction();
    return;
  }

  el("rounds-progress").textContent = progressLabel(round);

  for (const pairing of round.pairings) {
    const row = document.createElement("div");
    row.className = "pairing-row";

    const board = document.createElement("span");
    board.className = "board-number";
    board.textContent = String(pairing.board ?? "");

    const names = document.createElement("span");
    names.className = "pairing-names";
    names.textContent =
      pairing.black === null
        ? `${playerName(pairing.white)} — exempt`
        : `${playerName(pairing.white)} — ${playerName(pairing.black)}`;

    row.append(board, names);

    if (!isEditablePairing(pairing)) {
      // A bye is shown but never entered: it is worth its point already.
      const fixed = document.createElement("span");
      fixed.className = "muted";
      fixed.textContent = RESULT_LABELS.bye;
      row.append(fixed);
    } else if (canEdit) {
      renderEntryButtons(pairing, row);
    } else {
      const shown = document.createElement("span");
      shown.className = "result-shown";
      shown.textContent = pairing.result ? RESULT_LABELS[pairing.result] ?? pairing.result : "—";
      row.append(shown);
    }

    box.append(row);
  }

  renderNextAction();
}

function renderNextAction() {
  const slot = el("rounds-next");
  slot.innerHTML = "";
  if (!canEdit) return;

  const action = nextRoundAction(current.tournament, current.state.rounds);
  const label = nextRoundLabel(action);
  if (!label) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.textContent = label;
  button.addEventListener("click", () =>
    action === "generate" ? onGenerateRound(button) : onArchive(button)
  );
  slot.append(button);
}

async function onEntryClick(pairing, choice, group) {
  const action = resultClickAction(pairing, choice);
  if (!action) return;

  const allowed = canEnterResults(current.tournament);
  if (!allowed.ok) {
    setFeedback(allowed.reason, true);
    return;
  }

  for (const button of group.querySelectorAll("button")) button.disabled = true;
  try {
    if (action === "clear") {
      await clearPairingResult(pairing.id);
      pairing.result = null;
      setFeedback("Résultat annulé.", false);
    } else {
      await setPairingResult(pairing.id, choice);
      pairing.result = choice;
      setFeedback("Résultat enregistré.", false);
    }
    renderRound();
  } catch (err) {
    setFeedback(err.message, true);
    for (const button of group.querySelectorAll("button")) button.disabled = false;
  }
}

async function onGenerateRound(button) {
  button.disabled = true;
  try {
    const state = engineState(current.state.players, current.state.rounds);
    const { pairings, warnings } = pairRound(state);

    // A forced rematch is a real departure from the pairing rules: the
    // arbiter sees which boards are affected and decides.
    if (warnings.length > 0 && !window.confirm(warningsConfirmation(warnings))) {
      button.disabled = false;
      return;
    }

    await createRound({
      tournamentId: current.tournament.id,
      number: current.state.rounds.length + 1,
      pairings,
    });
    await reload();
    visibleRound = current.state.rounds.length - 1;
    renderRound();
    setFeedback(
      warnings.length > 0
        ? `Ronde ${current.state.rounds.length} enregistrée, avec ${warnings.length} revanche(s) forcée(s).`
        : `Ronde ${current.state.rounds.length} enregistrée.`,
      false
    );
  } catch (err) {
    setFeedback(err.message, true);
    button.disabled = false;
  }
}

async function onArchive(button) {
  if (!window.confirm(
    `Clôturer « ${current.tournament.name} » ?\n\n` +
    "Le classement devient définitif et les résultats ne seront plus modifiables."
  )) {
    return;
  }
  button.disabled = true;
  try {
    await archiveTournament(current.tournament.id);
    current.tournament.status = "archived";
    canEdit = false;
    renderRound();
    setFeedback("Tournoi clôturé.", false);
  } catch (err) {
    setFeedback(err.message, true);
    button.disabled = false;
  }
}

async function reload() {
  const payload = await getTournamentResults(current.tournament.id);
  if (payload) current = payload;
}

/** Drops the realtime subscription when the view is left. */
export function closeRounds() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

/**
 * Called by the router with the tournament already loaded by the parent
 * view, so the rounds are not fetched twice.
 *
 * `focusRound` opens a given round number instead of the last one: that is
 * how starting a tournament lands on the round 1 it has just drawn. An
 * unknown number falls back to the last round, so a caller asking for a
 * round that does not exist gets the usual view rather than an empty one.
 */
export async function openRounds(payload, { focusRound = null } = {}) {
  closeRounds();
  current = payload;
  const wanted = current.state.rounds.findIndex((round) => round.number === focusRound);
  visibleRound = wanted >= 0 ? wanted : Math.max(0, current.state.rounds.length - 1);
  setFeedback("", false);

  let role = null;
  try {
    role = await getCurrentRole();
  } catch {
    role = null;
  }
  // Interface guard only: RLS refuses the writes of anyone else, whatever
  // this view chooses to show.
  canEdit = isAdminRole(role) && canEnterResults(current.tournament).ok;

  renderRound();

  try {
    unsubscribe = await onPairingsChange(async () => {
      // Any pairing moved somewhere: reload this tournament and repaint.
      // Spectators get the result without touching the page.
      await reload();
      renderRound();
    });
  } catch {
    // Realtime unavailable (not enabled on the project, or offline): the
    // view stays correct, it just no longer updates by itself.
  }
}
