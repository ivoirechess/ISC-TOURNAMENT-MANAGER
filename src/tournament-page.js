// Pure presentation rules for the public tournament page.
export const TOURNAMENT_TABS = ["overview", "players", "pairings", "standings", "information"];

export function resolveTournamentTab(value) {
  return TOURNAMENT_TABS.includes(value) ? value : "overview";
}

export function tournamentTabUrl(identifier, tab, round = null) {
  const params = new URLSearchParams();
  const selected = resolveTournamentTab(tab);
  if (selected !== "overview") params.set("onglet", selected);
  if (Number.isInteger(round) && round > 0) params.set("ronde", String(round));
  const query = params.toString();
  return `#/tournoi/${encodeURIComponent(identifier)}${query ? `?${query}` : ""}`;
}

export function primaryRating(player, ratingType) {
  const key = ratingType === "rapid" ? "rating_rapid" : ratingType === "blitz" ? "rating_blitz" : "rating_std";
  const value = player?.[key];
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function initialRanking(players, ratingType) {
  return [...(players ?? [])]
    .sort((a, b) => (primaryRating(b, ratingType) ?? -1) - (primaryRating(a, ratingType) ?? -1) ||
      String(a.name).localeCompare(String(b.name), "fr"))
    .map((player, index) => ({ ...player, initialRank: index + 1, elo: primaryRating(player, ratingType) }));
}

export function tournamentProgress(tournament, rounds) {
  const planned = tournament?.rounds_planned ?? 0;
  const validated = (rounds ?? []).filter((round) => round.validated_at).length;
  const active = (rounds ?? []).find((round) => round.released_at && !round.validated_at) ?? null;
  return { validated, planned, percent: planned > 0 ? Math.round((validated / planned) * 100) : 0, nextRound: active?.number ?? null };
}

export function canShowOrganizerPanel(tournament, role, userId, clubIds = []) {
  return role === "super_admin" || (role === "admin" && Boolean(userId) &&
    (tournament?.created_by === userId || Boolean(tournament?.club_id && clubIds.includes(tournament.club_id))));
}
