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
