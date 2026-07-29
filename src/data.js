// SINGLE module talking to Supabase (CLAUDE.md rule). Every other file goes
// through the functions exported here; none imports the Supabase client.
//
// The client library is loaded lazily from a CDN ES module: the static site
// has no build step, and Node tests can import this module without any
// network access as long as they don't call the functions below.

import { getSupabaseEnv } from "./config.js";

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
 * @param {{name: string, format: string, roundsPlanned: number, playerIds: string[]}} draft
 * @returns the created tournament row
 */
export async function createTournament({ name, format, roundsPlanned, playerIds }) {
  const client = await getClient();
  const { data: userData } = await client.auth.getUser();
  const user = userData?.user;
  if (!user) {
    throw new Error("Connectez-vous pour creer un tournoi.");
  }

  const { data: tournament, error } = await client
    .from("tournaments")
    .insert({
      name: name.trim(),
      format,
      rounds_planned: roundsPlanned,
      status: "draft",
      created_by: user.id,
    })
    .select()
    .single();
  if (error) {
    throw new Error("La creation du tournoi a echoue (droits insuffisants ?).");
  }

  const rows = playerIds.map((playerId) => ({
    tournament_id: tournament.id,
    player_id: playerId,
  }));
  const { error: tpError } = await client.from("tournament_players").insert(rows);
  if (tpError) {
    // Leave no half-created tournament behind; RLS lets the owner delete it.
    const { error: cleanupError } = await client
      .from("tournaments")
      .delete()
      .eq("id", tournament.id);
    throw new Error(
      cleanupError
        ? "L'inscription des joueurs a echoue et le brouillon n'a pas pu etre supprime : " +
          "retrouvez-le sur la page d'accueil pour le supprimer ou reessayer."
        : "L'inscription des joueurs a echoue, le tournoi n'a pas ete cree."
    );
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
    .select("id, name, format, rounds_planned, status, created_at, tournament_players(count)")
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
    .select("id, name, format, rounds_planned, status, created_at, tournament_players(player_id, withdrawn, players(id, name, club, rating_std))")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error("Impossible de charger ce tournoi.");
  }
  return data ?? null;
}
