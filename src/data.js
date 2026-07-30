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
import { normalizedPlayerName } from "./player-merge.js";

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

/**
 * Opens the session an invitation (or password-reset) e-mail link carries.
 *
 * The tokens are read out of the URL by src/ui/password-setup.js before the
 * client is ever created, so `detectSessionInUrl` finds nothing to do and the
 * session is opened here, explicitly. Neither token is logged, and neither
 * appears in the message a failure produces.
 */
export async function setSessionFromEmailLink({ accessToken, refreshToken }) {
  if (!accessToken || !refreshToken) {
    throw new Error("Ce lien est incomplet ou a deja ete utilise.");
  }
  const client = await getClient();
  const { data, error } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error || !data?.session) {
    throw new Error("Ce lien a expire ou a deja ete utilise.");
  }
  return data.session;
}

/**
 * Sets the password of the signed-in user.
 *
 * The password never leaves this call: it is not logged, not stored, and not
 * echoed back in any error. Supabase's own codes are translated rather than
 * shown, so a failure cannot surface the value that caused it.
 */
export async function updatePassword(password) {
  const client = await getClient();
  const { error } = await client.auth.updateUser({ password });
  if (!error) return;
  if (error.code === "weak_password") {
    throw new Error("Ce mot de passe est trop faible. Choisissez-en un plus long ou moins courant.");
  }
  if (error.code === "same_password") {
    throw new Error("Choisissez un mot de passe different de l'ancien.");
  }
  if (error.code === "session_not_found" || error.status === 401) {
    throw new Error("Votre lien n'est plus valide. Demandez au super-administrateur de vous en renvoyer un.");
  }
  throw new Error("L'enregistrement du mot de passe a echoue. Reessayez.");
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

export async function getCurrentClubIds() {
  const client=await getClient();const {data:{user}}=await client.auth.getUser();if(!user)return [];
  const {data,error}=await client.from("club_memberships").select("club_id").eq("user_id",user.id).eq("active",true);
  if(error)return [];return (data??[]).map(row=>row.club_id);
}

// ---------------------------------------------------------------------------
// Players directory
// ---------------------------------------------------------------------------

/** All players, sorted by name. Publicly readable. */
export async function listPlayers() {
  const client = await getClient();
  const { data, error } = await client
    .from("players")
    .select("id, name, fide_id, club, club_id, fide_title, rating_std, rating_rapid, rating_blitz")
    .is("merged_into", null)
    .order("name");
  if (error) {
    throw new Error("Impossible de charger l'annuaire des joueurs.");
  }
  return data ?? [];
}

export async function listClubs() {
  const client=await getClient(); const {data,error}=await client.from("clubs").select("id,name,slug,logo_url,city,description,public_email,public_phone,website_url,active").order("name");
  if(error) throw new Error("Impossible de charger les clubs."); return data??[];
}

export async function listClubsForAdministration({activeOnly=false}={}) {
  const client=await getClient();
  let request=client.from("clubs").select("id,name,slug,logo_url,city,description,public_email,public_phone,website_url,active").order("name");
  if(activeOnly)request=request.eq("active",true);
  const {data,error}=await request;
  if(error)throw new Error("Impossible de charger les clubs.");
  return data??[];
}

export async function resolveOrCreateClub({name,city=null}) {
  const client=await getClient();const {data,error}=await client.rpc("resolve_or_create_club",{p_name:name,p_city:city});
  if(error)throw new Error(error.message||"La création du club a échoué.");return Array.isArray(data)?data[0]:data;
}

export async function createClub(fields) {
  const name=fields.name?.trim();if(!name)throw new Error("Le nom du club est obligatoire.");
  const client=await getClient();const {data,error}=await client.from("clubs").insert({
    name,slug:slugifyClubName(name),city:fields.city?.trim()||null,description:fields.description?.trim()||null,
    public_email:fields.publicEmail?.trim()||null,public_phone:fields.publicPhone?.trim()||null,
    website_url:fields.websiteUrl?.trim()||null,logo_url:fields.logoUrl?.trim()||null,active:fields.active!==false,
  }).select("id,name,slug,city,active").single();
  if(error)throw new Error(error.message||"La création complète du club a échoué.");return data;
}

export async function updateClub(id,fields) {
  const client=await getClient();const {data,error}=await client.from("clubs").update(fields).eq("id",id).select().single();
  if(error)throw new Error("La modification du club a échoué.");return data;
}

function slugifyClubName(value){return value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}

export async function getClub(slug) {
  const client=await getClient();const {data,error}=await client.from("clubs")
    .select("id,name,slug,logo_url,city,description,public_email,public_phone,website_url,active,tournaments(id,name,slug,status,published_at,starts_at,finished_at)")
    .eq("slug",slug).maybeSingle();
  if(error) throw new Error("Impossible de charger ce club.");return data??null;
}

export async function getClubAdministration() {
  const client=await getClient();
  const [{data:invitations,error:invitationError},{data:memberships,error:membershipError},{data:clubs,error:clubError}]=await Promise.all([
    client.from("admin_invitations").select("id,email,status,club_id,created_at,expires_at,last_sent_at,sent_count,last_error,clubs(name)").order("created_at",{ascending:false}),
    client.from("club_memberships").select("club_id,user_id,role,active,created_at,profiles(display_name),clubs(name)").order("created_at",{ascending:false}),
    client.from("clubs").select("id,name,city,active").order("name"),
  ]);
  if(invitationError||membershipError||clubError) throw new Error("Administration des clubs inaccessible.");
  return {invitations:invitations??[],memberships:memberships??[],clubs:clubs??[]};
}

export async function inviteAdminAction(action,fields={}) {
  const client=await getClient();const {data,error}=await client.functions.invoke("invite-admin",{body:{action,...fields}});
  if(error) throw new Error(data?.error||error.message||"Action impossible.");return data;
}

/** Server-paginated public player directory. */
export async function listPlayersPage({page=1,pageSize=25,query="",title="",active="",clubId="",rated="",sort="rating_std"}={}) {
  const client=await getClient();
  const allowedSort=["rating_std","rating_rapid","rating_blitz","name"];
  let request=client.from("players").select("id,name,fide_id,federation,fide_title,other_titles,fide_active,club,club_id,rating_std,rating_rapid,rating_blitz,updated_at,clubs(name)",{count:"exact"}).is("merged_into",null);
  const term=query.trim();
  if(term) {
    if(/^\d+$/.test(term)) request=request.eq("fide_id",Number(term));
    else {const safe=term.replaceAll(",","");const {data:aliases}=await client.from("player_aliases").select("player_id").ilike("alias",`%${safe}%`);const ids=(aliases??[]).map(row=>row.player_id).join(",");request=request.or(`name.ilike.%${safe}%,club.ilike.%${safe}%${ids?`,id.in.(${ids})`:""}`)}
  }
  if(title) request=request.eq("fide_title",title);
  if(active!=="") request=request.eq("fide_active",active==="true");
  if(clubId) request=request.eq("club_id",clubId);
  if(rated==="rated") request=request.or("rating_std.gt.0,rating_rapid.gt.0,rating_blitz.gt.0");
  if(rated==="unrated") request=request.or("rating_std.is.null,rating_std.eq.0").or("rating_rapid.is.null,rating_rapid.eq.0").or("rating_blitz.is.null,rating_blitz.eq.0");
  const order=allowedSort.includes(sort)?sort:"rating_std";
  const from=(page-1)*pageSize; request=request.order(order,{ascending:order==="name",nullsFirst:false}).range(from,from+pageSize-1);
  const {data,error,count}=await request; if(error) throw new Error("Impossible de charger l'annuaire des joueurs.");
  return {players:data??[],count:count??0,page,pageSize};
}

export async function getPlayerProfile(identifier) {
  const client=await getClient();
  let request=client.from("players").select("id,name,fide_id,federation,fide_title,other_titles,sex,birth_year,fide_active,source_period,fide_synced_at,club,club_id,local_notes,rating_std,rating_rapid,rating_blitz,official_fide_data,local_overrides,updated_at,merged_into,clubs(id,name),player_aliases(alias),tournament_players(tournaments(id,slug,name,status,published_at,started_at,finished_at,cancelled_at,starts_at))");
  request=/^\d+$/.test(identifier)?request.eq("fide_id",Number(identifier)):request.eq("id",identifier);
  const {data,error}=await request.maybeSingle(); if(error) throw new Error("Impossible de charger ce joueur.");
  if(data?.merged_into){const target=await getPlayerProfile(data.merged_into);return target?{...target,redirectedFrom:data.id}:null} return data??null;
}

export async function findPlayerDuplicates({name,fideId=null,club=null,ratingStd=null}) {
  const client=await getClient();const {data,error}=await client.rpc("find_player_duplicates",{search_name:name,search_fide_id:fideId,search_club:club,search_rating:ratingStd});
  if(error) throw new Error("La recherche de doublons a échoué.");return data??[];
}

export async function previewPlayerMerge(source,target,choices={}) {
  const {previewPlayerMerge:preview}=await import("./player-merge.js");return preview(source,target,choices);
}

export async function editPlayerAsSuperAdmin(playerId,changes,reason) {
  const client=await getClient();const {data,error}=await client.rpc("edit_player_as_super_admin",{p_player_id:playerId,p_changes:changes,p_reason:reason});
  if(error){const readable=new Error(error.message||"La modification du joueur a échoué.");const match=error.message?.match(/CONFLICT_PLAYER:([0-9a-f-]+)/i);if(match)readable.conflictingPlayer=await getPlayerProfile(match[1]);throw readable}return data;
}

export async function mergePlayers({sourceId,targetId,reason}) {
  const client=await getClient();const {data,error}=await client.rpc("merge_players",{source_id:sourceId,target_id:targetId,reason});
  if(error) throw new Error(error.message||"La fusion a échoué.");return data;
}

/** Local fields only: never writes synchronized FIDE identity/rating fields. */
export async function updatePlayerLocal(id,{clubId=null,club=null,localNotes=null}) {
  const client=await getClient();let canonical=null;
  if(clubId){const {data,error}=await client.from("clubs").select("id,name").eq("id",clubId).eq("active",true).single();if(error)throw new Error("Club actif introuvable.");canonical=data}
  const {data,error}=await client.from("players").update({club_id:canonical?.id||null,club:canonical?.name||null,local_notes:localNotes?.trim()||null}).eq("id",id).select("id,club,club_id");
  if(error||!data?.length) throw new Error("Modification locale refusee."); return data[0];
}

export async function createPlayerWithClub(fields) {
  const name=(fields.name??"").trim();if(!name)throw new Error("Le nom du joueur est obligatoire.");
  const client=await getClient();const {data,error}=await client.rpc("create_player_with_club",{
    p_name:name,p_club_id:fields.clubId||null,p_club_name:fields.clubName?.trim()||null,p_club_city:fields.clubCity?.trim()||null,
    p_fide_id:Number.isInteger(fields.fide_id)?fields.fide_id:null,p_rating_std:Number.isInteger(fields.rating_std)?fields.rating_std:null,
  });
  if(error)throw new Error(error.message||"L'ajout transactionnel du joueur a échoué.");return data;
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
  const row = { name, normalized_name: normalizedPlayerName(name) };
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
export async function createTournament({
  name, description, startsAt, city, venueName, venueAddress, organizerName,
  publicContactEmail, posterUrl, format, cadence,
  timeControlText, rankingType, fideRated, maxPlayers, roundsPlanned,
  playerIds, tiebreaks, publishNow = false, requestId = crypto.randomUUID(),
}) {
  const tiebreakCheck = validateTiebreakSelection(tiebreaks);
  if (!tiebreakCheck.ok) throw new Error(tiebreakCheck.errors.join(" "));
  const schedule = isRoundRobin(format)
    ? generateSchedule(playerIds, { doubled: format === "double_round_robin" })
    : null;
  const client = await getClient();
  const { data, error } = await client.rpc("create_tournament_with_players", {
    request_id: requestId,
    tournament_data: {
      name: name.trim(), description, starts_at: startsAt, city,
      venue_name: venueName, venue_address: venueAddress,
      organizer_name: organizerName, public_contact_email: publicContactEmail,
      poster_url: posterUrl, format,
      rating_type: cadence, time_control_text: timeControlText,
      ranking_type: rankingType, fide_rated: fideRated,
      max_players: maxPlayers, rounds_planned: schedule?.length ?? roundsPlanned,
      tiebreaks,
    },
    player_ids: playerIds,
    schedule,
    publish_now: publishNow,
  });
  if (error) throw new Error(editErrorMessage(error, "La creation transactionnelle du tournoi a echoue."));
  return data;
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
    .select("id, name, slug, format, rounds_planned, status, created_by, created_at, updated_at, last_activity_at, published_at, started_at, finished_at, cancelled_at, starts_at, ends_at, city, venue_name, organizer_name, rating_type, tournament_players(count), registrations:tournament_players(players(club))")
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

/** Validates a complete round and atomically releases the next calendar round. */
export async function validateRound(roundId) {
  return callTransition("validate_round", { r_id: roundId }, "La validation de la ronde a echoue.");
}

/** Exceptional super-admin operation; rollback removes all later rounds. */
export async function reopenRound(roundId, reason, rollbackFollowing = false) {
  return callTransition(
    "reopen_round",
    { r_id: roundId, reason, rollback_following: rollbackFollowing },
    "La reouverture de la ronde a echoue."
  );
}

/** Reopens an archived tournament and, normally, its last validated round. */
export async function reopenTournament(id, reason, reopenLastRound = true) {
  return callTransition("reopen_tournament", {
    p_tournament_id: id,
    p_reason: reason,
    p_reopen_last_round: reopenLastRound,
  }, "La reouverture du tournoi a echoue.");
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
export async function softDeleteTournament(id, reason = null, confirmationName = null) {
  const client = await getClient();
  const { error } = await client.rpc("soft_delete_tournament", {
    t_id: id, p_reason: reason, p_confirmation_name: confirmationName,
  });
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
  const { data: round, error } = await client.rpc("create_swiss_round", {
    t_id: tournamentId,
    round_number: number,
    pairing_rows: pairings,
  });
  if (error) {
    throw new Error(editErrorMessage(error, "La creation de la ronde a echoue."));
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
export async function onPairingsChange(callback, statusCallback = () => {}) {
  const client = await getClient();
  const channel = client
    .channel("pairings-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pairings" },
      (payload) => callback(payload)
    )
    .subscribe((status) => statusCallback(status));
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
  let query = client
    .from("tournaments")
    .select(
      "id, name, slug, format, rounds_planned, status, created_at, created_by, club_id, tiebreaks, " +
      "published_at, started_at, finished_at, cancelled_at, cancellation_reason, " +
      "starts_at, ends_at, timezone, venue_name, venue_address, city, organizer_name, description, " +
      "public_contact_email, poster_url, rating_type, updated_at, last_activity_at, " +
      "tournament_players(withdrawn, players(id, name, title, fide_id, federation, club, rating_std, rating_rapid, rating_blitz)), " +
      "rounds(id, number, released_at, validated_at, validated_by, pairings(id, board, white_player_id, black_player_id, result))"
    )
    .is("deleted_at", null);
  const isUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
  query = isUuid ? query.eq("id", id) : query.eq("slug", id);
  const { data, error } = await query.maybeSingle();
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
      title: entry.players.title,
      fide_id: entry.players.fide_id,
      federation: entry.players.federation,
      club: entry.players.club,
      rating_std: entry.players.rating_std,
      rating_rapid: entry.players.rating_rapid,
      rating_blitz: entry.players.rating_blitz,
      withdrawn: entry.withdrawn === true,
    }));

  // PostgREST does not promise an order on embedded rows, so both levels are
  // sorted here: the cumulative tie-break reads rounds in sequence.
  const rounds = [...(data.rounds ?? [])]
    .filter(
      (round) =>
        round.released_at ||
        (data.status === "draft" && round.number === 1)
    )
    .sort((a, b) => a.number - b.number)
    .map((round) => ({
      id: round.id,
      number: round.number,
      released_at: round.released_at,
      validated_at: round.validated_at,
      validated_by: round.validated_by,
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
