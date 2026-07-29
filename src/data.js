// SINGLE module talking to Supabase (CLAUDE.md rule). Every other file goes
// through the functions exported here; none imports the Supabase client.
//
// The client library is loaded lazily from a CDN ES module: the static site
// has no build step, and Node tests can import this module without any
// network access as long as they don't call the functions below.

import { getSupabaseEnv } from "./config.js";
import { generateSchedule } from "./roundrobin.js";
import { isRoundRobin } from "./tournament-validation.js";
import { validateTiebreakSelection } from "./tiebreaks.js";
import { validateTournamentName, GAME_RESULTS } from "./tournament-edit.js";

// Version pinned exactly: an unpinned tag would let the CDN swap the code
// that handles organizer passwords without any visible change here.
const SUPABASE_JS_CDN = "https://esm.sh/@supabase/supabase-js@2.111.0";

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { url, anonKey } = getSupabaseEnv();
      const { createClient } = await import(SUPABASE_JS_CDN);
      return createClient(url, anonKey);
    })();
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
// Email/password only. There is NO public sign-up: admin accounts are
// created by hand in Supabase, never by the site.

/**
 * Signs in with email/password. Resolves with the session, or throws a
 * user-displayable French message.
 */
export async function signIn(email, password) {
  const client = await getClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error("Connexion refusee : identifiants invalides.");
  }
  return data.session;
}

/** Signs the current user out. */
export async function signOut() {
  const client = await getClient();
  const { error } = await client.auth.signOut();
  if (error) {
    throw new Error("La deconnexion a echoue. Reessayez.");
  }
}

/** Current session, or null when browsing anonymously. */
export async function getSession() {
  const client = await getClient();
  const { data } = await client.auth.getSession();
  return data.session ?? null;
}

/**
 * Subscribes to session changes (sign-in, sign-out, token refresh).
 * The callback receives the session or null. Returns an unsubscribe function.
 */
