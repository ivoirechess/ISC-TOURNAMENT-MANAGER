function compact(values) { return [...new Set(values.map((value) => value?.trim()).filter(Boolean))]; }

export function normalizedPlayerName(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]+/g, " ").trim();
}

export function invertedPlayerName(value) {
  return normalizedPlayerName(value).split(" ").filter(Boolean).reverse().join(" ");
}

export function preferredMergeTarget(first, second) {
  if (Boolean(first?.fide_id) !== Boolean(second?.fide_id)) return first?.fide_id ? first : second;
  return first;
}

/** Pure preview only: the database remains authoritative for the transaction. */
export function previewPlayerMerge(source, target, choices = {}) {
  if (!source || !target || source.id === target.id) throw new Error("Deux fiches distinctes sont obligatoires.");
  if (source.fide_id && !target.fide_id) throw new Error("La fiche FIDE doit être conservée comme fiche principale.");
  const official = target.fide_id ? target : source.fide_id ? source : null;
  const localClub = choices.club ?? target.club ?? source.club ?? null;
  const localClubId = choices.club_id ?? target.club_id ?? source.club_id ?? null;
  return {
    ...target,
    fide_id: official?.fide_id ?? null,
    name: official?.name ?? target.name,
    federation: official?.federation ?? target.federation ?? source.federation ?? null,
    fide_title: official?.fide_title ?? null,
    rating_std: official ? official.rating_std ?? null : target.rating_std ?? source.rating_std ?? null,
    rating_rapid: official ? official.rating_rapid ?? null : target.rating_rapid ?? source.rating_rapid ?? null,
    rating_blitz: official ? official.rating_blitz ?? null : target.rating_blitz ?? source.rating_blitz ?? null,
    club: localClub, club_id: localClubId,
    local_notes: compact([target.local_notes, source.local_notes]).join("\n") || null,
    aliases: compact([...(target.aliases ?? []), ...(source.aliases ?? []), source.name, target.name]),
  };
}
