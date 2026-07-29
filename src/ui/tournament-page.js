import { FORMATS } from "../tournament-validation.js";
import { stateLabel } from "../tournament-lifecycle.js";
import { computeStandingsAfterRound, TIEBREAK_LABELS } from "../tiebreaks.js";
import { initialRanking, tournamentProgress, tournamentTabUrl } from "../tournament-page.js";

function el(id) { return document.getElementById(id); }
function text(id, value) { el(id).textContent = value || "—"; }
function formatName(value) { return FORMATS.find((item) => item.value === value)?.label ?? value; }
function cadence(value) { return ({ standard: "Classique", rapid: "Rapide", blitz: "Blitz" })[value] ?? "Non précisée"; }
function dateTime(value, timezone) {
  if (!value) return "À confirmer";
  return new Intl.DateTimeFormat("fr-CI", { dateStyle: "medium", timeStyle: "short", timeZone: timezone || "Africa/Abidjan" }).format(new Date(value));
}

function renderPlayers(payload) {
  const body = el("tournament-player-rows"); body.innerHTML = "";
  for (const player of initialRanking(payload.state.players, payload.tournament.rating_type)) {
    const row = document.createElement("tr");
    const values = [player.initialRank, player.name, player.title || "—", player.fide_id || "—", player.federation || "—", player.club || "—", player.elo || "Non classé"];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement("td");
      cell.dataset.label = ["Rang initial", "Joueur", "Titre", "ID FIDE", "Fédération", "Club", "Elo"][index];
      cell.textContent = String(value); row.append(cell);
    }
    body.append(row);
  }
}

function renderOverview(payload) {
  const { tournament, state } = payload;
  text("overview-description", tournament.description || "Aucune description publiée.");
  const progress = tournamentProgress(tournament, state.rounds);
  el("overview-progress-bar").value = progress.validated;
  el("overview-progress-bar").max = Math.max(1, progress.planned);
  text("overview-progress-label", `${progress.validated} ronde(s) validée(s) sur ${progress.planned}`);
  text("overview-next-round", progress.nextRound ? `Ronde ${progress.nextRound}` : "Aucune ronde à venir");
  text("overview-practical", [dateTime(tournament.starts_at, tournament.timezone), tournament.venue_name, tournament.venue_address, tournament.city].filter(Boolean).join(" · "));
  const registration = el("overview-registration"); registration.hidden = !tournament.registration_url; registration.href = tournament.registration_url || "#";
  const contact = el("overview-contact"); contact.hidden = !tournament.public_contact_email; contact.href = tournament.public_contact_email ? `mailto:${tournament.public_contact_email}` : "#"; contact.textContent = tournament.public_contact_email || "";
}

function renderStandings(payload) {
  const nav = el("standing-round-links"); nav.innerHTML = "";
  const table = el("tournament-standings-table"); table.innerHTML = "";
  const validated = payload.state.rounds.filter((round) => round.validated_at);
  if (!validated.length) { nav.textContent = "Le classement sera publié après la validation de la première ronde."; return; }
  const render = (number) => {
    const rows = computeStandingsAfterRound(payload.state, number, payload.tournament.tiebreaks);
    table.innerHTML = "<thead><tr><th>#</th><th>Joueur</th><th>Points</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const item of rows) { const tr = document.createElement("tr"); for (const value of [item.rank, item.name, item.points]) { const td = document.createElement("td"); td.textContent = String(value); tr.append(td); } body.append(tr); }
    table.append(body);
  };
  validated.forEach((round) => {
    const button = document.createElement("button"); button.type = "button";
    button.textContent = `Après ronde ${round.number}`;
    button.onclick = () => render(round.number); nav.append(button);
  });
  if (payload.tournament.status === "archived") {
    const finalButton = document.createElement("button"); finalButton.type = "button"; finalButton.textContent = "Classement final";
    finalButton.onclick = () => render(validated[validated.length - 1].number); nav.append(finalButton);
  }
  render(validated[validated.length - 1].number);
  text("standings-tiebreaks", `Départages : Points, ${(payload.tournament.tiebreaks ?? []).map((key) => TIEBREAK_LABELS[key] ?? key).join(", ")}`);
}

export function renderTournamentPage(payload) {
  const { tournament, state } = payload;
  text("tournament-title", tournament.name);
  const badge = el("tournament-status"); badge.textContent = stateLabel(tournament); badge.className = `directory-status directory-status-${tournament.cancelled_at ? "cancelled" : tournament.status === "archived" ? "finished" : tournament.status === "ongoing" ? "ongoing" : tournament.published_at ? "upcoming" : "draft"}`;
  text("tournament-datetime", `${dateTime(tournament.starts_at, tournament.timezone)}${tournament.ends_at ? ` — ${dateTime(tournament.ends_at, tournament.timezone)}` : ""}`);
  text("tournament-city", tournament.city); text("tournament-venue", tournament.venue_name); text("tournament-address", tournament.venue_address);
  text("tournament-organizer", tournament.organizer_name); text("tournament-format", formatName(tournament.format)); text("tournament-cadence", cadence(tournament.rating_type));
  text("tournament-round-count", String(tournament.rounds_planned)); text("tournament-player-count", String(state.players.length));
  text("tournament-updated", dateTime(tournament.last_activity_at ?? tournament.updated_at, tournament.timezone));
  const poster = el("tournament-poster"); poster.hidden = !tournament.poster_url; if (tournament.poster_url) poster.src = tournament.poster_url;
  renderOverview(payload); renderPlayers(payload); renderStandings(payload);
  text("info-address", [tournament.venue_name, tournament.venue_address, tournament.city].filter(Boolean).join(" · "));
  text("info-organizer", tournament.organizer_name); text("info-contact", tournament.public_contact_email);
}

export function activateTournamentTab(identifier, tab, round = null) {
  for (const button of el("tournament-tabs").querySelectorAll("button")) {
    const active = button.dataset.tab === tab; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".tournament-tab-panel")) panel.hidden = panel.dataset.panel !== tab;
  history.replaceState(null, "", `${location.pathname}${location.search}${tournamentTabUrl(identifier, tab, round)}`);
}
