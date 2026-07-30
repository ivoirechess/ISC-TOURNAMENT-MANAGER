import { createClient } from "https://esm.sh/@supabase/supabase-js@2.111.0";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers:{...cors,"Content-Type":"application/json"}});
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Supabase builds the invitation redirect as `redirectTo + "#" + tokens`,
// literally. A redirectTo that already carries a fragment — and this site is a
// hash-router application, so it is tempting to point at `#/…` — produces two
// fragments, and the client then reads `"/…#access_token"` as a parameter name
// and finds no token at all: the invitee lands signed out, with no way to set
// a password. The base URL must therefore stay fragment-free; the site picks
// the screen up from the `type=invite` marker Supabase adds itself.
function siteBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return "";
  }
}

Deno.serve(async (request) => {
  if(request.method==="OPTIONS") return new Response("ok",{headers:cors});
  if(request.method!=="POST") return json({error:"Méthode refusée."},405);
  const url=Deno.env.get("SUPABASE_URL");
  const anon=Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!anon||!serviceKey) return json({error:"Fonction non configurée."},500);
  const authorization=request.headers.get("Authorization")||"";
  const sessionClient=createClient(url,anon,{global:{headers:{Authorization:authorization}}});
  const {data:{user}}=await sessionClient.auth.getUser();
  if(!user) return json({error:"Session requise."},401);
  const service=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:profile}=await service.from("profiles").select("role").eq("id",user.id).maybeSingle();
  if(profile?.role!=="super_admin") return json({error:"Action réservée au super-administrateur."},403);

  const input=await request.json().catch(()=>({}));
  const action=String(input.action||"invite");
  const audit=async(invitation_id:string|null,details:Record<string,unknown>={}) =>
    service.from("admin_invitation_events").insert({invitation_id,action,actor_id:user.id,details});
  let attemptedInvitation:string|null=null;
  try {
    if(action==="sync") {
      const {data:pending,error}=await service.from("admin_invitations").select("id,invited_user_id").eq("status","pending");
      if(error) throw error;let accepted=0;
      for(const invitation of pending??[]){if(!invitation.invited_user_id)continue;const {data}=await service.auth.admin.getUserById(invitation.invited_user_id);if(data.user?.email_confirmed_at){await service.from("admin_invitations").update({status:"accepted",accepted_at:new Date().toISOString()}).eq("id",invitation.id);accepted++;}}
      await audit(null,{accepted});return json({accepted});
    }
    if(action==="disable"||action==="reactivate") {
      const active=action==="reactivate";
      const {data,error}=await service.from("club_memberships").update({active,disabled_at:active?null:new Date().toISOString()})
        .eq("club_id",input.club_id).eq("user_id",input.user_id).select("club_id,user_id,active").single();
      if(error) throw error; await audit(null,{club_id:input.club_id,user_id:input.user_id}); return json(data);
    }
    if(action==="revoke") {
      const {data,error}=await service.from("admin_invitations").update({status:"revoked",revoked_at:new Date().toISOString()})
        .eq("id",input.invitation_id).eq("status","pending").select().single();
      if(error) throw error;
      if(data.invited_user_id) await service.from("club_memberships").update({active:false,disabled_at:new Date().toISOString()})
        .eq("club_id",data.club_id).eq("user_id",data.invited_user_id);
      await audit(data.id); return json(data);
    }

    let email=String(input.email||"").trim().toLowerCase(); let clubId=input.club_id; let invitationId:string|null=null; let sentCount=0;
    if(action==="resend") {
      const {data,error}=await service.from("admin_invitations").select("*").eq("id",input.invitation_id).eq("status","pending").single();
      if(error) throw error; email=data.email;clubId=data.club_id;invitationId=data.id;attemptedInvitation=data.id;sentCount=data.sent_count;
    }
    if(!emailPattern.test(email)) return json({error:"Adresse e-mail invalide."},422);
    const {data:club}=await service.from("clubs").select("id,active").eq("id",clubId).maybeSingle();
    if(!club?.active) return json({error:"Club actif introuvable."},404);
    await service.from("admin_invitations").update({status:"expired"}).eq("status","pending").lt("expires_at",new Date().toISOString());
    if(!invitationId) {
      const {data:duplicate}=await service.from("admin_invitations").select("id").eq("email",email).eq("club_id",clubId).eq("status","pending").maybeSingle();
      if(duplicate) return json({error:"Une invitation active existe déjà."},409);
      const {data,error}=await service.from("admin_invitations").insert({email,club_id:clubId,invited_by:user.id}).select().single();
      if(error) throw error; invitationId=data.id;attemptedInvitation=data.id;
    }
    const redirectTo=siteBaseUrl(Deno.env.get("PUBLIC_SITE_URL")||request.headers.get("origin")||"");
    // Without a usable base, let Supabase fall back to the configured Site URL
    // rather than send a link to a URL we made up.
    const {data:invited,error:inviteError}=await service.auth.admin.inviteUserByEmail(email,redirectTo?{redirectTo}:{});
    if(inviteError) {await service.from("admin_invitations").update({last_error:inviteError.message}).eq("id",invitationId);throw inviteError;}
    const invitedId=invited.user.id;
    await service.from("profiles").upsert({id:invitedId,role:"admin",display_name:email},{onConflict:"id"});
    await service.from("club_memberships").upsert({club_id:clubId,user_id:invitedId,role:"admin",active:true,disabled_at:null},{onConflict:"club_id,user_id"});
    const {data:result,error:updateError}=await service.from("admin_invitations").update({invited_user_id:invitedId,last_sent_at:new Date().toISOString(),last_error:null,...(action==="resend"?{sent_count:sentCount+1}:{})}).eq("id",invitationId).select().single();
    if(updateError) throw updateError;
    await audit(invitationId,{email,club_id:clubId}); return json(result,action==="invite"?201:200);
  } catch(error) {const message=error instanceof Error?error.message:"Action impossible.";await audit(attemptedInvitation,{error:message});return json({error:message},400);}
});
