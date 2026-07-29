// Home-page tournament listing rules. PURE LOGIC — no DOM, no Supabase.

// UI labels for the enums stored in the database (interface is French).
export const STATUS_LABELS = {
  draft: "Brouillon",
  ongoing: "En cours",
  archived: "Archivé",
};

/**
 * Number of registered players on a tournament row as returned by
 * src/data.js, where tournament_players carries a PostgREST count
 * aggregate: [{ count: n }]. Defensive: 0 when the shape is missing.
 */
export function playerCount(row) {
  const aggregate = row?.tournament_players;
  if (Array.isArray(aggregate) && Number.isInteger(aggregate[0]?.count)) {
    return aggregate[0].count;
  }
  return 0;
}

function byNewestFirst(a, b) {
  const dateA = a.created_at ?? "";
  const dateB = b.created_at ?? "";
  if (dateA < dateB) return 1;
  if (dateA > dateB) return -1;
  // Deterministic final order for identical timestamps.
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Splits tournaments into the two home sections, newest first:
 *   current  — ongoing and draft tournaments
 *   archives — archived tournaments
 * Rows with an unknown status are ignored rather than misfiled.
 */
export function groupTournaments(rows) {
  const current = [];
  const archives = [];
  for (const row of rows ?? []) {
    if (row.status === "ongoing" || row.status === "draft") current.push(row);
    else if (row.status === "archived") archives.push(row);
  }
  current.sort(byNewestFirst);
  archives.sort(byNewestFirst);
  return { current, archives };
}
