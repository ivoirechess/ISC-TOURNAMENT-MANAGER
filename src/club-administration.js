export const INVITATION_STATUSES={pending:"En attente",accepted:"Acceptée",expired:"Expirée",revoked:"Révoquée"};
export function invitationLabel(status){return INVITATION_STATUSES[status]??"Inconnue";}
export function invitationDisplayStatus(invitation,now=Date.now()){return invitation?.status==="pending"&&Date.parse(invitation.expires_at)<now?"expired":invitation?.status;}
export function canResendInvitation(invitation){return invitationDisplayStatus(invitation)==="pending";}
export function membershipAction(membership){return membership?.active?"Désactiver":"Réactiver";}
export function publicClubTournaments(club){return (club?.tournaments??[]).filter(t=>t.published_at||t.status==="ongoing"||t.status==="archived");}
