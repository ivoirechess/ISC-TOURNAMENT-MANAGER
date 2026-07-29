export const PLAYER_SORTS=["rating_std","rating_rapid","rating_blitz","name"];
export function normalizePlayerFilters(value={}) { return {query:String(value.query??"").trim(),title:String(value.title??""),active:["true","false"].includes(value.active)?value.active:"",clubId:String(value.clubId??""),rated:["rated","unrated"].includes(value.rated)?value.rated:"",sort:PLAYER_SORTS.includes(value.sort)?value.sort:"rating_std",page:Math.max(1,Number.parseInt(value.page,10)||1)}; }
export function ratingLabel(value){return Number.isInteger(value)&&value>0?String(value):"Non classé";}
export function publicTournaments(player){return (player?.tournament_players??[]).map(x=>x.tournaments).filter(t=>t&& (t.published_at||t.status==="ongoing"||t.status==="archived"));}
export function playerIdentifier(player){return player?.fide_id?String(player.fide_id):player?.id;}
