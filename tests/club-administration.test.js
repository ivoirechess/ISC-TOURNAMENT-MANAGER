import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {canResendInvitation,invitationDisplayStatus,invitationLabel,membershipAction,publicClubTournaments} from "../src/club-administration.js";

test("les quatre statuts d'invitation ont un libellé",()=>{
  assert.deepEqual(["pending","accepted","expired","revoked"].map(invitationLabel),["En attente","Acceptée","Expirée","Révoquée"]);
});
test("une invitation pending dépassée est présentée comme expirée",()=>assert.equal(invitationDisplayStatus({status:"pending",expires_at:"2020-01-01"},Date.parse("2021-01-01")),"expired"));
test("actions invitation et membership suivent leur état",()=>{
  assert.equal(canResendInvitation({status:"pending"}),true);assert.equal(canResendInvitation({status:"revoked"}),false);
  assert.equal(membershipAction({active:true}),"Désactiver");assert.equal(membershipAction({active:false}),"Réactiver");
});
test("la fiche club exclut les tournois privés",()=>{
  const club={tournaments:[{id:"a",published_at:"x"},{id:"b",status:"draft"},{id:"c",status:"archived"}]};
  assert.deepEqual(publicClubTournaments(club).map(t=>t.id),["a","c"]);
});
test("la fonction Edge garde la service_role côté serveur et valide les droits",()=>{
  const source=readFileSync("supabase/functions/invite-admin/index.ts","utf8");
  assert.match(source,/SUPABASE_SERVICE_ROLE_KEY/);assert.match(source,/profile\?\.role!=="super_admin"/);
  assert.match(source,/inviteUserByEmail/);assert.match(source,/Une invitation active existe déjà/);
});
test("l'invitation utilise un select UUID sans seconde source de vérité",()=>{
  const html=readFileSync("index.html","utf8");const ui=readFileSync("src/ui/clubs.js","utf8");
  assert.match(html,/<select id="admin-club" required><option value="">Sélectionner un club<\/option><\/select>/);
  assert.doesNotMatch(html,/admin-club-options|admin-club-combobox/);
  assert.match(ui,/const clubId=el\("admin-club"\)\.value,club=activeAdminClubs\.find\(item=>item\.id===clubId\)/);
  assert.match(ui,/club_id:club\.id/);
  assert.match(ui,/if\(invitationPending\)return/);
});
test("seuls les clubs explicitement actifs alimentent les options et l'état vide bloque l'envoi",()=>{
  const ui=readFileSync("src/ui/clubs.js","utf8");
  assert.match(ui,/data\.clubs\.filter\(c=>c\.active===true\)/);
  assert.match(ui,/option\.value=club\.id/);
  assert.match(ui,/Aucun club actif disponible/);
  assert.match(ui,/submit\.disabled=invitationPending\|\|activeAdminClubs\.length===0/);
});
test("les panneaux administratifs compacts n'héritent d'aucune grande carte",()=>{
  const css=readFileSync("src/styles/main.css","utf8");
  assert.doesNotMatch(css,/\.overview-card[^\n]*\.admin-(?:grid|list-panel)/);
  const panelRule=css.match(/\.admin-invite-panel,\.admin-list-panel\{([^}]+)\}/)?.[1]??"";
  assert.doesNotMatch(panelRule,/min-height/);
});