export async function onAuthChange(callback) {
  const client = await getClient();
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    callback(session ?? null);
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Id of the signed-in user, or null when browsing anonymously. Used to tell
 * an organizer their own tournaments apart from the rest — an interface
 * comfort, never a protection: `created_by` is compared server-side by every
 * policy that matters.
 */
export async function getCurrentUserId() {
  const client = await getClient();
  const { data } = await client.auth.getUser();
  return data?.user?.id ?? null;
}

/**
 * Role of the signed-in user as stored in profiles ('admin',
 * 'super_admin'), or null for anonymous visitors and accounts without a
 * profile row. The UI must rely on this, not on mere session presence —
 * and RLS remains the actual protection either way.
 */
export async function getCurrentRole() {
  const client = await getClient();
  const { data: userData } = await client.auth.getUser();
  const user = userData?.user;
  if (!user) return null;

  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (error || !data) return null;
  return data.role;
}

// ---------------------------------------------------------------------------
// Players directory
// ---------------------------------------------------------------------------

/** All players, sorted by name. Publicly readable. */
export async function listPlayers() {
  const client = await getClient();
  const { data, error } = await client
    .from("players")
    .select("id, name, fide_id, club, rating_std, rating_rapid, rating_blitz")
    .order("name");
  if (error) {
    throw new Error("Impossible de charger l'annuaire des joueurs.");
  }
  return data ?? [];
}

/**
 * Adds a player to the shared directory. Only name is required; RLS
 * restricts this to admins.
 * @param {{name: string, club?: string, fide_id?: number, rating_std?: number}} fields
 */
export async function createPlayer(fields) {
  const name = (fields.name ?? "").trim();
  if (name === "") {
    throw new Error("Le nom du joueur est obligatoire.");
  }
  const row = { name };
  if (fields.club) row.club = fields.club.trim();
  if (Number.isInteger(fields.fide_id)) row.fide_id = fields.fide_id;
  if (Number.isInteger(fields.rating_std)) row.rating_std = fields.rating_std;

  const client = await getClient();
  const { data, error } = await client.from("players").insert(row).select().single();
  if (error) {
    throw new Error("L'ajout du joueur a echoue (droits insuffisants ou ID FIDE deja utilise).");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tournaments
// ---------------------------------------------------------------------------

/**
 * Creates a draft tournament owned by the signed-in admin and registers
 * its players. RLS enforces the role and ownership rules server-side.
 * @param {{name: string, format: string, roundsPlanned: number, playerIds: string[], tiebreaks: string[]}} draft
 * @returns the created tournament row
 */
export async function createTournament({ name, format, roundsPlanned, playerIds, tiebreaks }) {
  const client = await getClient();
  const { data: userData } = await client.auth.getUser();
  const user = userData?.user;
  if (!user) {
    throw new Error("Connectez-vous pour creer un tournoi.");
  }

  // Checked before writing anything: the same rule is enforced by a CHECK
  // constraint on the column, this only turns it into a readable message.
  const tiebreakCheck = validateTiebreakSelection(tiebreaks);
  if (!tiebreakCheck.ok) {
    throw new Error(tiebreakCheck.errors.join(" "));
  }

  // Built before the first write on purpose: generateSchedule rejects an
  // invalid field by throwing, and an exception raised after the tournament
  // row exists would escape the rollback below and strand a ghost draft.
  const schedule = isRoundRobin(format)
    ? generateSchedule(playerIds, { doubled: format === "double_round_robin" })
    : null;

  const { data: tournament, error } = await client
    .from("tournaments")
    .insert({
      name: name.trim(),
      format,
      // For circle formats the schedule decides, not the caller: browser-side
      // validation is a convenience, so trusting roundsPlanned here would let
      // a tournament advertise 3 rounds while 9 are actually written.
      rounds_planned: schedule ? schedule.length : roundsPlanned,
      status: "draft",
      created_by: user.id,
      tiebreaks,
    })
    .select()
    .single();
  if (error) {
    throw new Error("La creation du tournoi a echoue (droits insuffisants ?).");
  }

  // Rolls the whole creation back; rounds and pairings go with the
  // tournament through ON DELETE CASCADE.
  const abort = async (message) => {
    // An admin has no real DELETE on tournaments any more: rolling back a
    // half-created tournament marks it deleted instead, which hides it from
    // everyone. A super_admin clears it from the trash.
    const { error: cleanupError } = await client.rpc("soft_delete_tournament", {
      t_id: tournament.id,
    });
    throw new Error(
      cleanupError
        ? `${message} Le brouillon n'a pas pu etre supprime : retrouvez-le sur ` +
          "la page d'accueil pour le supprimer ou reessayer."
        : `${message} Le tournoi n'a pas ete cree.`
    );
  };

  const rows = playerIds.map((playerId) => ({
    tournament_id: tournament.id,
    player_id: playerId,
  }));
  const { error: tpError } = await client.from("tournament_players").insert(rows);
  if (tpError) {
    await abort("L'inscription des joueurs a echoue.");
  }

  // Round-robin formats are fully determined by the field, so the schedule
  // built above is written now. Swiss pairings depend on results and are
  // drawn round by round instead (src/swiss.js, Phase 4).
  if (schedule) {
    const { data: rounds, error: roundsError } = await client
      .from("rounds")
      .insert(schedule.map((_, index) => ({
        tournament_id: tournament.id,
        number: index + 1,
      })))
      .select("id, number");
    if (roundsError) {
      await abort("La generation du calendrier a echoue.");
    }

    const roundIdByNumber = new Map(rounds.map((r) => [r.number, r.id]));
    const pairingRows = schedule.flatMap((round, index) =>
      round.map((pairing, board) => ({
        round_id: roundIdByNumber.get(index + 1),
        white_player_id: pairing.white,
        black_player_id: pairing.black,
        result: pairing.result,
        board: board + 1,
      }))
    );
    const { error: pairingsError } = await client.from("pairings").insert(pairingRows);
    if (pairingsError) {
      await abort("L'enregistrement des appariements a echoue.");
    }
  }

  return tournament;
}

/**
 * All tournaments with their registered-player count, for the public home
 * page. tournament_players comes back as a PostgREST count aggregate:
 * [{ count: n }].
 */
export async function listTournaments() {
  const client = await getClient();
  const { data, error } = await client
    .from("tournaments")
    .select("id, name, slug, format, rounds_planned, status, created_at, published_at, started_at, finished_at, cancelled_at, starts_at, city, tournament_players(count)")
    // RLS hides deleted tournaments from everyone but a super_admin, who
    // would otherwise see them mixed into the public listings.
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error("Impossible de charger la liste des tournois.");
  }
  return data ?? [];
}

/** One tournament with its registered players, or null when not found. */
export async function getTournament(id) {
  const client = await getClient();
  const { data, error } = await client
    .from("tournaments")
    .select("id, name, format, rounds_planned, status, created_at, tiebreaks, tournament_players(player_id, withdrawn, players(id, name, club, rating_std))")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error("Impossible de charger ce tournoi.");
  }
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Editing an existing tournament
// ---------------------------------------------------------------------------
// RLS restricts these writes to the owning admin or a super_admin, and
// database triggers hold the rules a policy cannot express (round count
// frozen once launched, pairings never moved). What follows only turns a
// refusal into a readable message.

// Under RLS a forbidden UPDATE is not an error: it simply matches no row.
// Asking for the updated rows back is the only way to tell the difference.
function assertUpdated(rows, forbiddenMessage) {
  if (!rows?.length) {
    throw new Error(forbiddenMessage);
  }
  return rows[0];
}

// Our own triggers raise SQLSTATE ISC01 with a French message meant to be
// read. Anything else is a raw PostgreSQL error naming relations and
// constraints, so it gets the generic wording every other call here uses.
const APP_ERROR_CODE = "ISC01";

function editErrorMessage(error, fallback) {
  return error?.code === APP_ERROR_CODE && error.message ? error.message : fallback;
}

/** Renames a tournament. Allowed at any stage. */
export async function renameTournament(id, name) {
  const check = validateTournamentName(name);
  if (!check.ok) throw new Error(check.errors.join(" "));

  const client = await getClient();
  const { data, error } = await client
    .from("tournaments")
    .update({ name: name.trim() })
    .eq("id", id)
    .select("id, name");
  if (error) {
    throw new Error("Le renommage a echoue.");
  }
  return assertUpdated(data, "Vous n'avez pas le droit de renommer ce tournoi.");
}

/**
 * Changes the planned round count. A trigger refuses it once the tournament
 * has rounds and on round-robin formats, so a stale screen cannot force it.
 */
export async function updateRoundsPlanned(id, roundsPlanned) {
  if (!Number.isInteger(roundsPlanned) || roundsPlanned < 1) {
    throw new Error("Le nombre de rondes doit etre un entier superieur ou egal a 1.");
  }
  const client = await getClient();
  const { data, error } = await client
    .from("tournaments")
    .update({ rounds_planned: roundsPlanned })
    .eq("id", id)
    .select("id, rounds_planned");
  if (error) {
    throw new Error(
      editErrorMessage(error, "La modification du nombre de rondes a echoue.")
    );
  }
  return assertUpdated(data, "Vous n'avez pas le droit de modifier ce tournoi.");
}

/**
 * Corrects an already-entered result. Only `result` is sent: a trigger
 * rejects any attempt to move the pairing itself.
 */
export async function updatePairingResult(pairingId, result) {
  // Checked here as well as on screen: a bye is not a game, and clearing a
  // result is not what "correcting an entry" means.
  if (!GAME_RESULTS.includes(result)) {
    throw new Error("Resultat invalide.");
  }
  const client = await getClient();
  const { data, error } = await client
    .from("pairings")
    .update({ result })
    .eq("id", pairingId)
    .select("id, result");
  if (error) {
    throw new Error(editErrorMessage(error, "La correction du resultat a echoue."));
  }
  return assertUpdated(data, "Vous n'avez pas le droit de corriger ce resultat.");
}

// ---------------------------------------------------------------------------
// Life-cycle transitions
// ---------------------------------------------------------------------------
// Each one is a database function rather than an UPDATE: several must check
// state and write atomically, and unpublishing has to hide the row from its
// own author, which PostgreSQL forbids through an UPDATE under RLS. The
// functions re-check ownership themselves.

async function callTransition(name, args, fallback) {
  const client = await getClient();
  const { data, error } = await client.rpc(name, args);
  if (error) {
    // The transitions raise ISC01 with French messages meant to be read;
    // editErrorMessage passes those through and keeps the rest generic.
    throw new Error(editErrorMessage(error, fallback));
  }
  return data;
}

/** Makes a draft public. Returns the publication timestamp. */
export async function publishTournament(id) {
  return callTransition("publish_tournament", { t_id: id }, "La publication a echoue.");
}

/** Takes an announced tournament back off the site. Only before it starts. */
export async function unpublishTournament(id) {
  return callTransition("unpublish_tournament", { t_id: id }, "La depublication a echoue.");
}

/**
 * Starts the tournament: state, timestamps and — in Swiss — round 1 with
 * its pairings, all in one transaction. Returns the active player count.
 */
export async function startTournament(id) {
  return callTransition("start_tournament", { t_id: id }, "Le demarrage a echoue.");
}

/** Closes a running tournament; its standings become final. */
export async function finishTournament(id) {
  return callTransition("finish_tournament", { t_id: id }, "La cloture a echoue.");
}

/** Cancels a tournament, with an optional reason shown on its page. */
export async function cancelTournament(id, reason) {
  return callTransition(
    "cancel_tournament",
    { t_id: id, reason: reason ?? null },
    "L'annulation a echoue."
  );
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------
// An admin never destroys a tournament: deleting marks `deleted_at`. Only a super_admin sees
// the trash, restores from it, or clears it for good.

/**
 * Marks a tournament deleted. Goes through a database function rather than
 * an UPDATE, because PostgreSQL refuses a write that would make the row
 * invisible to its own author — see the migration for the full reason. The
 * function re-checks ownership itself, so this is no less guarded.
 */
export async function softDeleteTournament(id) {
  const client = await getClient();
  const { error } = await client.rpc("soft_delete_tournament", { t_id: id });
  if (error) {
    throw new Error(editErrorMessage(error, "La suppression a echoue."));
  }
}

/** Tournaments in the trash. Only a super_admin can read these rows. */
export async function listDeletedTournaments() {
  const client = await getClient();
  const { data, error } = await client
    .from("tournaments")
    .select("id, name, format, rounds_planned, status, created_at, deleted_at")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) {
    throw new Error("Impossible de charger la corbeille.");
  }
  return data ?? [];
}

/** Puts a tournament back. Super_admin only, enforced by RLS. */
export async function restoreTournament(id) {
  const client = await getClient();
  const { data, error } = await client
    .from("tournaments")
    .update({ deleted_at: null })
    .eq("id", id)
    .select("id, name");
  if (error) {
    throw new Error(editErrorMessage(error, "La restauration a echoue."));
  }
  return assertUpdated(data, "Seul un super-admin peut restaurer un tournoi.");
}

/**
 * Destroys a tournament for good, with its rounds and pairings through the
 * cascade. Super_admin only: there is no DELETE policy for an admin.
 */
export async function purgeTournament(id) {
  const client = await getClient();
  const { data, error } = await client
    .from("tournaments")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) {
    throw new Error(editErrorMessage(error, "La suppression definitive a echoue."));
  }
  return assertUpdated(data, "Seul un super-admin peut supprimer definitivement un tournoi.");
}

/** Empties an entered result. Only meaningful while the tournament runs. */
export async function clearPairingResult(pairingId) {
  const client = await getClient();
  const { data, error } = await client
    .from("pairings")
    .update({ result: null })
    .eq("id", pairingId)
    .select("id, result");
  if (error) {
    throw new Error(editErrorMessage(error, "L'effacement du resultat a echoue."));
  }
  return assertUpdated(data, "Vous n'avez pas le droit d'effacer ce resultat.");
}

// ---------------------------------------------------------------------------
// Entering results
// ---------------------------------------------------------------------------

/**
 * Records a result on a pairing, whether or not it already had one. The
 * trigger lets only `result` move, so the pairing itself cannot shift.
 */
export async function setPairingResult(pairingId, result) {
  if (!GAME_RESULTS.includes(result)) {
    throw new Error("Resultat invalide.");
  }
  const client = await getClient();
  const { data, error } = await client
    .from("pairings")
    .update({ result })
    .eq("id", pairingId)
    .select("id, result");
  if (error) {
    throw new Error(editErrorMessage(error, "L'enregistrement du resultat a echoue."));
  }
  return assertUpdated(data, "Vous n'avez pas le droit de saisir ce resultat.");
}

/**
 * Writes a freshly drawn round with its pairings.
 * Rolls the round back if the pairings cannot follow, so a round never
 * exists without the games it was drawn for.
 * @param {{tournamentId: string, number: number, pairings: Array}} round
 */
export async function createRound({ tournamentId, number, pairings }) {
  const client = await getClient();
  const { data: round, error } = await client
    .from("rounds")
    .insert({ tournament_id: tournamentId, number })
    .select("id, number")
    .single();
  if (error) {
    throw new Error(editErrorMessage(error, "La creation de la ronde a echoue."));
  }

  const rows = pairings.map((pairing, index) => ({
    round_id: round.id,
    white_player_id: pairing.white,
    black_player_id: pairing.black,
    result: pairing.result ?? null,
    board: index + 1,
  }));
  const { error: pairingsError } = await client.from("pairings").insert(rows);
  if (pairingsError) {
    const { error: cleanupError } = await client
      .from("rounds")
      .delete()
      .eq("id", round.id)
      .select("id");
    throw new Error(
      editErrorMessage(
        pairingsError,
        cleanupError
          ? "Les appariements n'ont pas pu etre enregistres, et la ronde vide n'a pas pu etre retiree."
          : "Les appariements n'ont pas pu etre enregistres : la ronde n'a pas ete creee."
      )
    );
  }
  return round;
}

/**
 * Closes a tournament. Its standings stop moving from here on.
 *
 * Routed through finish_tournament rather than a direct UPDATE: the plain
 * update set `status` alone and left `finished_at` null, producing a
 * tournament that reads as finished without the timestamp the life cycle
 * defines it by.
 */
export async function archiveTournament(id) {
  return finishTournament(id);
}

/**
 * Calls back whenever a pairing changes, so spectators see results appear
 * without reloading.
 *
 * Realtime filters can only name a column of the table being watched, and
 * `pairings` carries `round_id`, not `tournament_id`. Rather than guess, the
 * subscription listens to the table and the caller reloads its own
 * tournament — cheap at club scale, and it cannot miss an event.
 *
 * Realtime applies the same RLS policies as any read, so a spectator is
 * only ever pushed rows they could already fetch.
 *
 * @returns {Promise<() => void>} unsubscribe
 */
export async function onPairingsChange(callback) {
  const client = await getClient();
  const channel = client
    .channel("pairings-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pairings" },
      (payload) => callback(payload)
    )
    .subscribe();
  return () => client.removeChannel(channel);
}

