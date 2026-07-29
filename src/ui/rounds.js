// Rounds view: pairings and results for a tournament.
//
// Public and read-only by default — anyone can browse every round played.
// For the owning admin (or a super_admin) of a running tournament, the same
// rows gain entry buttons. Data access goes through src/data.js; the rules
// live in src/round-entry.js (pure) and, above all, in RLS and triggers.

import {
  getTournamentResults,
  getCurrentRole,
  getCurrentUserId,
  setPairingResult,
  clearPairingResult,
  createRound,
  archiveTournament,
  validateRound,
  onPairingsChange,
} from "../data.js";
import { isAdminRole } from "../roles.js";
import { pairRound } from "../swiss.js";
import { RESULT_LABELS } from "../tournament-edit.js";
import { computeStandingsAfterRound } from "../tiebreaks.js";
import {
  ENTRY_CHOICES,
  canEnterResults,
  engineState,
  isEditablePairing,
  nextRoundAction,
  nextRoundLabel,
  progressLabel,
  selectDefaultRound,
  resultClickAction,
  warningsConfirmation,
} from "../round-entry.js";
import { canShowOrganizerPanel } from "../tournament-page.js";

function el(id) {
  return document.getElementById(id);
}

let current = null; // { tournament, state }
let canEdit = false;
let visibleRound = 0; // index into current.state.rounds
let unsubscribe = null;
let unplayedOnly = false;

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
    const status = round.validated_at
      ? "Validée"
      : round.pairings.every((pairing) => pairing.result != null)
        ? "À valider"
        : "En cours";
    tab.textContent = `Ronde ${round.number ?? index + 1} — ${status}`;
    tab.setAttribute("aria-label", `Ronde ${round.number ?? index + 1}, ${status}`);
    tab.addEventListener("click", () => {
      visibleRound = index;
      updateRoundUrl(round.number);
      renderRound();
    });
    box.append(tab);
  });
}

function renderEntryButtons(pairing) {
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

  return group;
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

  el("rounds-progress").textContent =
    current.tournament.status === "draft"
      ? "Calendrier préparé — démarrez le tournoi pour saisir les résultats."
      : progressLabel(round);

  const heading = document.createElement("div");
  heading.className = "pairing-row pairing-head";
  for (const label of ["Table", "Blancs", "Résultat", "Noirs"]) {
    const cell = document.createElement("strong"); cell.textContent = label; heading.append(cell);
  }
  box.append(heading);

  for (const pairing of round.pairings) {
    if (unplayedOnly && (pairing.black === null || pairing.result != null)) continue;
    const row = document.createElement("div");
    row.className = "pairing-row";

    const board = document.createElement("span");
    board.className = "board-number";
    board.textContent = String(pairing.board ?? "");

    const white = document.createElement("span"); white.className = "pairing-player"; white.textContent = playerName(pairing.white);
    const black = document.createElement("span"); black.className = "pairing-player"; black.textContent = pairing.black === null ? "Exempt" : playerName(pairing.black);
    let resultNode;

    if (!isEditablePairing(pairing)) {
      // A bye is shown but never entered: it is worth its point already.
      resultNode = document.createElement("span"); resultNode.className = "muted"; resultNode.textContent = RESULT_LABELS.bye;
    } else if (canEdit && canEnterResults(current.tournament, round).ok) {
      resultNode = renderEntryButtons(pairing);
    } else {
      resultNode = document.createElement("span"); resultNode.className = "result-shown";
      resultNode.textContent = pairing.result ? RESULT_LABELS[pairing.result] ?? pairing.result : "—";
    }
    row.append(board, white, resultNode, black);

    box.append(row);
  }

  if (round.validated_at) renderStandings(round, box);

  renderNextAction();
}

function updateRoundUrl(roundNumber) {
  const identifier = current.tournament.slug || current.tournament.id;
  const hash = `#/tournoi/${encodeURIComponent(identifier)}?onglet=pairings&ronde=${roundNumber}`;
  // replaceState changes the shareable URL without firing hashchange, so the
  // already-loaded tournament and its Realtime subscription stay in place.
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
}

function renderNextAction() {
  const slot = el("rounds-next");
  slot.innerHTML = "";
  if (!canEdit) return;

  const round = current.state.rounds[visibleRound];
  if (round && !round.validated_at && roundProgressComplete(round)) {
    const validate = document.createElement("button");
    validate.type = "button";
    validate.className = "primary";
    validate.textContent = "Valider la ronde";
    validate.addEventListener("click", () => onValidateRound(round, validate));
    slot.append(validate);
    return;
  }

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

function roundProgressComplete(round) {
  return round.pairings.length > 0 && round.pairings.every((pairing) => pairing.result != null);
}

function renderStandings(round, box) {
  const title = document.createElement("h3");
  title.textContent = `Classement après la ronde ${round.number}`;
  const list = document.createElement("ol");
  for (const row of computeStandingsAfterRound(
    current.state,
    round.number,
    current.tournament.tiebreaks
  )) {
    const item = document.createElement("li");
    item.textContent = `${row.name} — ${row.points} pt${row.points > 1 ? "s" : ""}`;
    list.append(item);
  }
  box.append(title, list);
}

async function onValidateRound(round, button) {
  button.disabled = true;
  try {
    await validateRound(round.id);
    await reload();
    visibleRound = current.state.rounds.findIndex((item) => item.id === round.id);
    renderRound();
    setFeedback(`Ronde ${round.number} validée.`, false);
  } catch (err) {
    setFeedback(err.message, true);
    button.disabled = false;
  }
}

async function onEntryClick(pairing, choice, group) {
  const action = resultClickAction(pairing, choice);
  if (!action) return;

  const round = current.state.rounds[visibleRound];
  const allowed = canEnterResults(current.tournament, round);
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
  const selected = selectDefaultRound(current.tournament, current.state.rounds, focusRound);
  visibleRound = selected === null
    ? 0
    : current.state.rounds.findIndex((round) => round.number === selected);
  setFeedback("", false);
  unplayedOnly=false;el("unplayed-only").checked=false;el("unplayed-only").onchange=event=>{unplayedOnly=event.target.checked;renderRound()};
  const realtime=el("realtime-state");realtime.textContent="Connexion Realtime…";realtime.className="connection-state";

  let role = null;
  let userId = null;
  try {
    [role, userId] = await Promise.all([getCurrentRole(), getCurrentUserId()]);
  } catch {
    role = null;
  }
  // Interface guard only: RLS refuses the writes of anyone else, whatever
  // this view chooses to show.
  canEdit = isAdminRole(role) && canShowOrganizerPanel(current.tournament, role, userId) && canEnterResults(current.tournament).ok;

  renderRound();

  try {
    unsubscribe = await onPairingsChange(async () => {
      // Any pairing moved somewhere: reload this tournament and repaint.
      // Spectators get the result without touching the page.
      await reload();
      renderRound();
    },status=>{const connected=status==="SUBSCRIBED";realtime.textContent=connected?"Realtime connecté":"Realtime indisponible";realtime.className=`connection-state ${connected?"connected":"unavailable"}`;});
  } catch {
    // Realtime unavailable (not enabled on the project, or offline): the
    // view stays correct, it just no longer updates by itself.
    realtime.textContent="Realtime indisponible";realtime.className="connection-state unavailable";
  }
}
