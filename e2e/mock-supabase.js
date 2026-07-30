const players=[{id:"p1",name:"Alice",title:"WFM",fide_id:1001,federation:"CIV",club:"Cavalier",rating_std:1900,rating_rapid:1950,rating_blitz:1800},{id:"p2",name:"Bob",title:null,fide_id:null,federation:"CIV",club:"Éléphant",rating_std:1700,rating_rapid:1750,rating_blitz:1650}];
const clubs=[{id:"11111111-1111-4111-8111-111111111111",name:"CCC",city:"Abidjan",active:true},{id:"22222222-2222-4222-8222-222222222222",name:"Club fermé",city:"Bouaké",active:false}];let invitations=[];
const mode=localStorage.getItem("mock-mode")||"swiss";const mockRole=localStorage.getItem("mock-role")||"admin";let signed=localStorage.getItem("mock-auth")==="1";
const tournament={id:"11111111-aaaa-4aaa-8aaa-111111111111",slug:"open-abidjan",name:mode==="roundrobin"?"Toutes rondes Abidjan":"Open Suisse Abidjan",format:mode==="roundrobin"?"round_robin":"swiss",rounds_planned:1,status:mode==="draft"?"draft":"ongoing",created_by:"admin-1",created_at:"2026-01-01",updated_at:"2026-01-02",last_activity_at:"2026-01-02",published_at:mode==="draft"?null:"2026-01-01",started_at:mode==="draft"?null:"2026-01-01",starts_at:"2026-08-01T09:00:00Z",timezone:"Africa/Abidjan",city:"Abidjan",venue_name:"Palais",venue_address:"Plateau",organizer_name:"Ivoire Chess",description:"Tournoi pilote",public_contact_email:"public@example.ci",rating_type:"rapid",tiebreaks:["buchholz","wins"],poster_url:null};
let rounds=[{id:"r1",number:1,released_at:"x",validated_at:mode==="validated"?"x":null,validated_by:null,pairings:[{id:"g1",board:1,white_player_id:"p1",black_player_id:"p2",result:"1-0"}]}];if(mode==="roundrobin"){tournament.rounds_planned=2;rounds.push({id:"r2",number:2,released_at:null,validated_at:null,validated_by:null,pairings:[{id:"g2",board:1,white_player_id:"p2",black_player_id:"p1",result:null}]})}
const embedded=()=>({...tournament,tournament_players:players.map(player=>({withdrawn:false,players:player})),rounds});
class Query{constructor(table){this.table=table;this.filters={};this.write=null}select(){return this}eq(k,v){this.filters[k]=v;return this}is(){return this}not(){return this}or(){return this}order(){return this}range(){return this}lt(){return this}update(v){this.write=v;return this}insert(v){this.write=v;return this}delete(){return this}async maybeSingle(){return this.one()}async single(){return this.one()}async one(){if(mode==="network")return{data:null,error:{message:"offline"}};if(this.table==="profiles")return{data:signed?{role:mockRole}:null,error:null};if(this.table==="tournaments")return{data:embedded(),error:null};if(this.table==="clubs"&&this.write){const club={...this.write,id:"33333333-3333-4333-8333-333333333333"};clubs.push(club);return{data:club,error:null}}return{data:null,error:null}}async result(){if(mode==="network")return{data:null,error:{message:"offline"}};if(this.table==="tournaments")return{data:[{...tournament,tournament_players:[{count:2}],registrations:[]}],error:null};if(this.table==="players")return{data:players,error:null,count:players.length};if(this.table==="profiles")return{data:signed?[{role:mockRole}]:[],error:null};if(this.table==="clubs")return{data:clubs,error:null};if(this.table==="admin_invitations")return{data:invitations,error:null};if(this.table==="club_memberships")return{data:[],error:null};if(this.table==="pairings")return{data:[{id:"g1",result:this.write?.result??null}],error:null};return{data:[],error:null}}then(a,b){return this.result().then(a,b)}}