/**
 * A tournament with everything the standings need, reshaped into the state
 * the engines expect: { players: [{id, name}], rounds: [{pairings}] }.
 * Publicly readable, like every read here.
 * @returns {{tournament: object, state: object}|null}
 */
export async function getTournamentResults(id) {
  const client = await getClient();
  const { data, error } = await client
    .from("tournaments")
    .select(
      "id, name, slug, format, rounds_planned, status, created_at, created_by, tiebreaks, " +
      "published_at, started_at, finished_at, cancelled_at, cancellation_reason, " +
      "starts_at, ends_at, timezone, venue_name, city, organizer_name, description, " +
      "tournament_players(withdrawn, players(id, name)), " +
      "rounds(number, pairings(id, board, white_player_id, black_player_id, result))"
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error("Impossible de charger le classement de ce tournoi.");
  }
  if (!data) return null;

  // `withdrawn` travels with the player: the pairing engine must not draw a
  // player who has left the tournament.
  const players = (data.tournament_players ?? [])
    .filter((entry) => entry.players)
    .map((entry) => ({
      id: entry.players.id,
      name: entry.players.name,
      withdrawn: entry.withdrawn === true,
    }));

  // PostgREST does not promise an order on embedded rows, so both levels are
  // sorted here: the cumulative tie-break reads rounds in sequence.
  const rounds = [...(data.rounds ?? [])]
    .sort((a, b) => a.number - b.number)
    .map((round) => ({
      number: round.number,
      pairings: [...(round.pairings ?? [])]
        .sort((a, b) => (a.board ?? 0) - (b.board ?? 0))
        .map((pairing) => ({
          id: pairing.id,
          board: pairing.board,
          white: pairing.white_player_id,
          black: pairing.black_player_id,
          result: pairing.result,
        })),
    }));

  return { tournament: data, state: { players, rounds } };
}
