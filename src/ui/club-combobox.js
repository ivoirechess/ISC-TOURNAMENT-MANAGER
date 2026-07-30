export function normalizedClubName(value=""){return value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ")}

export function createClubCombobox({root,input,list,clubs=[],allowNone=true,allowCreate=true,onSelect,onCreate}){
  let selected=null,active=-1,filtered=[];
  input.setAttribute("role","combobox");input.setAttribute("aria-autocomplete","list");input.setAttribute("aria-expanded","false");input.setAttribute("aria-controls",list.id);
  list.setAttribute("role","listbox");
  function close(){list.hidden=true;input.setAttribute("aria-expanded","false");active=-1;input.removeAttribute("aria-activedescendant")}
  function choose(club){selected=club;input.value=club?.name||"";close();onSelect?.(club)}
  function render(){const query=normalizedClubName(input.value);filtered=clubs.filter(c=>c.active!==false&&(!query||normalizedClubName(`${c.name} ${c.city||""}`).includes(query)));list.replaceChildren();
    const exact=clubs.some(c=>normalizedClubName(c.name)===query);const options=[];
    if(allowNone)options.push({label:"Aucun club",action:()=>choose(null)});
    for(const club of filtered)options.push({label:club.name,secondary:club.city,action:()=>choose(club)});
    if(allowCreate&&query&&!exact)options.push({label:`Créer le club “${input.value.trim()}”`,create:true,action:async()=>{const club=await onCreate(input.value.trim());if(club){clubs.push(club);choose(club)}}});
    options.forEach((option,index)=>{const button=document.createElement("button");button.type="button";button.id=`${list.id}-option-${index}`;button.setAttribute("role","option");button.className=option.create?"club-option create":"club-option";const name=document.createElement("span");name.textContent=option.label;button.append(name);if(option.secondary){const city=document.createElement("small");city.textContent=option.secondary;button.append(city)}button.onmousedown=e=>e.preventDefault();button.onclick=option.action;list.append(button)});
    const near=!exact&&query?clubs.find(c=>{const n=normalizedClubName(c.name);return n.includes(query)||query.includes(n)}):null;
    let warning=root.querySelector(".club-near-warning");if(!warning){warning=document.createElement("p");warning.className="club-near-warning warning";root.append(warning)}warning.textContent=near?`Nom proche : ${near.name}. Vous pouvez sélectionner ce club pour éviter un doublon.`:"";
    list.hidden=false;input.setAttribute("aria-expanded","true");active=-1;
  }
  input.addEventListener("input",()=>{selected=null;onSelect?.(null);render()});input.addEventListener("focus",render);
  input.addEventListener("keydown",event=>{const buttons=[...list.querySelectorAll('[role="option"]')];if(event.key==="Escape"){close();return}if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();if(list.hidden)render();active=(active+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;buttons.forEach((b,i)=>b.setAttribute("aria-selected",String(i===active)));input.setAttribute("aria-activedescendant",buttons[active]?.id||"");buttons[active]?.scrollIntoView({block:"nearest"})}else if(event.key==="Enter"&&!list.hidden&&active>=0){event.preventDefault();buttons[active]?.click()}else if(event.key==="Tab")close()});
  input.addEventListener("blur",()=>setTimeout(close,0));
  return {setClubs(value){clubs=value;},select:choose,get value(){return selected},refresh:render};
}