// --------------------------------------------------------------------------
// Auth — faithful to @supabase/supabase-js v2 (flux implicite)
// --------------------------------------------------------------------------
// A complaisant double would hide the very bug the invitation flow had, so
// this part copies the real client rather than approximating it:
//   * flowType 'implicit' and detectSessionInUrl true by default;
//   * parseParametersFromURL reads location.hash as a query string — which is
//     exactly why a redirect carrying its own '#/route' loses the tokens;
//   * the fragment is cleared once read;
//   * type=recovery emits PASSWORD_RECOVERY, everything else SIGNED_IN.
const emailLinkTokens={"jeton-invitation":{id:"invited-1",email:"organisateur@example.ci",user_metadata:{}}};
const defaultPasswords={"admin@example.ci":"secret"};
const passwords=()=>({...defaultPasswords,...JSON.parse(localStorage.getItem("mock-passwords")||"{}")});
const rememberPassword=(email,password)=>{const all=JSON.parse(localStorage.getItem("mock-passwords")||"{}");all[email]=password;localStorage.setItem("mock-passwords",JSON.stringify(all))};
function parseParametersFromURL(href){const result={};const url=new URL(href);
  if(url.hash&&url.hash[0]==="#"){try{new URLSearchParams(url.hash.substring(1)).forEach((value,key)=>{result[key]=value})}catch{/* not a query string */}}
  url.searchParams.forEach((value,key)=>{result[key]=value});return result}
const listeners=[];
let currentUser=signed?{id:"admin-1",email:"admin@example.ci",user_metadata:{full_name:"Arbitre"}}:null;
const emit=event=>listeners.forEach(callback=>callback(event,currentUser?{user:currentUser}:null));
function establish(user){currentUser=user;signed=true;localStorage.setItem("mock-auth","1")}
function forget(){currentUser=null;signed=false;localStorage.removeItem("mock-auth")}

export function createClient(_url,_key,options){
  if(options?.auth?.detectSessionInUrl!==false){
    const params=parseParametersFromURL(location.href);
    if(params.access_token||params.error_description){
      if(emailLinkTokens[params.access_token])establish(emailLinkTokens[params.access_token]);
      window.location.hash="";
      setTimeout(()=>emit(params.type==="recovery"?"PASSWORD_RECOVERY":"SIGNED_IN"));
    }
  }
  return{
    from:t=>new Query(t),
    rpc:async name=>{if(name==="validate_round"){rounds[0].validated_at="x";if(rounds[1])rounds[1].released_at="x"}if(name==="publish_tournament")tournament.published_at="x";if(name==="start_tournament"){tournament.status="ongoing";tournament.started_at="x"}if(name==="finish_tournament"){tournament.status="archived";tournament.finished_at="x"}return{data:name==="create_tournament_with_players"?tournament:true,error:null}},
    functions:{invoke:async(_name,{body})=>{if(body.action==="invite"){localStorage.setItem("mock-last-invite",JSON.stringify(body));invitations=[{id:"invite-1",email:body.email,club_id:body.club_id,status:"pending",created_at:"2026-07-30T12:00:00Z",expires_at:"2026-08-06T12:00:00Z",sent_count:1,clubs:{name:clubs.find(c=>c.id===body.club_id)?.name}}]}return{data:{},error:null}}},
    auth:{
      getSession:async()=>({data:{session:currentUser?{user:currentUser}:null}}),
      getUser:async()=>({data:{user:currentUser}}),
      signInWithPassword:async({email,password}={})=>{
        if(passwords()[email]!==password)return{data:{session:null,user:null},error:{message:"Invalid login credentials",code:"invalid_credentials"}};
        establish(email==="admin@example.ci"?{id:"admin-1",email,user_metadata:{full_name:"Arbitre"}}:{...(Object.values(emailLinkTokens).find(user=>user.email===email)??{id:`user-${email}`,email}),user_metadata:{}});
        emit("SIGNED_IN");return{data:{session:{user:currentUser}},error:null};
      },
      setSession:async({access_token:accessToken}={})=>{
        const user=emailLinkTokens[accessToken];
        if(!user)return{data:{session:null,user:null},error:{message:"Invalid Refresh Token",code:"refresh_token_not_found"}};
        establish(user);emit("SIGNED_IN");return{data:{session:{user},user},error:null};
      },
      updateUser:async({password}={})=>{
        if(!currentUser)return{data:{user:null},error:{message:"Auth session missing!",code:"session_not_found"}};
        if(typeof password==="string"){
          if(password.length<8)return{data:{user:null},error:{message:"Password should be at least 8 characters",code:"weak_password"}};
          rememberPassword(currentUser.email,password);
        }
        emit("USER_UPDATED");return{data:{user:currentUser},error:null};
      },
      signOut:async()=>{forget();emit("SIGNED_OUT");return{error:null}},
      onAuthStateChange:callback=>{listeners.push(callback);return{data:{subscription:{unsubscribe(){}}}}},
    },
    channel(){return{on(){return this},subscribe(cb){setTimeout(()=>cb("SUBSCRIBED"));return this}}},
    removeChannel(){},
  };
}
