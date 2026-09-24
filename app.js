import {
  PI, EPS, deg2rad, rad2deg, clamp,
  add, sub, scale, dot, norm, cross, normalize,
  RL_calc, UB_calc, makeSpiceScatteringPlaneBasis, reciprocalVectors,
  linspace, arange, interpExtrap
} from "./tas-core.js";
import {RL_calc as RLRes, inferOutOfPlaneHKL, calcResolution} from "./resolution-core.js";
import {parseCifStructure, nuclearStructureFactorSquared} from "./cif-structure.js";

const $ = id => document.getElementById(id);
const instruments = new Map();
const backgroundMaterials = new Map();
const sampleEnvironments = new Map();

// Four fixed background-scattering slots keep the sidebar compact. Each slot
// now selects a CIF structure loaded from BG_material/*.cif.
const BACKGROUND_SLOTS=[
  {id:"backgroundSelect1",rgb:[0,0,128]},      // navy
  {id:"backgroundSelect2",rgb:[165,42,42]},    // brown
  {id:"backgroundSelect3",rgb:[44,160,44]},    // green
  {id:"backgroundSelect4",rgb:[148,103,189]}   // purple
];
function selectedBackgrounds(){
  return BACKGROUND_SLOTS.map((slot,index)=>({slot,index,key:$(slot.id)?.value||""}))
    .filter(x=>x.key && backgroundMaterials.has(x.key));
}

function updateBackgroundSelectAvailability(){
  const chosen=new Map();
  for(const slot of BACKGROUND_SLOTS){
    const sel=$(slot.id);
    if(sel?.value) chosen.set(slot.id,sel.value);
  }
  for(const slot of BACKGROUND_SLOTS){
    const sel=$(slot.id);
    if(!sel) continue;
    for(const opt of sel.options){
      if(!opt.value){ opt.disabled=false; opt.hidden=false; continue; }
      const usedElsewhere=[...chosen.entries()].some(([id,key])=>id!==slot.id && key===opt.value);
      opt.disabled=usedElsewhere;
      opt.hidden=usedElsewhere;
    }
  }
}

function handleBackgroundSelection(changedId){
  const changed=$(changedId);
  if(!changed) return;
  const key=changed.value;
  if(key){
    // The most recently changed slot owns the selection.  This is mainly a
    // safeguard for restored/legacy states; normally duplicates are hidden.
    for(const slot of BACKGROUND_SLOTS){
      if(slot.id!==changedId && $(slot.id)?.value===key) $(slot.id).value="";
    }
  }
  updateBackgroundSelectAvailability();
  scheduleRecalc();
}

function backgroundRowIndices(){
  return [...document.querySelectorAll(".background-row[data-background-index]")]
    .map(row=>Number(row.dataset.backgroundIndex))
    .filter(Number.isFinite)
    .sort((a,b)=>a-b);
}

function backgroundRowValues(){
  return backgroundRowIndices().map(index=>({key:$( `backgroundSelect${index}` )?.value||""}));
}

function createBackgroundRow(index,value={}){
  const slot=BACKGROUND_SLOTS[index-1];
  if(!slot) return null;
  const row=document.createElement("div");
  row.className="background-row";
  row.dataset.backgroundIndex=String(index);
  row.innerHTML=`<label><span class="background-label"><i class="bg-swatch bg${index}"></i>BG${index}</span><select id="backgroundSelect${index}"><option value="">None</option></select></label>`+
    `<button type="button" class="remove-background" data-background-index="${index}">Remove</button>`;
  const select=row.querySelector(`#backgroundSelect${index}`);
  refreshBackgroundSelect(select,"None");
  const requested=String(value.key||"");
  if([...select.options].some(o=>o.value===requested)) select.value=requested;
  return row;
}

function replaceBackgroundRows(values,{recalc=false}={}){
  const host=$("backgroundRows");
  if(!host) return;
  const rows=(Array.isArray(values)&&values.length)?values:[{}];
  const limited=rows.slice(0,BACKGROUND_SLOTS.length);
  host.replaceChildren();
  limited.forEach((value,i)=>{
    const row=createBackgroundRow(i+1,value);
    if(row) host.appendChild(row);
  });
  if($("backgroundCount")) $("backgroundCount").value=String(limited.length);
  updateBackgroundSelectAvailability();
  const add=$("addBackground");
  if(add) add.disabled=limited.length>=BACKGROUND_SLOTS.length;
  if(recalc) scheduleRecalc();
}

function setBackgroundCount(count,{recalc=false}={}){
  count=Math.max(1,Math.min(BACKGROUND_SLOTS.length,Math.floor(Number(count)||1)));
  const values=backgroundRowValues();
  while(values.length<count) values.push({});
  values.length=count;
  replaceBackgroundRows(values,{recalc});
}

function removeBackground(index){
  const values=backgroundRowValues();
  const position=backgroundRowIndices().indexOf(Number(index));
  if(position>=0) values.splice(position,1);
  replaceBackgroundRows(values,{recalc:true});
}

function propagationVectorIndices(){
  return [...document.querySelectorAll(".propagation-row[data-q-index]")]
    .map(row=>Number(row.dataset.qIndex))
    .filter(Number.isFinite)
    .sort((a,b)=>a-b);
}

function enabledPropagationVectors(){
  // Global display switch: keep every entered k-vector intact while hiding
  // all magnetic Bragg peaks when Propagation vectors > show is off.
  if($("showPropagation") && !$("showPropagation").checked) return [];
  const out=[];
  for(const i of propagationVectorIndices()){
    if($(`q_enable${i}`)?.checked){
      out.push({index:i, hkl:[num(`q${i}_h`),num(`q${i}_k`),num(`q${i}_l`)]});
    }
  }
  return out;
}
function backgroundColor(slot,alpha=1){
  const [r,g,b]=slot.rgb; return `rgba(${r},${g},${b},${alpha})`;
}
const legacyRangeInstruments = new Map();

let singleCache = null;
let selectedCifStructure = null;
let selectedCifFileName = "";

function hasSelectedCif(){
  return checkedValue("sampleMode")==="single" && !!selectedCifStructure;
}

function updateCifUI(){
  const row=$("cifSelectRow");
  if(row) row.classList.remove("hidden");
  const name=$("cifFileName");
  if(name){
    name.textContent=selectedCifFileName || "No file selected";
    if(selectedCifStructure){
      const bits=[selectedCifStructure.name];
      if(selectedCifStructure.spaceGroup) bits.push(`Space group: ${selectedCifStructure.spaceGroup}`);
      bits.push(`${selectedCifStructure.asymmetricSiteCount} asymmetric site(s)`);
      bits.push(`${selectedCifStructure.symmetryOperationCount} symmetry operation(s)`);
      name.title=bits.join(" | ");
    }else name.title="";
  }
  const clearButton=$("cifClearButton");
  if(clearButton) clearButton.disabled=!selectedCifStructure;
  $("sfColorMaxRow")?.classList.toggle("hidden",!hasSelectedCif());
}

function syncSfColorMaxControl(source="slider"){
  const slider=$("sfColorMaxSlider"), output=$("sfColorMaxValue"), entry=$("sfColorMaxEntry");
  if(!slider || !entry) return;
  let raw;
  if(source==="entry") raw=Number(entry.value);
  else if(source==="restore"){
    const entryValue=Number(entry.value);
    raw=Number.isFinite(entryValue) ? entryValue : Number(slider.value);
  }else raw=Number(slider.value);
  if(!Number.isFinite(raw)) raw=1;
  const v=Math.max(0.01,Math.min(1,raw));
  slider.value=String(v);
  entry.value=v.toFixed(2);
  if(output) output.textContent=v.toFixed(2);
}

function sfThresholdFraction(){
  const entry=$("sfThresholdEntry");
  let pct=Number(entry?.value);
  if(!Number.isFinite(pct)) pct=0;
  pct=Math.max(0,Math.min(100,pct));
  if(entry) entry.value=pct.toFixed(1);
  return pct/100;
}

function loadCifText(text,fileName="generated_structure.cif"){
  const parsed=parseCifStructure(text);
  selectedCifStructure=parsed;
  selectedCifFileName=fileName;

  // A selected/generated CIF defines the crystallographic unit cell. Keep the
  // existing U/V orientation indices, but synchronize the six lattice fields.
  const lattice=parsed?.lattice || {};
  for(const id of ["a","b","c","alpha","beta","gamma"]){
    const value=Number(lattice[id]);
    if(Number.isFinite(value) && $(id)) $(id).value=String(value);
  }
  // When the CIF contains a recognizable standard-setting space group, keep
  // the Sample Space group controls synchronized with the loaded structure.
  const sg=findGeneratorSpaceGroup(parsed);
  if(sg) setSampleSpaceGroup(sg.number,{recalc:false});

  updateAutoW();
  updateCifUI();
  clearError();
  scheduleRecalc();
  return parsed;
}

async function selectCifFile(file){
  if(!file) return;
  return loadCifText(await file.text(),file.name);
}

function clearSelectedCif(){
  selectedCifStructure=null;
  selectedCifFileName="";
  if($("cifFileInput")) $("cifFileInput").value="";
  updateCifUI();
  clearError();
  scheduleRecalc();
}

// ==================== CIF Generator ====================
let cifSpaceGroups=[];

function sampleSpaceGroupByNumber(number){
  const n=Math.round(Number(number));
  return cifSpaceGroups.find(sg=>sg.number===n) || null;
}

function centeringFromSpaceGroup(sg){
  const symbol=String(sg?.hm || "").trim().toUpperCase();
  const first=symbol.charAt(0);
  // The bundled standard settings use conventional P/A/B/C/I/F/R lattice
  // symbols. H, if ever encountered in imported metadata, is equivalent to
  // rhombohedral centering in hexagonal axes for this extinction filter.
  if(["P","A","B","C","I","F","R"].includes(first)) return first;
  if(first==="H") return "R";
  return "P";
}

function selectedSampleSpaceGroup(){
  const n=Number($("sampleSpaceGroup")?.value || $("sampleSpaceGroupNumber")?.value || 1);
  return sampleSpaceGroupByNumber(n) || sampleSpaceGroupByNumber(1);
}

function selectedSampleCentering(){
  return centeringFromSpaceGroup(selectedSampleSpaceGroup());
}

const SAMPLE_LATTICE_FIELDS={a:"a",b:"b",c:"c",alpha:"alpha",beta:"beta",gamma:"gamma"};

function applySampleLatticeConstraints(){
  const sg=selectedSampleSpaceGroup();
  if(!sg) return;
  const inputs=Object.fromEntries(Object.entries(SAMPLE_LATTICE_FIELDS).map(([key,id])=>[key,$(id)]));
  for(const input of Object.values(inputs)){
    if(!input) continue;
    input.readOnly=false;
    input.removeAttribute("aria-readonly");
    input.title="";
  }
  const lockValue=(key,value,reason)=>{
    const input=inputs[key]; if(!input) return;
    input.value=String(value);
    input.readOnly=true;
    input.setAttribute("aria-readonly","true");
    input.title=reason;
  };
  const lockEqual=(key,sourceKey,reason)=>{
    const source=Number(inputs[sourceKey]?.value);
    if(Number.isFinite(source)) lockValue(key,source,reason);
  };

  // Keep the Sample lattice convention identical to the CIF Generator:
  // standard monoclinic b setting, hexagonal axes for trigonal groups.
  const cs=String(sg.crystal_system||"").toLowerCase();
  if(cs==="monoclinic"){
    lockValue("alpha",90,"Fixed by the standard monoclinic setting.");
    lockValue("gamma",90,"Fixed by the standard monoclinic setting.");
  }else if(cs==="orthorhombic"){
    for(const k of ["alpha","beta","gamma"]) lockValue(k,90,"Fixed by orthorhombic symmetry.");
  }else if(cs==="tetragonal"){
    lockEqual("b","a","b = a by tetragonal symmetry.");
    for(const k of ["alpha","beta","gamma"]) lockValue(k,90,"Fixed by tetragonal symmetry.");
  }else if(cs==="trigonal" || cs==="hexagonal"){
    lockEqual("b","a",`${cs==="trigonal"?"Trigonal (hexagonal setting)":"Hexagonal"} symmetry requires b = a.`);
    lockValue("alpha",90,"Fixed by the standard hexagonal-axis setting.");
    lockValue("beta",90,"Fixed by the standard hexagonal-axis setting.");
    lockValue("gamma",120,"Fixed by the standard hexagonal-axis setting.");
  }else if(cs==="cubic"){
    lockEqual("b","a","b = a by cubic symmetry.");
    lockEqual("c","a","c = a by cubic symmetry.");
    for(const k of ["alpha","beta","gamma"]) lockValue(k,90,"Fixed by cubic symmetry.");
  }
}

function setSampleSpaceGroup(number,{recalc=true}={}){
  const sg=sampleSpaceGroupByNumber(number);
  if(!sg) return false;
  const select=$("sampleSpaceGroup"), entry=$("sampleSpaceGroupNumber");
  if(select) select.value=String(sg.number);
  if(entry) entry.value=String(sg.number);
  applySampleLatticeConstraints();
  updateAutoW();
  if(recalc) scheduleRecalc();
  return true;
}

function jumpToSampleSpaceGroupNumber(){
  const entry=$("sampleSpaceGroupNumber");
  if(!entry) return;
  let n=Math.round(Number(entry.value));
  if(!Number.isFinite(n)) n=Number($("sampleSpaceGroup")?.value)||1;
  n=Math.max(1,Math.min(230,n));
  if(!setSampleSpaceGroup(n)) entry.value=String(Number($("sampleSpaceGroup")?.value)||1);
}

function syncSampleSpaceGroupNumberFromSelect(){
  const n=Number($("sampleSpaceGroup")?.value);
  if(Number.isInteger(n) && $("sampleSpaceGroupNumber")) $("sampleSpaceGroupNumber").value=String(n);
  applySampleLatticeConstraints();
  updateAutoW();
  scheduleRecalc();
}

function restoreSampleSpaceGroupSelection(){
  let saved=null;
  try{ saved=JSON.parse(localStorage.getItem(LEFT_PANEL_STORAGE_KEY)||"null"); }catch(_e){}
  const n=Number(saved?.values?.sampleSpaceGroup || saved?.values?.sampleSpaceGroupNumber);
  if(Number.isInteger(n) && sampleSpaceGroupByNumber(n)) setSampleSpaceGroup(n,{recalc:false});
  else setSampleSpaceGroup(1,{recalc:false});
}

function populateSampleSpaceGroupControls(){
  const select=$("sampleSpaceGroup");
  if(!select) return;
  select.replaceChildren();
  for(const sg of cifSpaceGroups){
    const opt=document.createElement("option");
    opt.value=String(sg.number);
    opt.textContent=`${sg.number} — ${sg.hm}`;
    select.appendChild(opt);
  }
  restoreSampleSpaceGroupSelection();
  if(!select.dataset.bound){
    select.addEventListener("change",syncSampleSpaceGroupNumberFromSelect);
    $("sampleSpaceGroupNumber")?.addEventListener("change",jumpToSampleSpaceGroupNumber);
    $("sampleSpaceGroupNumber")?.addEventListener("keydown",ev=>{
      if(ev.key==="Enter"){ ev.preventDefault(); jumpToSampleSpaceGroupNumber(); }
    });
    // For tetragonal / trigonal / hexagonal / cubic cells, b (and cubic c)
    // follows the independent a field immediately while the user edits it.
    $("a")?.addEventListener("input",applySampleLatticeConstraints);
    select.dataset.bound="1";
  }
}

let lastGeneratedCifText="";
let lastGeneratedCifName="generated_structure.cif";
let selectedCifReflectionKey="";
let cifReflectionSort={key:"intensity",direction:"desc"};
let lastGeneratedCifParsed=null;
let lastGeneratedCifSpaceGroup=null;
let lastGeneratedReflections=[];

function setCifGeneratedReady(ready){
  if($("cifDownload")) $("cifDownload").disabled=!ready;
  if($("cifSet")) $("cifSet").disabled=!ready;
}

function clearCifReflectionTable(message="No generated reflections yet."){
  lastGeneratedReflections=[];
  const body=$("cifReflectionRows");
  if(body){
    body.replaceChildren();
    const tr=document.createElement("tr"), td=document.createElement("td");
    td.colSpan=7; td.className="cif-reflection-empty"; td.textContent=message;
    tr.appendChild(td); body.appendChild(tr);
  }
  if($("cifReflectionSummary")) $("cifReflectionSummary").textContent=message;
}

function invalidateGeneratedCif(message="Inputs changed — press Generate to refresh the CIF and reflection table."){
  lastGeneratedCifText="";
  lastGeneratedCifParsed=null;
  lastGeneratedCifSpaceGroup=null;
  setCifGeneratedReady(false);
  if($("cifPreview")) $("cifPreview").textContent="Press Generate to preview the CIF.";
  clearCifReflectionTable("Press Generate to calculate reflections.");
  if(message) setCifGeneratorMessage(message);
}

function setCifGeneratorMessage(text,isError=false){
  const box=$("cifGeneratorMessage");
  if(!box) return;
  box.textContent=text || "";
  box.classList.toggle("error-text",!!isError);
}

const CIF_LATTICE_FIELDS={a:"cifA",b:"cifB",c:"cifC",alpha:"cifAlpha",beta:"cifBeta",gamma:"cifGamma"};

function selectedCifGeneratorSpaceGroup(){
  const n=Number($("cifSpaceGroup")?.value);
  return cifSpaceGroups.find(x=>x.number===n) || null;
}

function syncCifSpaceGroupNumberFromSelect(){
  const n=Number($("cifSpaceGroup")?.value);
  const entry=$("cifSpaceGroupNumber");
  if(entry && Number.isInteger(n)) entry.value=String(n);
}

function jumpToCifSpaceGroupNumber(){
  const entry=$("cifSpaceGroupNumber");
  const select=$("cifSpaceGroup");
  if(!entry || !select) return;
  let n=Math.round(Number(entry.value));
  if(!Number.isFinite(n)) n=Number(select.value)||1;
  n=Math.max(1,Math.min(230,n));
  entry.value=String(n);
  const sg=cifSpaceGroups.find(x=>x.number===n);
  if(!sg){
    setCifGeneratorMessage(`Space group #${n} is not available.`,true);
    return;
  }
  select.value=String(n);
  updateCifSpaceGroupInfo();
}

function applyCifLatticeConstraints(){
  const sg=selectedCifGeneratorSpaceGroup();
  if(!sg) return;
  const inputs=Object.fromEntries(Object.entries(CIF_LATTICE_FIELDS).map(([key,id])=>[key,$(id)]));
  for(const input of Object.values(inputs)){
    if(!input) continue;
    input.readOnly=false;
    input.removeAttribute("aria-readonly");
    input.title="";
  }
  const lockValue=(key,value,reason)=>{
    const input=inputs[key]; if(!input) return;
    input.value=String(value); input.readOnly=true; input.setAttribute("aria-readonly","true"); input.title=reason;
  };
  const lockEqual=(key,sourceKey,reason)=>{
    const source=Number(inputs[sourceKey]?.value);
    if(Number.isFinite(source)) lockValue(key,source,reason);
  };
  const cs=String(sg.crystal_system||"").toLowerCase();
  if(cs==="monoclinic"){
    lockValue("alpha",90,"Fixed by the standard monoclinic setting.");
    lockValue("gamma",90,"Fixed by the standard monoclinic setting.");
  }else if(cs==="orthorhombic"){
    for(const k of ["alpha","beta","gamma"]) lockValue(k,90,"Fixed by orthorhombic symmetry.");
  }else if(cs==="tetragonal"){
    lockEqual("b","a","b = a by tetragonal symmetry.");
    for(const k of ["alpha","beta","gamma"]) lockValue(k,90,"Fixed by tetragonal symmetry.");
  }else if(cs==="trigonal" || cs==="hexagonal"){
    // The bundled standard settings use hexagonal axes for trigonal groups.
    lockEqual("b","a",`${cs==="trigonal"?"Trigonal (hexagonal setting)":"Hexagonal"} symmetry requires b = a.`);
    lockValue("alpha",90,"Fixed by the standard hexagonal-axis setting.");
    lockValue("beta",90,"Fixed by the standard hexagonal-axis setting.");
    lockValue("gamma",120,"Fixed by the standard hexagonal-axis setting.");
  }else if(cs==="cubic"){
    lockEqual("b","a","b = a by cubic symmetry.");
    lockEqual("c","a","c = a by cubic symmetry.");
    for(const k of ["alpha","beta","gamma"]) lockValue(k,90,"Fixed by cubic symmetry.");
  }
}

function copyCurrentLatticeToGenerator(){
  const map={cifA:"a",cifB:"b",cifC:"c",cifAlpha:"alpha",cifBeta:"beta",cifGamma:"gamma"};
  for(const [dst,src] of Object.entries(map)){
    const v=Number($(src)?.value);
    if(Number.isFinite(v) && $(dst)) $(dst).value=String(v);
  }
  applyCifLatticeConstraints();
}

function updateCifSpaceGroupInfo(){
  const sg=selectedCifGeneratorSpaceGroup();
  const box=$("cifSpaceGroupInfo");
  if(!box) return;
  if(!sg){ box.textContent="Select a space group."; return; }
  syncCifSpaceGroupNumberFromSelect();
  box.textContent=`#${sg.number} ${sg.hm} · ${sg.crystal_system} · standard setting · ${sg.operations.length} symmetry operation(s)`;
  applyCifLatticeConstraints();
}

function addCifAtomRow(values={}, {invalidate=true}={}){
  const host=$("cifAtomRows");
  if(!host) return;
  const row=document.createElement("div");
  row.className="cif-atom-row";
  const specs=[
    ["element","text",values.element ?? ""],
    ["x","number",values.x ?? 0],
    ["y","number",values.y ?? 0],
    ["z","number",values.z ?? 0],
    ["occupancy","number",values.occupancy ?? 1]
  ];
  for(const [key,type,value] of specs){
    const cell=document.createElement("div"); cell.className="cif-atom-cell";
    const input=document.createElement("input");
    input.type=type; input.dataset.cifAtomField=key; input.value=String(value);
    if(type==="number") input.step=key==="occupancy" ? "0.01" : "0.0001";
    if(key==="occupancy"){ input.min="0"; input.max="1"; }
    if(key==="element") input.placeholder="e.g. Cu";
    cell.appendChild(input); row.appendChild(cell);
  }
  const action=document.createElement("div"); action.className="cif-atom-cell";
  const remove=document.createElement("button"); remove.type="button"; remove.textContent="Remove";
  remove.addEventListener("click",()=>{
    row.remove();
    if(!host.querySelector(".cif-atom-row")) addCifAtomRow({}, {invalidate:false});
    invalidateGeneratedCif();
  });
  action.appendChild(remove); row.appendChild(action);
  host.appendChild(row);
  if(invalidate) invalidateGeneratedCif();
}

function replaceCifAtomRows(atoms){
  const host=$("cifAtomRows");
  if(!host) return;
  host.replaceChildren();
  for(const atom of atoms) addCifAtomRow(atom,{invalidate:false});
  if(!atoms.length) addCifAtomRow({}, {invalidate:false});
}

function normalizeCifElement(raw){
  const s=String(raw||"").trim();
  if(/^D$/i.test(s)) return "D";
  const iso=s.match(/^(\d+)([A-Za-z]{1,2})$/);
  if(iso) return `${iso[1]}${iso[2][0].toUpperCase()+iso[2].slice(1).toLowerCase()}`;
  const m=s.match(/^([A-Za-z]{1,2})/);
  if(!m) return "";
  return m[1][0].toUpperCase()+m[1].slice(1).toLowerCase();
}

function readCifGeneratorAtoms(){
  const host=$("cifAtomRows");
  const rows=host ? [...host.querySelectorAll(".cif-atom-row")] : [];
  const atoms=[];
  for(let i=0;i<rows.length;i++){
    const get=key=>rows[i].querySelector(`[data-cif-atom-field="${key}"]`)?.value;
    const element=normalizeCifElement(get("element"));
    if(!element) throw new Error(`Atom ${i+1}: enter a valid element symbol.`);
    const x=Number(get("x")), y=Number(get("y")), z=Number(get("z")), occupancy=Number(get("occupancy"));
    if(![x,y,z].every(Number.isFinite)) throw new Error(`Atom ${i+1}: x, y, and z must be finite fractional coordinates.`);
    if(!Number.isFinite(occupancy) || occupancy<0 || occupancy>1) throw new Error(`Atom ${i+1}: occupancy must be between 0 and 1.`);
    atoms.push({element,x,y,z,occupancy});
  }
  if(!atoms.length) throw new Error("Add at least one asymmetric-unit atom.");
  return atoms;
}

function cifGeneratorNumber(id,label,{positive=false,angle=false}={}){
  const v=Number($(id)?.value);
  if(!Number.isFinite(v)) throw new Error(`${label} must be a number.`);
  if(positive && !(v>0)) throw new Error(`${label} must be greater than zero.`);
  if(angle && !(v>0 && v<180)) throw new Error(`${label} must be between 0 and 180 degrees.`);
  return v;
}

function cleanCifFileName(raw){
  let name=String(raw||"generated_structure.cif").trim().replace(/[\\/:*?"<>|]+/g,"_");
  if(!name) name="generated_structure.cif";
  if(!name.toLowerCase().endsWith(".cif")) name+=".cif";
  return name;
}

function buildGeneratedCif(){
  applyCifLatticeConstraints();
  const sg=selectedCifGeneratorSpaceGroup();
  if(!sg) throw new Error("Select a space group.");
  const lattice={
    a:cifGeneratorNumber("cifA","a",{positive:true}),
    b:cifGeneratorNumber("cifB","b",{positive:true}),
    c:cifGeneratorNumber("cifC","c",{positive:true}),
    alpha:cifGeneratorNumber("cifAlpha","alpha",{angle:true}),
    beta:cifGeneratorNumber("cifBeta","beta",{angle:true}),
    gamma:cifGeneratorNumber("cifGamma","gamma",{angle:true})
  };
  const atoms=readCifGeneratorAtoms();
  const filename=cleanCifFileName($("cifGeneratedName")?.value);
  const dataName=filename.replace(/\.cif$/i,"").replace(/[^A-Za-z0-9_\-]/g,"_") || "generated_structure";
  const lines=[
    `data_${dataName}`,
    "_audit_creation_method 'TAS Simulator CIF Generator'",
    `_space_group_name_H-M_alt '${sg.hm}'`,
    `_space_group_name_Hall '${sg.hall}'`,
    `_space_group_IT_number ${sg.number}`,
    `_cell_length_a ${lattice.a}`,
    `_cell_length_b ${lattice.b}`,
    `_cell_length_c ${lattice.c}`,
    `_cell_angle_alpha ${lattice.alpha}`,
    `_cell_angle_beta ${lattice.beta}`,
    `_cell_angle_gamma ${lattice.gamma}`,
    "",
    "loop_",
    "_space_group_symop_id",
    "_space_group_symop_operation_xyz"
  ];
  sg.operations.forEach((op,i)=>lines.push(`${i+1} '${op}'`));
  lines.push("","loop_","_atom_site_label","_atom_site_type_symbol","_atom_site_fract_x","_atom_site_fract_y","_atom_site_fract_z","_atom_site_occupancy");
  const counts=new Map();
  for(const atom of atoms){
    const n=(counts.get(atom.element)||0)+1; counts.set(atom.element,n);
    lines.push(`${atom.element}${n} ${atom.element} ${atom.x} ${atom.y} ${atom.z} ${atom.occupancy}`);
  }
  lines.push("");
  const text=lines.join("\n");
  // Validate with the same parser used by the simulator. This catches unknown
  // atom types and any atom/site that cannot be expanded before download/apply.
  const parsed=parseCifStructure(text);
  return {text,filename,sg,atoms,parsed};
}


function cifSymRationalNumber(raw){
  let s=String(raw??"").replace(/\*/g,"").trim();
  if(!s || s==="+") return 1;
  if(s==="-") return -1;
  if(s.startsWith("/")) return 1/Number(s.slice(1));
  if(s.startsWith("+/")) return 1/Number(s.slice(2));
  if(s.startsWith("-/")) return -1/Number(s.slice(2));
  if(s.includes("/")){
    const parts=s.split("/");
    if(parts.length===2){
      const a=Number(parts[0]), b=Number(parts[1]);
      return b ? a/b : NaN;
    }
  }
  return Number(s);
}

function cifSymmetryLinearMatrix(op){
  const parts=String(op||"").split(",");
  if(parts.length!==3) throw new Error(`Unsupported symmetry operation: ${op}`);
  return parts.map(expr=>{
    let s=String(expr).toLowerCase().replace(/\s+/g,"").replace(/−/g,"-");
    s=s.replace(/-/g,"+-");
    if(s.startsWith("+")) s=s.slice(1);
    const row=[0,0,0];
    for(const term of s.split("+").filter(Boolean)){
      const m=term.match(/[xyz]/);
      if(!m) continue; // translation part
      const idx={x:0,y:1,z:2}[m[0]];
      const coeff=cifSymRationalNumber(term.replace(m[0],""));
      if(!Number.isFinite(coeff)) throw new Error(`Unsupported symmetry term: ${term}`);
      row[idx]+=coeff;
    }
    return row;
  });
}

function inverse3x3(m){
  const [a,b,c]=m[0], [d,e,f]=m[1], [g,h,i]=m[2];
  const A=e*i-f*h, B=-(d*i-f*g), C=d*h-e*g;
  const D=-(b*i-c*h), E=a*i-c*g, F=-(a*h-b*g);
  const G=b*f-c*e, H=-(a*f-c*d), I=a*e-b*d;
  const det=a*A+b*B+c*C;
  if(Math.abs(det)<1e-12) throw new Error("A space-group symmetry matrix is singular.");
  return [[A,D,G],[B,E,H],[C,F,I]].map(row=>row.map(x=>x/det));
}

function reciprocalSymmetryMatrices(sg){
  const out=[], seen=new Set();
  for(const op of (sg?.operations||["x,y,z"])){
    const R=cifSymmetryLinearMatrix(op);
    const inv=inverse3x3(R);
    const T=[
      [inv[0][0],inv[1][0],inv[2][0]],
      [inv[0][1],inv[1][1],inv[2][1]],
      [inv[0][2],inv[1][2],inv[2][2]]
    ].map(row=>row.map(x=>Math.abs(x-Math.round(x))<1e-9?Math.round(x):x));
    const key=T.flat().map(x=>Number(x).toFixed(9)).join(",");
    if(!seen.has(key)){ seen.add(key); out.push(T); }
  }
  return out;
}

function transformReflectionHkl(M,hkl){
  const v=M.map(row=>row[0]*hkl[0]+row[1]*hkl[1]+row[2]*hkl[2]);
  return v.map(x=>{
    const y=Math.abs(x-Math.round(x))<1e-8?Math.round(x):x;
    return Object.is(y,-0)?0:y;
  });
}

function hklKey(hkl){ return hkl.map(x=>Math.round(Number(x))).join(","); }
function compareHkl(a,b){
  for(let i=0;i<3;i++){
    const d=Number(a[i])-Number(b[i]);
    if(Math.abs(d)>1e-12) return d;
  }
  return 0;
}
function firstNonzeroPositive(hkl){
  for(const x of hkl){ if(x!==0) return x>0; }
  return true;
}
function canonicalReflectionHkl(star){
  return [...star].sort((a,b)=>{
    const ap=firstNonzeroPositive(a), bp=firstNonzeroPositive(b);
    if(ap!==bp) return ap?-1:1;
    // Prefer the conventional representative with the largest h, then k, then l.
    for(let i=0;i<3;i++) if(a[i]!==b[i]) return b[i]-a[i];
    return 0;
  })[0];
}

function reflectionStar(hkl,reciprocalOps){
  const map=new Map();
  for(const M of reciprocalOps){
    const p=transformReflectionHkl(M,hkl).map(x=>{const y=Math.round(x);return Object.is(y,-0)?0:y;});
    const n=p.map(x=>x===0?0:-x);
    map.set(hklKey(p),p);
    map.set(hklKey(n),n); // Friedel pair: useful powder/full-pattern multiplicity.
  }
  return [...map.values()];
}

function currentCifReflectionBeam(){
  // Reflection wavelength follows the fixed-side energy in Instrument configuration.
  // λ/2 means the second-order wavelength: λ -> λ/2, equivalently E -> 4E.
  const energyMode=checkedValue("energyMode") || $("energyMode")?.value;
  const enteredEnergy=Number($("energy")?.value);
  if(!(enteredEnergy>0)) throw new Error(`${energyMode||"Fixed"} energy must be greater than zero to calculate reflections.`);
  const lambdaHalf=!!$("cifReflectionLambdaHalf")?.checked;
  const effectiveEnergy=lambdaHalf ? 4*enteredEnergy : enteredEnergy;
  return {
    energyMode,
    enteredEnergy,
    effectiveEnergy,
    lambdaHalf,
    wavelength:9.044/Math.sqrt(effectiveEnergy)
  };
}

function currentCifReflectionFilters(){
  return {
    alongU:!!$("cifReflectionAlongU")?.checked,
    alongV:!!$("cifReflectionAlongV")?.checked,
    withinS2Max:$("cifReflectionWithinS2Max")?.checked !== false
  };
}

function reflectionInCurrentScatteringPlane(rl,hkl){
  const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
  const {ez}=makeSpiceScatteringPlaneBasis(rl,U,V);
  const q=hklToQ(rl,hkl), qn=norm(q);
  return qn>1e-12 && Math.abs(dot(q,ez)) <= 1e-9*Math.max(1,qn);
}

function reflectionAlongCurrentAxis(rl,hkl,axisHkl){
  const q=hklToQ(rl,hkl), axis=hklToQ(rl,axisHkl);
  const qn=norm(q), an=norm(axis);
  if(!(qn>1e-12) || !(an>1e-12)) return false;
  return norm(cross(q,axis)) <= 1e-9*Math.max(1,qn*an);
}

function buildCifReflectionTable(structure,sg,wavelength,filters={alongU:true,alongV:true,withinS2Max:true},twoThetaMax=180){
  if(!structure?.lattice) throw new Error("Generated CIF has no valid lattice.");
  const lambda=Number(wavelength);
  if(!(lambda>0)) throw new Error("Reflection wavelength must be greater than zero.");
  const lattice=structure.lattice;
  const rl=RL_calc(lattice);
  const qMax=4*Math.PI/lambda;
  const hMax=Math.ceil(qMax*Number(lattice.a)/(2*Math.PI))+1;
  const kMax=Math.ceil(qMax*Number(lattice.b)/(2*Math.PI))+1;
  const lMax=Math.ceil(qMax*Number(lattice.c)/(2*Math.PI))+1;
  const candidateCount=(2*hMax+1)*(2*kMax+1)*(2*lMax+1)-1;
  if(candidateCount>3000000){
    throw new Error(`Reflection search is too large (${candidateCount.toLocaleString()} candidate hkl). Increase wavelength or use a smaller unit cell.`);
  }

  const reciprocalOps=reciprocalSymmetryMatrices(sg);
  const rows=[];
  const seenFamilies=new Set();
  const tol=1e-9;
  for(let h=-hMax;h<=hMax;h++) for(let k=-kMax;k<=kMax;k++) for(let l=-lMax;l<=lMax;l++){
    if(h===0&&k===0&&l===0) continue;
    const hkl=[h,k,l];
    const qVec=hklToQ(rl,hkl), q=norm(qVec);
    if(!(q>1e-12) || q>qMax+tol) continue;
    const star=reflectionStar(hkl,reciprocalOps);
    const familyKey=star.map(hklKey).sort().join("|");
    if(seenFamilies.has(familyKey)) continue;
    seenFamilies.add(familyKey);
    const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
    // Direction filters are intentionally compact:
    //   U only  -> reflections along U
    //   V only  -> reflections along V
    //   U + V   -> every reflection in the U-V scattering plane
    //   neither -> all reflections
    let visibleStar=star;
    if(filters?.alongU && filters?.alongV){
      visibleStar=star.filter(x=>reflectionInCurrentScatteringPlane(rl,x));
    }else if(filters?.alongU){
      visibleStar=star.filter(x=>reflectionAlongCurrentAxis(rl,x,U));
    }else if(filters?.alongV){
      visibleStar=star.filter(x=>reflectionAlongCurrentAxis(rl,x,V));
    }
    if(!visibleStar.length) continue;
    // Show one representative satisfying the active direction rule.
    // Multiplicity remains the full crystallographic star size.
    const rep=canonicalReflectionHkl(visibleStar);
    const qRep=norm(hklToQ(rl,rep));
    const arg=qRep*lambda/(4*Math.PI);
    if(arg>1+1e-10) continue;
    const twoTheta=2*rad2deg(Math.asin(clamp(arg,-1,1)));
    if(filters?.withinS2Max && Number.isFinite(twoThetaMax) && twoTheta>twoThetaMax+1e-9) continue;
    const d=2*Math.PI/qRep;
    let intensity=nuclearStructureFactorSquared(structure,rep,qRep);
    if(!Number.isFinite(intensity)) intensity=0;
    const multiplicity=star.length;
    rows.push({hkl:rep,intensity,multiplicity,totalIntensity:intensity*multiplicity,twoTheta,q:qRep,d});
  }

  // Do not show systematic/motif extinctions.  Exact extinctions can leave tiny
  // floating-point residues after symmetry expansion, so use a very small
  // relative tolerance rather than testing intensity === 0.
  const maxI=Math.max(0,...rows.map(r=>Math.abs(Number(r.intensity)||0)));
  const extinctTol=Math.max(1e-12,maxI*1e-12);
  return rows.filter(r=>Number(r.intensity)>extinctTol);
}

function sortedCifReflections(rows,sortState=cifReflectionSort){
  const out=[...(rows||[])];
  const key=sortState?.key||"intensity";
  const dir=sortState?.direction==="asc" ? 1 : -1;
  return out.sort((a,b)=>{
    const av=Number(a[key]), bv=Number(b[key]);
    const d=(av-bv)*dir;
    return d || compareHkl(a.hkl,b.hkl);
  });
}

function updateCifReflectionSortHeaders(){
  for(const th of document.querySelectorAll(".cif-sortable-th")){
    const active=th.dataset.sortKey===cifReflectionSort.key;
    const direction=active ? cifReflectionSort.direction : null;
    const indicator=th.querySelector(".cif-sort-indicator");
    if(indicator) indicator.textContent=active ? (direction==="asc" ? "▲" : "▼") : "";
    th.setAttribute("aria-sort",active ? (direction==="asc" ? "ascending" : "descending") : "none");
  }
}

function setCifReflectionSort(key){
  if(cifReflectionSort.key===key){
    cifReflectionSort={key,direction:cifReflectionSort.direction==="asc"?"desc":"asc"};
  }else{
    // Intensity-like columns are most useful descending; angular/spacing columns
    // start ascending on first click.
    const direction=(key==="intensity"||key==="totalIntensity"||key==="q") ? "desc" : "asc";
    cifReflectionSort={key,direction};
  }
  updateCifReflectionSortHeaders();
  renderCifReflectionTable();
}

function reflectionNumberText(value,digits=5){
  const x=Number(value);
  if(!Number.isFinite(x)) return "—";
  const a=Math.abs(x);
  if(a!==0 && (a>=1e5 || a<1e-4)) return x.toExponential(4);
  return x.toFixed(digits);
}

function renderCifReflectionTable(){
  const body=$("cifReflectionRows");
  if(!body) return;
  body.replaceChildren();
  if(!lastGeneratedReflections.length){
    selectedCifReflectionKey="";
    const tr=document.createElement("tr"), td=document.createElement("td");
    td.colSpan=7; td.className="cif-reflection-empty"; td.textContent="No reflections in the selected wavelength range.";
    tr.appendChild(td); body.appendChild(tr);
    return;
  }
  const rows=sortedCifReflections(lastGeneratedReflections,cifReflectionSort);
  const availableKeys=new Set(rows.map(r=>hklKey(r.hkl)));
  if(selectedCifReflectionKey && !availableKeys.has(selectedCifReflectionKey)) selectedCifReflectionKey="";
  for(const r of rows){
    const key=hklKey(r.hkl);
    const tr=document.createElement("tr");
    tr.dataset.reflectionKey=key;
    tr.tabIndex=0;
    tr.setAttribute("aria-selected",String(key===selectedCifReflectionKey));
    tr.classList.toggle("cif-reflection-selected",key===selectedCifReflectionKey);
    const values=[
      `(${r.hkl.join(" ")})`,
      reflectionNumberText(r.intensity,4),
      String(r.multiplicity),
      reflectionNumberText(r.totalIntensity,4),
      reflectionNumberText(r.twoTheta,4),
      reflectionNumberText(r.q,5),
      reflectionNumberText(r.d,5)
    ];
    values.forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td);});
    const toggle=()=>{
      selectedCifReflectionKey=(selectedCifReflectionKey===key)?"":key;
      renderCifReflectionTable();
      if(selectedCifReflectionKey){
        body.querySelector(`tr[data-reflection-key="${CSS.escape(selectedCifReflectionKey)}"]`)?.focus({preventScroll:true});
      }
    };
    tr.addEventListener("click",toggle);
    tr.addEventListener("keydown",ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();toggle();}});
    body.appendChild(tr);
  }
}

function recalculateGeneratedReflections(){
  if(!lastGeneratedCifParsed || !lastGeneratedCifSpaceGroup){
    clearCifReflectionTable("Press Generate to calculate reflections.");
    return;
  }
  try{
    const beam=currentCifReflectionBeam();
    const filters=currentCifReflectionFilters();
    let twoThetaMax=180;
    if(filters.withinS2Max){
      const inst=currentInstrument();
      twoThetaMax=Math.min(180,effectiveS2MaxAtEi(inst,beam.effectiveEnergy,beam.lambdaHalf));
      if(!Number.isFinite(twoThetaMax)) throw new Error("Instrument 2θ maximum is unavailable.");
    }
    lastGeneratedReflections=buildCifReflectionTable(lastGeneratedCifParsed,lastGeneratedCifSpaceGroup,beam.wavelength,filters,twoThetaMax);
    renderCifReflectionTable();
  }catch(err){
    lastGeneratedReflections=[];
    clearCifReflectionTable(err?.message||String(err));
  }
}

function setCifOutputTab(tab){
  const name=tab==="reflections" ? "reflections" : "preview";
  const preview=name==="preview";
  $("cifOutputTabPreview")?.classList.toggle("active",preview);
  $("cifOutputTabReflections")?.classList.toggle("active",!preview);
  $("cifOutputTabPreview")?.setAttribute("aria-selected",String(preview));
  $("cifOutputTabReflections")?.setAttribute("aria-selected",String(!preview));
  $("cifPreviewPanel")?.classList.toggle("hidden",!preview);
  $("cifReflectionsPanel")?.classList.toggle("hidden",preview);
}

function generateCifForReview(){
  const generated=buildGeneratedCif();
  lastGeneratedCifText=generated.text;
  lastGeneratedCifName=generated.filename;
  lastGeneratedCifParsed=generated.parsed;
  lastGeneratedCifSpaceGroup=generated.sg;
  if($("cifPreview")) $("cifPreview").textContent=generated.text;
  setCifGeneratedReady(true);
  recalculateGeneratedReflections();
  setCifGeneratorMessage(`Generated ${generated.filename}: ${generated.sg.hm}, ${generated.atoms.length} asymmetric site(s), ${generated.parsed.atoms.length} expanded atom(s). Review the CIF and reflections, then Download CIF or Set CIF.`);
  return generated;
}

function downloadGeneratedCif(text,filename){
  const blob=new Blob([text],{type:"chemical/x-cif;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),0);
}

function normalizedSpaceGroupSymbol(value){
  return String(value||"").toLowerCase().replace(/[\s_'".]/g,"");
}

function findGeneratorSpaceGroup(parsed){
  const n=Number(parsed?.spaceGroupNumber);
  if(Number.isFinite(n)){
    const byNumber=cifSpaceGroups.find(x=>x.number===n);
    if(byNumber) return byNumber;
  }
  const sym=normalizedSpaceGroupSymbol(parsed?.spaceGroup);
  if(!sym) return null;
  return cifSpaceGroups.find(x=>normalizedSpaceGroupSymbol(x.hm)===sym || normalizedSpaceGroupSymbol(x.hall)===sym) || null;
}

async function loadCifIntoGenerator(file){
  if(!file) return;
  const text=await file.text();
  const parsed=parseCifStructure(text);
  const sg=findGeneratorSpaceGroup(parsed);
  if(!sg) throw new Error(`Could not identify a supported standard-setting space group from ${file.name}.`);
  const lattice=parsed.lattice || {};
  for(const key of ["a","b","c","alpha","beta","gamma"]){
    const v=Number(lattice[key]);
    if(!Number.isFinite(v)) throw new Error(`Could not load ${file.name}: lattice parameter ${key} is missing or invalid.`);
  }
  if(!Array.isArray(parsed.asymmetricSites) || !parsed.asymmetricSites.length) throw new Error(`Could not load asymmetric-unit atoms from ${file.name}.`);
  $("cifSpaceGroup").value=String(sg.number);
  for(const [key,id] of Object.entries(CIF_LATTICE_FIELDS)) $(id).value=String(lattice[key]);
  replaceCifAtomRows(parsed.asymmetricSites.map(a=>({element:a.element,x:a.x,y:a.y,z:a.z,occupancy:a.occupancy})));
  if($("cifGeneratedName")) $("cifGeneratedName").value=cleanCifFileName(file.name);
  updateCifSpaceGroupInfo();
  invalidateGeneratedCif("");
  setCifGeneratorMessage(`Loaded ${file.name} for editing: #${sg.number} ${sg.hm}, ${parsed.asymmetricSites.length} asymmetric site(s). Press Generate to review the regenerated CIF and reflection table.`);
}

async function initializeCifGenerator(){
  const select=$("cifSpaceGroup");
  if(!select) return;
  try{
    const response=await fetch("space-groups.json",{cache:"no-store"});
    if(!response.ok) throw new Error(`space-groups.json returned HTTP ${response.status}`);
    const data=await response.json();
    cifSpaceGroups=Array.isArray(data) ? data : data.space_groups;
    if(!Array.isArray(cifSpaceGroups) || cifSpaceGroups.length!==230) throw new Error("space-groups.json does not contain the expected 230 standard space groups.");
    populateSampleSpaceGroupControls();
    select.replaceChildren();
    for(const sg of cifSpaceGroups){
      const opt=document.createElement("option"); opt.value=String(sg.number); opt.textContent=`${sg.number} — ${sg.hm}`; select.appendChild(opt);
    }
    select.value="1";
    syncCifSpaceGroupNumberFromSelect();
    copyCurrentLatticeToGenerator();
    addCifAtomRow({element:"",x:0,y:0,z:0,occupancy:1},{invalidate:false});
    updateCifSpaceGroupInfo();

    setCifGeneratedReady(false);
    clearCifReflectionTable("Press Generate to calculate reflections.");
    setCifOutputTab("preview");

    select.addEventListener("change",updateCifSpaceGroupInfo);
    $("cifSpaceGroupNumber")?.addEventListener("change",jumpToCifSpaceGroupNumber);
    $("cifSpaceGroupNumber")?.addEventListener("keydown",ev=>{ if(ev.key==="Enter"){ ev.preventDefault(); jumpToCifSpaceGroupNumber(); } });
    $("cifA")?.addEventListener("input",applyCifLatticeConstraints);

    // Any structure-input edit invalidates the reviewed/generated snapshot.
    // Download/Set therefore always operate on exactly what the user last reviewed.
    const inputPane=document.querySelector(".cif-generator-input-pane");
    const outputPane=document.querySelector(".cif-generator-output-pane");

    // Keep the CIF output frame equal to the actual Structure input frame on
    // desktop.  The output content itself remains scrollable; generated CIF
    // text / reflection rows must never grow the outer workspace.
    const syncCifOutputPaneHeight=()=>{
      if(!inputPane || !outputPane) return;
      if(window.matchMedia("(max-width: 1180px)").matches){
        outputPane.style.height="";
        return;
      }
      const h=Math.ceil(inputPane.getBoundingClientRect().height);
      if(h>0) outputPane.style.height=`${h}px`;
    };
    if(typeof ResizeObserver!=="undefined" && inputPane){
      const cifInputResizeObserver=new ResizeObserver(syncCifOutputPaneHeight);
      cifInputResizeObserver.observe(inputPane);
    }
    window.addEventListener("resize",syncCifOutputPaneHeight);
    requestAnimationFrame(syncCifOutputPaneHeight);

    inputPane?.addEventListener("input",ev=>{
      if(ev.target?.id==="cifLoadFile") return;
      invalidateGeneratedCif();
    });
    inputPane?.addEventListener("change",ev=>{
      if(ev.target?.id==="cifLoadFile") return;
      invalidateGeneratedCif();
    });

    $("cifCopyLattice")?.addEventListener("click",()=>{
      copyCurrentLatticeToGenerator();
      invalidateGeneratedCif("Current sample lattice copied — press Generate to review the updated CIF.");
    });
    $("cifAddAtom")?.addEventListener("click",()=>addCifAtomRow());
    $("cifLoadExisting")?.addEventListener("click",()=>$("cifLoadFile")?.click());
    $("cifLoadFile")?.addEventListener("change",async ev=>{
      const file=ev.target.files?.[0];
      try{ await loadCifIntoGenerator(file); }
      catch(err){ setCifGeneratorMessage(err?.message||String(err),true); }
      finally{ ev.target.value=""; }
    });

    $("cifGenerate")?.addEventListener("click",()=>{
      try{ generateCifForReview(); }
      catch(err){
        invalidateGeneratedCif("");
        setCifGeneratorMessage(err?.message||String(err),true);
      }
    });
    $("cifDownload")?.addEventListener("click",()=>{
      if(!lastGeneratedCifText){ setCifGeneratorMessage("Press Generate before downloading.",true); return; }
      downloadGeneratedCif(lastGeneratedCifText,lastGeneratedCifName);
      setCifGeneratorMessage(`Downloaded ${lastGeneratedCifName}.`);
    });
    $("cifSet")?.addEventListener("click",()=>{
      try{
        if(!lastGeneratedCifText) throw new Error("Press Generate before setting the CIF.");
        if($("sampleMode")?.value!=="single"){
          $("sampleMode").value="single"; updateModeVisibility();
        }
        const parsed=loadCifText(lastGeneratedCifText,lastGeneratedCifName);
        setCifGeneratorMessage(`Set ${lastGeneratedCifName} as the selected CIF: ${parsed.atoms.length} expanded atom(s).`);
      }catch(err){ setCifGeneratorMessage(err?.message||String(err),true); }
    });

    for(const button of document.querySelectorAll("[data-cif-output-tab]")){
      button.addEventListener("click",()=>setCifOutputTab(button.dataset.cifOutputTab));
    }
    for(const th of document.querySelectorAll(".cif-sortable-th")){
      const activate=()=>setCifReflectionSort(th.dataset.sortKey);
      th.addEventListener("click",activate);
      th.addEventListener("keydown",ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();activate();}});
    }
    updateCifReflectionSortHeaders();
    const reflectionFilterIds=[
      "cifReflectionAlongU","cifReflectionAlongV",
      "cifReflectionWithinS2Max","cifReflectionLambdaHalf"
    ];
    for(const id of reflectionFilterIds){
      $(id)?.addEventListener("change",recalculateGeneratedReflections);
    }
    // The reflection wavelength is derived from Instrument configuration, so a
    // fixed-energy change updates the generated reflection table automatically.
    $("energy")?.addEventListener("change",recalculateGeneratedReflections);
    $("energyMode")?.addEventListener("change",recalculateGeneratedReflections);
    $("instrument")?.addEventListener("change",recalculateGeneratedReflections);
    $("S2maxUser")?.addEventListener("change",recalculateGeneratedReflections);
    $("S2maxEffective")?.addEventListener("change",recalculateGeneratedReflections);
    for(const id of ["Uh","Uk","Ul","Vh","Vk","Vl"]){
      $(id)?.addEventListener("change",recalculateGeneratedReflections);
    }
  }catch(err){
    select.innerHTML='<option value="">Space-group data unavailable</option>';
    for(const id of ["cifLoadExisting","cifGenerate","cifDownload","cifSet","cifSpaceGroupNumber"]){ if($(id)) $(id).disabled=true; }
    setCifGeneratorMessage(`CIF Generator could not load space-group data: ${err?.message||String(err)}`,true);
  }
}

function num(id){ return Number($(id).value); }

// Temporary numerical sign-label swap.
// Beamline checks indicate that the current internal +-+ and -+- branches are
// associated with the opposite user-facing labels. Keep the UI unchanged and
// swap only when the selected sign enters TAS/Q-E numerical calculations.
function calculationTasSense(uiSense){
  if(uiSense==="+-+") return "-+-";
  if(uiSense==="-+-") return "+-+";
  return uiSense;
}

function checkedValue(name){
  const direct=$(name);
  if(direct && direct.tagName==="SELECT") return direct.value;
  const el=document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}
function setRadio(name,value){
  const direct=$(name);
  if(direct && direct.tagName==="SELECT") { direct.value=value; return; }
  const el=document.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
  if(el) el.checked=true;
}
function showError(err){
  $("errorBox").textContent = err instanceof Error ? err.message : String(err);
  $("errorBox").classList.remove("hidden");
}
function clearError(){ $("errorBox").classList.add("hidden"); $("errorBox").textContent=""; }
function setStatus(text){ $("status").textContent=text; }

function hklToQ(rl,hkl){
  return add(add(scale(rl.astar,hkl[0]),scale(rl.bstar,hkl[1])),scale(rl.cstar,hkl[2]));
}

// Resolve orientation labels to a canonical physical orientation before any
// TAS / Q-E / Dark-angle calculation. Parallel and perpendicular are NOT
// separate numerical branches: when two labels describe the same directed
// ki axis in the entered scattering plane, they share exactly the same
// downstream calculation.
//
// The perpendicular direction is chosen from the other entered plane vector
// so the U/V handedness fixes the sign unambiguously:
//   ki ⟂ U : V-side component perpendicular to U
//   ki ⟂ V : U-side component perpendicular to V
//
// Therefore, for an orthogonal U/V plane:
//   ki ∥ V == ki ⟂ U
//   ki ∥ U == ki ⟂ V
function canonicalOrientationMode(rl, rawMode=null){
  const mode=rawMode ?? ($('orientationReference')?.value || 'bragg');
  if(mode==='bragg' || mode==='perpU' || mode==='perpV') return mode;
  if(mode!=='parallelU' && mode!=='parallelV') return mode;

  const U=[num('Uh'),num('Uk'),num('Ul')];
  const V=[num('Vh'),num('Vk'),num('Vl')];
  const qU=hklToQ(rl,U), qV=hklToQ(rl,V);
  const u2=dot(qU,qU), v2=dot(qV,qV);
  if(!(u2>1e-20) || !(v2>1e-20)) return mode;

  const perpToU=sub(qV,scale(qU,dot(qV,qU)/u2)); // entered V side
  const perpToV=sub(qU,scale(qV,dot(qU,qV)/v2)); // entered U side
  if(norm(perpToU)<=1e-12 || norm(perpToV)<=1e-12) return mode;

  const parallelAxis=normalize(mode==='parallelU' ? qU : qV);
  const equivalentPerpAxis=normalize(mode==='parallelU' ? perpToV : perpToU);

  // Collapse only when the two labels really are the same directed physical
  // orientation. Non-orthogonal U/V cases remain distinct.
  if(dot(parallelAxis,equivalentPerpAxis) > 1-1e-10){
    return mode==='parallelU' ? 'perpV' : 'perpU';
  }
  return mode;
}

// Convert every orientation-reference mode into the original Reference-Q
// calibration pair {HKL, S1}.  Downstream geometry intentionally stays on the
// validated Reference-Q pipeline.
//
// For ki perpendicular U/V, imagine observing the elastic U/V Bragg peak.  In
// the usual theta--2theta geometry the sample is theta=S2/2 away from the
// ki-perpendicular condition.  Therefore, if ki perpendicular U/V is defined as
// the new S1=0, that virtual Bragg observation has S1_ref = -S2_ref/2.
function effectiveOrientationReference(rl, fixedEnergyMeV=null, uiSenseOverride=null){
  const rawMode=$('orientationReference')?.value || 'bragg';
  const mode=canonicalOrientationMode(rl,rawMode);
  if(mode==='bragg'){
    return {mode,hkl:[num('refh'),num('refk'),num('refl')],s1:num('refs1')};
  }
  const usesV=mode==='perpV' || mode==='parallelV';
  const isParallel=mode==='parallelU' || mode==='parallelV';
  const hkl=usesV
    ? [num('Vh'),num('Vk'),num('Vl')]
    : [num('Uh'),num('Uk'),num('Ul')];
  const qNorm=norm(hklToQ(rl,hkl));
  const E=Number(fixedEnergyMeV);
  if(!(qNorm>1e-12)) throw new Error(`${usesV?'V':'U'} must define a non-zero reciprocal-space vector.`);
  if(!(E>0)) throw new Error('A positive reference energy is required for ki orientation.');
  const k=Math.sqrt(E/2.072);
  const arg=qNorm/(2*k);
  if(arg>1+1e-10) throw new Error(`${usesV?'V':'U'} Bragg peak is inaccessible at the selected reference energy.`);
  const s2Ref=2*rad2deg(Math.asin(clamp(arg,-1,1)));

  // S1 is counter-clockwise positive in both configurations.  Starting from
  // the physical S1=0 condition where ki is perpendicular to U/V, the elastic
  // Bragg position lies at -theta for user-facing +-+ and +theta for -+-.
  // Using -theta for both configurations shifts the -+- perpendicular
  // condition by 2*theta = S2.
  const uiSense=uiSenseOverride ?? checkedValue("sense");
  const c2Sign=(uiSense==="+-+") ? +1 : -1;
  let s1Ref=-c2Sign*0.5*s2Ref;
  // ki ∥ U/V uses the same virtual elastic Bragg reference as ki ⟂ U/V,
  // but moves the S1=0 sample orientation by +90 degrees about the plane normal.
  if(isParallel) s1Ref+=c2Sign*90;
  return {mode,hkl,s1:wrap180(s1Ref),s2Ref};
}

function updateOrientationReferenceUI(){
  const mode=$('orientationReference')?.value || 'bragg';
  $('braggReferenceInputs')?.classList.toggle('hidden',mode!=='bragg');
}

function applyDarkAngleSlotColors(){
  // Dark-angle cards/checkbox labels use one neutral black UI style.
  for(const slot of darkAssetSlots()){
    const label=$(darkAssetIds(slot).enable)?.closest("label");
    const caption=label?.querySelector("span");
    if(caption){ caption.style.color="#111"; caption.style.fontWeight="700"; }
  }
}

function updateGeometryQuickTargetButtons(){
  const mode=$('orientationReference')?.value || 'perpU';
  const bragg=mode==='bragg';
  $('geomPerpU')?.classList.toggle('hidden',mode!=='perpU');
  $('geomPerpV')?.classList.toggle('hidden',mode!=='perpV');
  $('geomParallelU')?.classList.toggle('hidden',mode!=='parallelU');
  $('geomParallelV')?.classList.toggle('hidden',mode!=='parallelV');
  $('geomSetBragg')?.classList.toggle('hidden',!bragg);
  if($('geomPerpU')) $('geomPerpU').textContent='Set ki ⟂ U';
  if($('geomPerpV')) $('geomPerpV').textContent='Set ki ⟂ V';
  if($('geomParallelU')) $('geomParallelU').textContent='Set ki ∥ U';
  if($('geomParallelV')) $('geomParallelV').textContent='Set ki ∥ V';

  const container=document.querySelector(".geometry-target-all-buttons");
  if(!container) return;
  const slots=darkAssetSlots();

  for(const button of [...container.querySelectorAll(".geom-dark-ref-button")]){
    const slot=Number(button.dataset.darkSlot);
    if(!slots.includes(slot)) button.remove();
  }

  const showDark=!!$('addDark')?.checked;
  for(const slot of slots){
    let button=$(`geomSetRefQ${slot}`);
    if(!button){
      button=document.createElement("button");
      button.id=`geomSetRefQ${slot}`;
      button.type="button";
      button.className="geom-dark-ref-button hidden";
      button.dataset.darkSlot=String(slot);
      button.textContent=`Set Ref Q${slot}`;
      button.addEventListener("click",()=>setGeometryTargetFromDarkRef(slot));
      container.appendChild(button);
    }
    const ids=darkAssetIds(slot);
    const visible=showDark && !!$(ids.enable)?.checked && checkedValue(ids.ref)==='Reference Q';
    button.classList.toggle('hidden',!visible);
  }
}
function formatHKL(v){
  return v.map(x=>Math.abs(x-Math.round(x))<1e-10?String(Math.round(x)):x.toFixed(3)).join(",");
}

function isAllowedByCentering(hkl, centering){
  const rounded=hkl.map(x=>Math.round(x));

  // Centering extinction rules are defined for integer Miller indices.
  // If a generated point is not integer-valued, leave it unchanged.
  if(hkl.some((x,i)=>Math.abs(x-rounded[i])>1e-10)) return true;

  const [h,k,l]=rounded;
  const even = x => Math.abs(x)%2===0;

  switch(centering){
    case "I":
      return even(h+k+l);
    case "F":
      return (even(h) && even(k) && even(l)) ||
             (!even(h) && !even(k) && !even(l));
    case "A":
      return even(k+l);
    case "B":
      return even(h+l);
    case "C":
      return even(h+k);
    case "R":
      return ((-h+k+l)%3+3)%3===0;
    case "P":
    default:
      return true;
  }
}
function maxArray(a){ return Math.max(...a); }

async function fetchJson(url){
  const response = await fetch(url, {cache: "no-store"});

  if(!response.ok){
    throw new Error(`${url} を読み込めませんでした (HTTP ${response.status})。`);
  }

  return await response.json();
}

function normalizeJsonFileList(value){
  if(Array.isArray(value)){
    return value.map(String);
  }

  // Optional alternative manifest format:
  // { "files": ["a.json", "b.json"] }
  if(value && Array.isArray(value.files)){
    return value.files.map(String);
  }

  throw new Error("index.json は JSON ファイル名の配列、または {files:[...]} である必要があります。");
}

function isGitHubPages(){ return window.location.hostname.endsWith("github.io"); }

async function discoverJsonFilesFromGitHub(directory){
  const owner=window.location.hostname.split('.')[0];
  const parts=window.location.pathname.split('/').filter(Boolean);
  const repo=parts[0];
  if(!repo) throw new Error("GitHub Pages repository name could not be inferred. Add directory/index.json.");
  const apiUrl=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${directory}?ref=main`;
  const response=await fetch(apiUrl,{cache:"no-store",headers:{"Accept":"application/vnd.github+json"}});
  if(!response.ok) throw new Error(`GitHub API: ${directory}/ (HTTP ${response.status})`);
  const items=await response.json();
  return items.filter(x=>x&&x.type==="file").map(x=>x.name).filter(x=>/\.json$/i.test(x)&&x.toLowerCase()!=="index.json").sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}

async function discoverJsonFilesFromDirectoryListing(directory){
  const response = await fetch(`${directory}/`, {cache: "no-store"});

  if(!response.ok){
    throw new Error(
      `${directory}/ を読み込めませんでした。` +
      ` ディレクトリがプロジェクト内にあるか確認してください。`
    );
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const files = [...doc.querySelectorAll("a[href]")]
    .map(a => a.getAttribute("href"))
    .filter(Boolean)
    .map(href => {
      try{
        const url = new URL(href, window.location.href);
        return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      }catch(_err){
        return null;
      }
    })
    .filter(Boolean)
    .filter(name => /\.json$/i.test(name))
    .filter(name => name.toLowerCase() !== "index.json");

  return [...new Set(files)].sort((a,b)=>a.localeCompare(b));
}

async function discoverJsonFiles(directory){
  // 1) If an index.json exists, use it. This remains supported for
  //    compatibility with other static hosting services.
  try{
    const manifestResponse = await fetch(
      `${directory}/index.json`,
      {cache: "no-store"}
    );

    if(manifestResponse.ok){
      const manifest = await manifestResponse.json();

      const files = normalizeJsonFileList(manifest)
        .filter(name => /\.json$/i.test(name))
        .filter(name => name.toLowerCase() !== "index.json");

      if(files.length > 0){
        return files.sort((a,b)=>a.localeCompare(b));
      }
    }
  }catch(_err){
    // Continue to automatic discovery.
  }

  // 2) On GitHub Pages, GitHub does not expose an HTML directory listing.
  //    Query the public GitHub Contents API instead. This means that adding
  //    a new JSON file to the repository is enough; index.json does not need
  //    to be maintained manually.
  if(isGitHubPages()){
    const files = await discoverJsonFilesFromGitHub(directory);

    if(files.length === 0){
      throw new Error(`${directory}/ に JSON ファイルがありません。`);
    }

    return files;
  }

  // 3) Local development with e.g. "python -m http.server 8888".
  //    Python exposes a directory listing, so parse that automatically.
  const files = await discoverJsonFilesFromDirectoryListing(directory);

  if(files.length === 0){
    throw new Error(
      `${directory}/ に JSON ファイルを見つけられませんでした。`
    );
  }

  return files;
}

async function loadJsonDirectory(directory, targetMap){
  targetMap.clear();

  const files = await discoverJsonFiles(directory);

  for(const filename of files){
    const obj = await fetchJson(`${directory}/${filename}`);
    const key = filename.replace(/\.json$/i, "");
    targetMap.set(key, obj);
  }

  return files.length;
}

function normalizeCifFileList(value){
  if(Array.isArray(value)) return value.map(String);
  if(value && Array.isArray(value.files)) return value.files.map(String);
  throw new Error("BG_material/index.json must be an array of CIF filenames or {files:[...]}. ");
}

async function discoverCifFilesFromGitHub(directory){
  const owner=window.location.hostname.split('.')[0];
  const parts=window.location.pathname.split('/').filter(Boolean);
  const repo=parts[0];
  if(!repo) throw new Error("GitHub Pages repository name could not be inferred. Add BG_material/index.json.");
  const apiUrl=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${directory}?ref=main`;
  const response=await fetch(apiUrl,{cache:"no-store",headers:{"Accept":"application/vnd.github+json"}});
  if(!response.ok) throw new Error(`GitHub API: ${directory}/ (HTTP ${response.status})`);
  const items=await response.json();
  return items
    .filter(x=>x&&x.type==="file")
    .map(x=>x.name)
    .filter(x=>/\.cif$/i.test(x))
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}

async function discoverCifFilesFromDirectoryListing(directory){
  const response=await fetch(`${directory}/`,{cache:"no-store"});
  if(!response.ok) throw new Error(`${directory}/ could not be loaded (HTTP ${response.status}).`);
  const html=await response.text();
  const doc=new DOMParser().parseFromString(html,"text/html");
  const files=[...doc.querySelectorAll("a[href]")]
    .map(a=>a.getAttribute("href"))
    .filter(Boolean)
    .map(href=>{
      try{
        const url=new URL(href,window.location.href);
        return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop()||"");
      }catch(_err){ return null; }
    })
    .filter(Boolean)
    .filter(name=>/\.cif$/i.test(name));
  return [...new Set(files)].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}

async function discoverCifFiles(directory){
  // Optional manifest for static hosts that do not expose directory listings.
  try{
    const response=await fetch(`${directory}/index.json`,{cache:"no-store"});
    if(response.ok){
      const manifest=await response.json();
      const files=normalizeCifFileList(manifest).filter(name=>/\.cif$/i.test(name));
      if(files.length) return files.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
    }
  }catch(_err){}

  if(isGitHubPages()) return await discoverCifFilesFromGitHub(directory);
  return await discoverCifFilesFromDirectoryListing(directory);
}

async function loadCifDirectory(directory,targetMap){
  targetMap.clear();
  const files=await discoverCifFiles(directory);
  const errors=[];
  for(const filename of files){
    try{
      const response=await fetch(`${directory}/${filename}`,{cache:"no-store"});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const text=await response.text();
      const structure=parseCifStructure(text);
      const key=filename.replace(/\.cif$/i,"");
      targetMap.set(key,{key,filename,structure});
    }catch(err){
      errors.push(`${filename}: ${err?.message||err}`);
    }
  }
  if(errors.length) console.warn("BG_material CIF load warning(s):\n"+errors.join("\n"));
  return targetMap.size;
}

function refreshBackgroundSelect(select,emptyLabel="None"){
  select.innerHTML="";
  const empty=document.createElement("option");
  empty.value="";
  empty.textContent=emptyLabel;
  select.appendChild(empty);
  [...backgroundMaterials.keys()]
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}))
    .forEach(key=>{
      const op=document.createElement("option");
      op.value=key;
      op.textContent=key;
      select.appendChild(op);
    });
}

function refreshSelect(map,select,emptyLabel){
  select.innerHTML="";
  if(emptyLabel!==null){
    const op=document.createElement("option");
    op.value=""; op.textContent=emptyLabel;
    select.appendChild(op);
  }
  [...map.entries()]
    .sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true,sensitivity:"base"}))
    .forEach(([key,obj])=>{
      const op=document.createElement("option");
      op.value=key;
      op.textContent=obj.name || key;
      select.appendChild(op);
    });
}

function currentInstrument(){
  const key=$("instrument").value;
  if(!key || !instruments.has(key)) throw new Error("Instrument を選択してください。");
  return instruments.get(key);
}
function rangeTable(inst){
  if(Array.isArray(inst.S2_limits)) return inst.S2_limits;
  if(inst.qe_range && Array.isArray(inst.qe_range.S2_limits)) return inst.qe_range.S2_limits;
  if(inst.qe_range && Array.isArray(inst.qe_range.configuration)) return inst.qe_range.configuration;
  if(Array.isArray(inst.configuration)) return inst.configuration; // legacy QErange JSON
  throw new Error("Selected instrument has no S2-limit table. Add S2_limits to the unified instrument JSON (or keep the legacy instruments/ directory during migration).");
}
function instrumentInterp(inst,lambdaHalf=false){
  const table=rangeTable(inst);
  const pairs=table.map(x=>[Number(x.Ei)*(lambdaHalf?4:1),Number(x.S2limit)]).sort((a,b)=>a[0]-b[0]);
  const xp=pairs.map(x=>x[0]), yp=pairs.map(x=>x[1]);
  return x=>interpExtrap(xp,yp,x);
}

// S2-limit policy is explicit in the instrument JSON.
//   s2_dep_ei = "yes": the JSON S2 maximum is evaluated from the Ei-dependent
//                      curve.  The user may edit either Delta S2 or the current
//                      Effective S2 max; editing Effective converts it back to a
//                      single Delta that is then applied to the full Ei curve.
//   s2_dep_ei = "no" : the JSON S2 maximum is constant, but the same two-way
//                      Delta/Effective controls are retained for a uniform UI.
// Legacy files without the flag keep backward-compatible behavior: if the
// table actually varies in S2limit, it is treated as Ei-dependent.
function s2DependsOnEi(inst){
  const raw=inst?.s2_dep_ei ?? inst?.qe_range?.s2_dep_ei;
  if(typeof raw==='string'){
    const v=raw.trim().toLowerCase();
    if(v==='yes') return true;
    if(v==='no') return false;
  }
  if(typeof raw==='boolean') return raw;
  const values=rangeTable(inst).map(x=>Number(x.S2limit)).filter(Number.isFinite);
  return values.some(v=>Math.abs(v-values[0])>1e-10);
}
function configuredConstantS2Max(inst){
  const first=rangeTable(inst).map(x=>Number(x.S2limit)).find(Number.isFinite);
  if(!Number.isFinite(first)) throw new Error('Selected instrument has no valid S2 maximum.');
  return first;
}
function s2ElasticIncidentEnergy(){
  const entered=num('energy');
  if(!(entered>0)) return NaN;
  return $('lambdaHalf')?.checked ? 4*entered : entered;
}
function baseS2MaxAtEi(inst,Ei,lambdaHalf=false){
  return s2DependsOnEi(inst) ? Number(instrumentInterp(inst,lambdaHalf)(Ei)) : configuredConstantS2Max(inst);
}
function effectiveS2MaxAtEi(inst,Ei,lambdaHalf=false){
  const base=baseS2MaxAtEi(inst,Ei,lambdaHalf);
  const raw=$('S2maxUser')?.value;
  const delta=(raw===undefined||raw===null||String(raw).trim()==='') ? 0 : Number(raw);
  return base+(Number.isFinite(delta)?delta:0);
}
function formatS2ControlValue(x){
  return Number.isFinite(Number(x)) ? String(Number(Number(x).toFixed(3))) : '';
}
function initializeS2MaxControl(inst=currentInstrument()){
  if(!$('S2maxUser')) return;
  // Start from the instrument JSON value for every instrument.  Users can then
  // modify either Delta S2 or Effective S2 max without changing the JSON model.
  $('S2maxUser').value='0';
  updateS2MaxDisplay(inst);
}
function currentS2DisplayContext(inst=null,EiOverride=NaN,lambdaHalfOverride=null){
  inst=inst||currentInstrument();
  const lambdaHalf=lambdaHalfOverride===null
    ? (checkedValue('sampleMode')==='single' && !!$('lambdaHalf')?.checked)
    : !!lambdaHalfOverride;
  const Ei0=Number.isFinite(Number(EiOverride)) ? Number(EiOverride) : s2ElasticIncidentEnergy();
  const base=Number.isFinite(Ei0) ? baseS2MaxAtEi(inst,Ei0,lambdaHalf) : configuredConstantS2Max(inst);
  return {inst,lambdaHalf,Ei0,base};
}
function updateS2MaxDisplay(inst=null,EiOverride=NaN,lambdaHalfOverride=null){
  if(!$('S2maxUser') || !$('S2maxBase') || !$('S2maxEffective')) return;
  try{
    const ctx=currentS2DisplayContext(inst,EiOverride,lambdaHalfOverride);
    const deltaRaw=$('S2maxUser').value;
    const delta=(deltaRaw===undefined||deltaRaw===null||String(deltaRaw).trim()==='') ? 0 : Number(deltaRaw);
    const effective=ctx.base+(Number.isFinite(delta)?delta:0);
    $('S2maxBase').value=formatS2ControlValue(ctx.base);
    $('S2maxEffective').value=formatS2ControlValue(effective);

    // JSON S2 max is metadata and stays read-only.  Delta and Effective are
    // deliberately both editable; they are synchronized bidirectionally.
    $('S2maxBase').readOnly=true;
    $('S2maxUser').readOnly=false;
    $('S2maxEffective').readOnly=false;

    if($('s2MaxBaseLabel')?.firstChild) $('s2MaxBaseLabel').firstChild.nodeValue='JSON S2 max (deg)';
    if($('s2MaxControlLabel')?.firstChild) $('s2MaxControlLabel').firstChild.nodeValue='ΔS2 max (deg)';
    if($('s2MaxEffectiveLabel')?.firstChild) $('s2MaxEffectiveLabel').firstChild.nodeValue='Effective S2 max (deg)';
    $('s2MaxEffectiveLabel')?.classList.remove('hidden');

    $('S2maxUser').title='Relative offset added to the JSON S2 maximum.';
    $('S2maxEffective').title=s2DependsOnEi(ctx.inst)
      ? 'Absolute S2 maximum at the currently displayed Ei. Editing this converts the value to ΔS2 and applies that Δ across the Ei-dependent curve.'
      : 'Absolute S2 maximum. Editing this automatically updates ΔS2.';
  }catch(_err){
    $('S2maxBase').value=''; $('S2maxEffective').value='';
  }
}
function syncS2DeltaFromEffective(){
  if(!$('S2maxUser') || !$('S2maxEffective')) return;
  try{
    let inst=currentInstrument(), EiOverride=NaN, lambdaHalfOverride=null;
    if(singleCache?.hwList?.length && $('hwSlider')){
      const i=Math.max(0,Math.min(Number($('hwSlider').value)||0,singleCache.hwList.length-1));
      const hw=Number(singleCache.hwList[i])||0;
      EiOverride=singleCache.energyMode==='Ef fixed' ? singleCache.Ef+hw : singleCache.Ei;
      inst=singleCache.inst||inst;
      lambdaHalfOverride=singleCache.lambdaHalf;
    }
    const ctx=currentS2DisplayContext(inst,EiOverride,lambdaHalfOverride);
    const effective=Number($('S2maxEffective').value);
    if(!Number.isFinite(effective)) return;
    $('S2maxUser').value=formatS2ControlValue(effective-ctx.base);
  }catch(_err){}
}
function updateS2MaxDisplayForQERange(cache,index){
  if(!cache?.hwList?.length) return;
  const i=Math.max(0,Math.min(Number(index)||0,cache.hwList.length-1));
  const hw=Number(cache.hwList[i])||0;
  const Ei=cache.energyMode==='Ef fixed' ? cache.Ef+hw : cache.Ei;
  updateS2MaxDisplay(cache.inst,Ei,cache.lambdaHalf);
}
function validateEffectiveS2Max(S2max,S2min,Ei){
  if(!Number.isFinite(S2max)) throw new Error('S2 maximum is not a finite number.');
  if(S2max>180) throw new Error(`Effective S2 maximum (${S2max.toFixed(2)}°) exceeds 180°${Number.isFinite(Ei)?` at Ei=${Ei.toFixed(2)} meV`:''}.`);
  if(S2max<=S2min) throw new Error(`Effective S2 maximum (${S2max.toFixed(2)}°) must be greater than S2 minimum (${S2min.toFixed(2)}°)${Number.isFinite(Ei)?` at Ei=${Ei.toFixed(2)} meV`:''}.`);
  return S2max;
}

function normalizeCrystalName(name){ const aliases={PG002:"PG(002)",PG004:"PG(004)"}; return aliases[name]||name; }
function setIf(id,x){ if($(id)&&x!==undefined&&x!==null&&Number.isFinite(Number(x))) $(id).value=x; }
function setBool(id,x){ if($(id)&&x!==undefined&&x!==null) $(id).checked=!!x; }
function setSelect(id,x){ if(!$(id)||x===undefined||x===null) return; if([...$(id).options].some(o=>o.value===String(x))) $(id).value=String(x); }
const CRYSTALS={'PG(002)':3.355,'PG(004)':1.677,'Heusler':3.437,'CoFe':1.771,'Ge(111)':3.266,'Ge(311)':1.714,'Ge(511)':1.089,'Ge(533)':0.863,'Si(111)':3.135,'Cu(111)':2.087,'Cu(002)':1.807,'Cu(220)':1.278,'Other':null};
function fillCrystal(selectId,dId){ const s=$(selectId); s.innerHTML=''; for(const k of Object.keys(CRYSTALS)){const o=document.createElement('option');o.value=k;o.textContent=k;s.appendChild(o);} s.value='PG(002)'; s.addEventListener('change',()=>{const d=CRYSTALS[s.value];if(d!=null) $(dId).value=d; $(dId).disabled=false;}); $(dId).disabled=false; }
function updateSupermirrorUI(){ const on=$("gm1").checked; $("div1m").disabled=!on; $("div1h").disabled=on; $("div1v").disabled=on; }

function applyInstrumentDefaults(){
  if(!$("instrument").value) return;
  const inst=currentInstrument();
  const cfg=(!Array.isArray(inst.configuration) && inst.configuration) ? inst.configuration : {};
  const qr=inst.qe_range||{};
  const energyMode=cfg.energy_mode || qr.energy_mode || inst.energy_mode || "Ef fixed";
  setSelect("energyMode",energyMode);
  const defaultEnergy=energyMode==="Ei fixed" ? (cfg.Ei ?? cfg.Ef ?? qr.default_energy ?? inst.default_energy ?? 14.7) : (cfg.Ef ?? cfg.Ei ?? qr.default_energy ?? inst.default_energy ?? 14.7);
  setIf("energy",defaultEnergy);
  setIf("S2min",qr.S2_min ?? inst.S2_min ?? inst.default_S2min ?? 8.0);
  initializeS2MaxControl(inst);
  setSelect("sense",cfg.sign || qr.sense || inst.sense || "-+-");
  setSelect("geometry",cfg.geometry || "W");
  setSelect("method",(inst.approximation||{}).method);

  const mono=inst.monochromator||{}, ana=inst.analyzer||{}, col=inst.collimator||{}, sm=inst.supermirror||{}, dist=inst.distance||{}, beam=inst.beam||{}, det=inst.detector||{};
  setBool("gm1",sm.enabled); setIf("div1m",sm.m_value); setIf("div1h",col['1st_h']);setIf("div1v",col['1st_v']);setIf("div2h",col['2nd_h']);setIf("div2v",col['2nd_v']);setIf("div3h",col['3rd_h']);setIf("div3v",col['3rd_v']);setIf("div4h",col['4th_h']);setIf("div4v",col['4th_v']);
  setBool("monoHF",mono.hfocus);setBool("monoVF",mono.vfocus);setBool("anaHF",ana.hfocus);setBool("anaVF",ana.vfocus);setIf("monoHB",mono.blade_h);setIf("monoVB",mono.blade_v);setIf("anaHB",ana.blade_h);setIf("anaVB",ana.blade_v);
  const mc=normalizeCrystalName(mono.crystal), ac=normalizeCrystalName(ana.crystal);
  if(mc&&CRYSTALS[mc]!==undefined){$("monoCrystal").value=mc;$("monoCrystal").dispatchEvent(new Event("change"));} if(ac&&CRYSTALS[ac]!==undefined){$("anaCrystal").value=ac;$("anaCrystal").dispatchEvent(new Event("change"));}
  if(CRYSTALS[mc]===undefined&&mono.d){$("monoCrystal").value="Other";$("dMono").disabled=false;setIf("dMono",mono.d);} if(CRYSTALS[ac]===undefined&&ana.d){$("anaCrystal").value="Other";$("dAna").disabled=false;setIf("dAna",ana.d);}
  setIf("mosMonoH",mono.mosaic_h);setIf("mosMonoV",mono.mosaic_v);setIf("mosAnaH",ana.mosaic_h);setIf("mosAnaV",ana.mosaic_v);
  setIf("L0",dist.L0);setIf("L1",dist.L1);setIf("L2",dist.L2);setIf("L3",dist.L3);setIf("beamW",beam.width);setIf("beamH",beam.height);setIf("monoW",mono.width);setIf("monoH",mono.height);setIf("monoT",mono.thickness);setIf("anaW",ana.width);setIf("anaH",ana.height);setIf("anaT",ana.thickness);setIf("detW",det.width);setIf("detH",det.height);
  updateEnergyLabel();updateSupermirrorUI();updateAutoW();setStatus(`${inst.name || $("instrument").value} loaded`);
}

function darkAssetIds(slot){
  const suffix=slot===1?"":String(slot);
  const legacyRangeId=(kind,i)=>{
    if(slot<=3 && i<4) return `dark${kind}${suffix}${i}`;
    return `dark${kind}${slot}_${i}`;
  };
  return {
    enable:`darkEnable${slot}`, se:`seSelect${suffix}`, ref:`darkRef${suffix}`, rotation:`darkRotation${suffix}`,
    refH:`darkRefH${slot}`, refK:`darkRefK${slot}`, refL:`darkRefL${slot}`, refRow:`darkRefQRow${slot}`,
    rangeCount:`darkRangeCount${slot}`,
    from:i=>legacyRangeId("From",i), to:i=>legacyRangeId("To",i), offset:i=>legacyRangeId("Offset",i)
  };
}

function darkAssetSlots(){
  return [...document.querySelectorAll(".dark-asset[data-dark-slot]")]
    .map(el=>Number(el.dataset.darkSlot))
    .filter(Number.isFinite)
    .sort((a,b)=>a-b);
}

function currentDarkRangeCount(slot){
  const ids=darkAssetIds(slot);
  const saved=Number($(ids.rangeCount)?.value);
  if(Number.isInteger(saved) && saved>=1) return saved;
  return document.querySelectorAll(`.dark-asset[data-dark-slot="${slot}"] .dark-range-number`).length || 1;
}

function createPropagationVectorRow(index,values={}){
  const row=document.createElement("div");
  row.className="propagation-row";
  row.dataset.qIndex=String(index);
  row.innerHTML=`<label class="checkbox-label propagation-enable"><input id="q_enable${index}" type="checkbox"><span>k${index}</span></label>`+
    `<label>k${index}_h<input id="q${index}_h" type="number" value="0" step="0.01"></label>`+
    `<label>k${index}_k<input id="q${index}_k" type="number" value="0" step="0.01"></label>`+
    `<label>k${index}_l<input id="q${index}_l" type="number" value="0" step="0.01"></label>`+
    `<button type="button" class="remove-propagation-vector" data-q-index="${index}">Remove</button>`;
  row.querySelector(`#q_enable${index}`).checked=values.enabled!==undefined ? !!values.enabled : true;
  for(const c of ["h","k","l"]){
    const value=Number(values[c]);
    row.querySelector(`#q${index}_${c}`).value=Number.isFinite(value)?String(value):"0";
  }
  return row;
}

function propagationVectorValues(){
  return propagationVectorIndices().map(index=>({
    enabled:!!$(`q_enable${index}`)?.checked,
    h:num(`q${index}_h`), k:num(`q${index}_k`), l:num(`q${index}_l`)
  }));
}

function replacePropagationVectors(values,{recalc=false}={}){
  const host=$("propagationVectors");
  if(!host) return;
  const rows=(Array.isArray(values)&&values.length)?values:[{}];
  host.replaceChildren();
  rows.forEach((value,i)=>host.appendChild(createPropagationVectorRow(i+1,value)));
  if($("propagationCount")) $("propagationCount").value=String(rows.length);
  updatePropagationVectorLabels();
  if(recalc) scheduleRecalc();
}

function setPropagationVectorCount(count,{recalc=false}={}){
  count=Math.max(1,Math.floor(Number(count)||1));
  const values=propagationVectorValues();
  while(values.length<count) values.push({});
  values.length=count;
  replacePropagationVectors(values,{recalc});
}

function removePropagationVector(index){
  const values=propagationVectorValues();
  const position=propagationVectorIndices().indexOf(Number(index));
  if(position>=0) values.splice(position,1);
  replacePropagationVectors(values,{recalc:true});
}

function makeDarkRangeCells(slot,index,values={}){
  const ids=darkAssetIds(slot);
  const frag=document.createDocumentFragment();
  const no=document.createElement("span");
  no.className="dark-range-number";
  no.dataset.darkRange=String(index);
  no.textContent=String(index+1);
  frag.appendChild(no);
  for(const [idFor,kind] of [[ids.from,"from"],[ids.to,"to"],[ids.offset,"offset"]]){
    const input=document.createElement("input");
    input.id=idFor(index);
    input.dataset.darkRange=String(index);
    input.dataset.darkField=kind;
    input.type="number";
    const value=Number(values[kind]);
    input.value=Number.isFinite(value)?String(value):"0";
    frag.appendChild(input);
  }
  const remove=document.createElement("button");
  remove.type="button";
  remove.className="remove-dark-range";
  remove.dataset.darkSlot=String(slot);
  remove.dataset.darkRange=String(index);
  remove.textContent="Remove";
  frag.appendChild(remove);
  return frag;
}

function darkRangeValues(slot){
  const ids=darkAssetIds(slot);
  const count=currentDarkRangeCount(slot);
  const out=[];
  for(let i=0;i<count;i++){
    out.push({from:num(ids.from(i)),to:num(ids.to(i)),offset:num(ids.offset(i))});
  }
  return out;
}

function replaceDarkRanges(slot,ranges,{recalc=false}={}){
  const asset=document.querySelector(`.dark-asset[data-dark-slot="${slot}"]`);
  const table=asset?.querySelector(".dark-table");
  if(!asset || !table) return;
  const rows=(Array.isArray(ranges)&&ranges.length)?ranges:[{}];
  table.replaceChildren();
  for(const label of ["No.","From","To","Offset",""]){
    const head=document.createElement("div");
    head.textContent=label;
    table.appendChild(head);
  }
  rows.forEach((value,i)=>table.appendChild(makeDarkRangeCells(slot,i,value)));
  const countInput=$(darkAssetIds(slot).rangeCount);
  if(countInput) countInput.value=String(rows.length);
  if(recalc) scheduleRecalc();
}

function setDarkRangeCount(slot,count,{recalc=false}={}){
  count=Math.max(1,Math.floor(Number(count)||1));
  const ranges=darkRangeValues(slot);
  while(ranges.length<count) ranges.push({});
  ranges.length=count;
  replaceDarkRanges(slot,ranges,{recalc});
}

function removeDarkRange(slot,index){
  const ranges=darkRangeValues(slot);
  const i=Math.max(0,Math.min(ranges.length-1,Number(index)||0));
  ranges.splice(i,1);
  replaceDarkRanges(slot,ranges,{recalc:true});
}

function createDarkAsset(slot,values={}){
  const ids=darkAssetIds(slot);
  const asset=document.createElement("div");
  asset.className="dark-asset";
  asset.dataset.darkSlot=String(slot);
  asset.innerHTML=`
    <div class="dark-asset-head">
      <label class="checkbox-label"><input id="${ids.enable}" type="checkbox" checked><span>Dark angle ${slot}</span></label>
      <label>Sample environment<select id="${ids.se}"><option value="">Standard</option></select></label>
      <button type="button" class="remove-dark-asset" data-dark-slot="${slot}">Remove</button>
    </div>
    <div class="grid2">
      <label>Reference<select id="${ids.ref}"><option>Reference Q</option><option>Direct beam</option><option>Fixed</option></select></label>
      <label>Rotation (deg)<input id="${ids.rotation}" type="number" value="0" step="1"></label>
    </div>
    <div id="${ids.refRow}" class="grid3">
      <label>h<input id="${ids.refH}" type="number" value="1" step="0.1"></label>
      <label>k<input id="${ids.refK}" type="number" value="0" step="0.1"></label>
      <label>l<input id="${ids.refL}" type="number" value="0" step="0.1"></label>
    </div>
    <input id="${ids.rangeCount}" type="hidden" value="1">
    <div class="dark-table" data-dark-range-table="${slot}"></div>
    <button type="button" class="add-dark-range dynamic-add-wide" data-dark-slot="${slot}">+ Add range</button>`;
  return asset;
}

function refreshDarkEnvironmentSelect(slot){
  const select=$(darkAssetIds(slot).se);
  if(!select) return;
  const keep=select.value;
  refreshSelect(sampleEnvironments,select,"Standard");
  if([...select.options].some(o=>o.value===keep)) select.value=keep;
}

function snapshotDarkAsset(slot){
  const ids=darkAssetIds(slot);
  return {
    enabled:!!$(ids.enable)?.checked,
    se:$(ids.se)?.value||"",
    ref:checkedValue(ids.ref)||"Reference Q",
    rotation:num(ids.rotation),
    refH:num(ids.refH), refK:num(ids.refK), refL:num(ids.refL),
    ranges:darkRangeValues(slot)
  };
}

function applyDarkAssetValues(slot,values={}){
  const ids=darkAssetIds(slot);
  refreshDarkEnvironmentSelect(slot);
  if($(ids.enable)) $(ids.enable).checked=values.enabled!==undefined ? !!values.enabled : true;
  if($(ids.se)){
    const requested=String(values.se||"");
    $(ids.se).value=[...$(ids.se).options].some(o=>o.value===requested)?requested:"";
  }
  setRadio(ids.ref,values.ref||"Reference Q");
  if($(ids.rotation)) $(ids.rotation).value=Number.isFinite(Number(values.rotation))?String(values.rotation):"0";
  if($(ids.refH)) $(ids.refH).value=Number.isFinite(Number(values.refH))?String(values.refH):"1";
  if($(ids.refK)) $(ids.refK).value=Number.isFinite(Number(values.refK))?String(values.refK):"0";
  if($(ids.refL)) $(ids.refL).value=Number.isFinite(Number(values.refL))?String(values.refL):"0";
  replaceDarkRanges(slot,values.ranges);
  updateDarkReferenceUI(slot);
}

function darkAssetValues(){
  return darkAssetSlots().map(slot=>snapshotDarkAsset(slot));
}

function replaceDarkAssets(values,{recalc=false}={}){
  const host=$("darkAssets");
  if(!host) return;
  const cards=(Array.isArray(values)&&values.length)?values:[{}];
  host.replaceChildren();
  cards.forEach((value,i)=>{
    const slot=i+1;
    host.appendChild(createDarkAsset(slot,value));
    applyDarkAssetValues(slot,value);
  });
  if($("darkAssetCount")) $("darkAssetCount").value=String(cards.length);
  applyDarkAngleSlotColors();
  updateGeometryQuickTargetButtons();
  if(recalc) scheduleRecalc();
}

function setDarkAssetCount(count,{recalc=false}={}){
  count=Math.max(1,Math.floor(Number(count)||1));
  const values=darkAssetValues();
  while(values.length<count) values.push({});
  values.length=count;
  replaceDarkAssets(values,{recalc});
}

function removeDarkAsset(slot){
  const values=darkAssetValues();
  const position=darkAssetSlots().indexOf(Number(slot));
  if(position>=0) values.splice(position,1);
  replaceDarkAssets(values,{recalc:true});
}

function bindDynamicSidebarUI(){
  const propagationHost=$("propagationVectors");
  if(propagationHost && !propagationHost.dataset.bound){
    const recalc=()=>scheduleRecalc();
    propagationHost.addEventListener("input",recalc);
    propagationHost.addEventListener("change",recalc);
    propagationHost.addEventListener("click",ev=>{
      const remove=ev.target.closest(".remove-propagation-vector");
      if(remove) removePropagationVector(Number(remove.dataset.qIndex));
    });
    propagationHost.dataset.bound="1";
  }

  $("addPropagationVector")?.addEventListener("click",()=>{
    const values=propagationVectorValues();
    values.push({});
    replacePropagationVectors(values,{recalc:true});
  });

  const backgroundHost=$("backgroundRows");
  if(backgroundHost && !backgroundHost.dataset.bound){
    backgroundHost.addEventListener("change",ev=>{
      const select=ev.target.closest('select[id^="backgroundSelect"]');
      if(select) handleBackgroundSelection(select.id);
    });
    backgroundHost.addEventListener("click",ev=>{
      const remove=ev.target.closest(".remove-background");
      if(remove) removeBackground(Number(remove.dataset.backgroundIndex));
    });
    backgroundHost.dataset.bound="1";
  }
  $("addBackground")?.addEventListener("click",()=>{
    const values=backgroundRowValues();
    if(values.length>=BACKGROUND_SLOTS.length) return;
    values.push({});
    replaceBackgroundRows(values,{recalc:true});
  });

  const darkHost=$("darkAssets");
  if(darkHost && !darkHost.dataset.bound){
    darkHost.addEventListener("input",ev=>{
      if(ev.target.matches("input,select")) scheduleRecalc();
    });
    darkHost.addEventListener("change",ev=>{
      const asset=ev.target.closest(".dark-asset[data-dark-slot]");
      const slot=Number(asset?.dataset.darkSlot);
      if(!Number.isFinite(slot)) return;
      const ids=darkAssetIds(slot);
      if(ev.target.id===ids.se){
        applySampleEnvironmentDefaults(slot);
      }else if(ev.target.id===ids.ref){
        updateDarkReferenceUI(slot);
        scheduleRecalc();
      }else{
        scheduleRecalc();
      }
      if(ev.target.id===ids.enable || ev.target.id===ids.ref) updateGeometryQuickTargetButtons();
    });
    darkHost.addEventListener("click",ev=>{
      const add=ev.target.closest(".add-dark-range");
      const removeRange=ev.target.closest(".remove-dark-range");
      const removeAsset=ev.target.closest(".remove-dark-asset");
      if(add){
        const slot=Number(add.dataset.darkSlot);
        const ranges=darkRangeValues(slot);
        ranges.push({});
        replaceDarkRanges(slot,ranges,{recalc:true});
      }else if(removeRange){
        removeDarkRange(Number(removeRange.dataset.darkSlot),Number(removeRange.dataset.darkRange));
      }else if(removeAsset){
        removeDarkAsset(Number(removeAsset.dataset.darkSlot));
      }
    });
    darkHost.dataset.bound="1";
  }

  $("addDarkAsset")?.addEventListener("click",()=>{
    const values=darkAssetValues();
    values.push({});
    replaceDarkAssets(values,{recalc:true});
  });
}

function updateDarkReferenceUI(slot){
  const ids=darkAssetIds(slot);
  const row=$(ids.refRow);
  if(!row) return;
  const show=checkedValue(ids.ref)==="Reference Q";
  // Keep the dedicated h/k/l controls visible whenever Reference Q is selected.
  // Use both the existing CSS class and the native hidden flag so restored/local
  // UI state cannot leave the row in the wrong visibility state.
  row.classList.toggle("hidden",!show);
  row.hidden=!show;
  updateGeometryQuickTargetButtons();
}

function applySampleEnvironmentDefaults(slot=1){
  const ids=darkAssetIds(slot);
  const key=$(ids.se)?.value || "";
  if(!key || !sampleEnvironments.has(key)){
    setRadio(ids.ref,"Reference Q");
    updateDarkReferenceUI(slot);
    setDarkRangeCount(slot,1);
    $(ids.from(0)).value=0; $(ids.to(0)).value=0; $(ids.offset(0)).value=0;
    scheduleRecalc();
    return;
  }
  const se=sampleEnvironments.get(key);
  setRadio(ids.ref,se.dark_angle_reference || "Reference Q");
  const rq=Array.isArray(se.dark_angle_reference_q)?se.dark_angle_reference_q:(Array.isArray(se.reference_q)?se.reference_q:null);
  if(rq&&rq.length>=3){ $(ids.refH).value=rq[0]; $(ids.refK).value=rq[1]; $(ids.refL).value=rq[2]; }
  updateDarkReferenceUI(slot);
  const ranges=Array.isArray(se.dark_angle_ranges)?se.dark_angle_ranges:[];
  setDarkRangeCount(slot,Math.max(1,ranges.length));
  for(let i=0;i<Math.max(1,ranges.length);i++){
    const r=ranges[i] || {from:0,to:0,offset:0};
    $(ids.from(i)).value=Number(r.from||0);
    $(ids.to(i)).value=Number(r.to||0);
    $(ids.offset(i)).value=Number(r.offset||0);
  }
  scheduleRecalc();
}

function updateEnergyLabel(){
  const mode=checkedValue("energyMode");
  $("energyLabel").childNodes[0].nodeValue = `${mode==="Ef fixed"?"Ef":"Ei"} (meV)`;
}
function updateModeVisibility(){
  const mode=checkedValue("sampleMode");
  const single=mode==="single";
  $("singleCrystalInputs").classList.toggle("hidden",!single);
  $("referenceSection").classList.toggle("hidden",!single);
  $("darkSection").classList.toggle("hidden",!single);
  $("geometryRow").classList.toggle("hidden",!single);
  $("senseRow").classList.toggle("hidden",!single);
  $("s1minWrap").classList.toggle("hidden",!single);
  $("s1maxWrap").classList.toggle("hidden",!single);
  $("lambdaHalf").closest("label").classList.toggle("hidden",!single);
  $("singleMain").classList.toggle("hidden",!single);
  $("powderMain").classList.toggle("hidden",single);
  $("s2Label").childNodes[0].nodeValue = single ? "S2 min (deg)" : "minimum 2θ (deg)";
  updateCifUI();
}

function latticeParams(){
  return {
    a:num("a"), b:num("b"), c:num("c"),
    alpha:num("alpha"), beta:num("beta"), gamma:num("gamma")
  };
}

function getDarkAssets(){
  const assets=[];
  for(const slot of darkAssetSlots()){
    const ids=darkAssetIds(slot);
    if(!$(ids.enable)?.checked) continue;
    const rotation=num(ids.rotation);
    const ranges=[];
    for(let i=0;i<currentDarkRangeCount(slot);i++){
      ranges.push([num(ids.from(i)),num(ids.to(i)),num(ids.offset(i))+rotation]);
    }
    assets.push({slot,key:$(ids.se)?.value||"",ref:checkedValue(ids.ref)||"Reference Q",refHkl:[num(ids.refH),num(ids.refK),num(ids.refL)],ranges});
  }
  return assets;
}

function tasPhiLabDeg(ki,kf,s2deg){
  const t=deg2rad(s2deg);
  const qx=-kf*Math.sin(t);
  const qz= ki-kf*Math.cos(t);
  return rad2deg(Math.atan2(qx,qz));
}

function calcQ0(s1,s2,ki,kf,s1Offset,refS1,QrefXY,sense,s1Calibration=null){
  if(s1Calibration){
    // Exact inverse of tasMotorAngles() S1 calibration:
    //
    //   S1 = S1ref + (omegaTarget-omegaRef)/c2Sign
    //
    // therefore
    //
    //   omegaTarget = omegaRef + c2Sign*(S1-S1ref)
    //
    // tasMotorAngles() deliberately uses the positive |S2| branch for the S1
    // orientation calibration in both TAS configurations, so do the same here.
    const qMag=Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(deg2rad(s2))));
    const omegaTarget=s1Calibration.omegaRef
      + s1Calibration.c2Sign*(s1-s1Calibration.refS1);
    // Do not apply any extra Q-space mirror/arc correction here.
    // Angle calculation already defines the calibrated relation between
    // S1, |S2| and the reciprocal-space azimuth.  Using its exact inverse
    // keeps the Q-E boundary on the same HKL side as Angle calculation.
    const phiTarget=deg2rad(
      wrap180(tasPhiLabDeg(ki,kf,s2)-omegaTarget)
    );
    return [qMag*Math.cos(phiTarget),qMag*Math.sin(phiTarget)];
  }

  // Fallback only when a usable S1 reference calibration is unavailable.
  const kiAngle=deg2rad(-s1+s1Offset+refS1);
  const kfAngle=deg2rad(s2-s1+s1Offset+refS1);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];
  if(sense==="+-+" && norm(QrefXY)>1e-10){
    const eQ=normalize(QrefXY);
    q=sub(scale(eQ,2*dot(q,eQ)),q);
  }
  return q;
}

function calcQDark(s1,s2,ki,kf,s1Offset,QrefXY,sense,energyMode=null){
  const kiAngle=deg2rad(-s1+s1Offset);
  const kfAngle=deg2rad(s2-s1+s1Offset);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];

  // Keep the already-validated elastic handedness mapping first.  For +-+ this
  // is the existing reflection about Reference Q; -+- uses the raw geometry.
  // Apply exactly the same mapping to the corresponding elastic-Q vector so it
  // can serve as the local angular reference for the inelastic correction.
  const kElastic=energyMode ? ((energyMode==="Ef fixed") ? kf : ki) : null;
  let qElastic=energyMode ? [kElastic*(Math.sin(kiAngle)-Math.sin(kfAngle)),
                             kElastic*(Math.cos(kiAngle)-Math.cos(kfAngle))] : null;

  if(sense==="+-+" && norm(QrefXY)>1e-10){
    const eQ=normalize(QrefXY);
    q=sub(scale(eQ,2*dot(q,eQ)),q);
    if(qElastic) qElastic=sub(scale(eQ,2*dot(qElastic,eQ)),qElastic);
  }

  // The elastic dark regions are correct for both senses.  Away from hw=0 the
  // ki-kf triangle's azimuthal displacement has the opposite sign to the TAS
  // geometry in BOTH senses.  Reflect only that inelastic displacement about
  // the sense-correct elastic-Q direction.  At hw=0 q==qElastic, so this is an
  // exact identity and cannot move the validated elastic boundaries.
  if(qElastic && norm(qElastic)>1e-10){
    const e0=normalize(qElastic);
    q=sub(scale(e0,2*dot(q,e0)),q);
  }
  return q;
}

// Direct-beam dark-angle zero is tied to the currently selected
// ki-perpendicular orientation reference.  For perpU use U; for perpV use V.
// The elastic Bragg condition for that reference lies theta=S2/2 away from the
// ki-perpendicular condition, so the same +theta correction must be used by
// both the Q-E dark-angle calculation and the TAS geometry overlay.
//
// The Direct-beam geometric axis is mirrored separately in the TAS drawing.
// The orientation-reference calibration itself uses the same +theta=S2/2
// correction for both user-facing configurations.
function directBeamOrientationCorrection(rl,energyMode,Ei,Ef,sense){
  const orientationMode=canonicalOrientationMode(
    rl,$('orientationReference')?.value || 'bragg'
  );
  if(orientationMode==='bragg') return 0;

  const refHkl=(orientationMode==='perpV' || orientationMode==='parallelV')
    ? [num("Vh"),num("Vk"),num("Vl")]
    : [num("Uh"),num("Uk"),num("Ul")];
  const qRef=norm(hklToQ(rl,refHkl));
  const E0=energyMode==="Ef fixed"?Ef:Ei;
  if(!(qRef>1e-12) || !(E0>0)) return 0;

  const k0=Math.sqrt(E0/2.072);
  const arg=qRef/(2*k0);
  if(arg>1+1e-10) return 0;

  const halfS2Ref=rad2deg(Math.asin(clamp(arg,-1,1)));

  // The geometric Direct-beam axis is already mirrored in renderGeometry().
  // Do not mirror this half-S2 calibration a second time.  Changing +theta to
  // -theta shifts the -+- zero by 2*theta = S2, exactly the observed offset.
  const parallelOffset=(orientationMode==='parallelU' || orientationMode==='parallelV') ? -90 : 0;
  return +halfS2Ref+parallelOffset;
}

function darkReferenceCalibration(asset,rl,ex,ey,energyMode,Ei,Ef){
  // Dark-angle Reference Q uses the original Reference-Q convention: the
  // entered (h,k,l) defines the crystal-space direction about which the
  // accessible dark-angle region is symmetric.  It is NOT a second S1
  // calibration and therefore must not inherit or solve an S1 value from the
  // Orientation reference.  The Bragg-peak-position S1 remains relevant only
  // to the orientation / angle-calculation calibration.
  const qhkl=asset.refHkl||[0,0,0], q=hklToQ(rl,qhkl), qn=norm(q);
  if(qn<=1e-10) return null;
  const qxy=[dot(q,ex),dot(q,ey)];
  const phi=rad2deg(Math.atan2(qxy[1],qxy[0]));
  const wavelength=9.044/Math.sqrt(energyMode==="Ef fixed"?Ef:Ei);
  const arg=wavelength*qn/(4*PI);
  if(arg>1+1e-12) return null;
  const theta=rad2deg(Math.asin(clamp(arg,-1,1)));

  // Reproduce the original Reference-Q Q-E mapping, but using the Dark-angle
  // Reference-Q HKL as its own independent reference.  No Orientation-reference
  // HKL, S1, or orientation offset enters this calibration.
  const s1Offset=-theta+180-phi;
  return {qxy,theta,Qoffset:90+theta,s1Offset};
}

function calculateSingleCrystal(){
  const inst=currentInstrument();
  const lc=latticeParams();
  // Lattice centering is derived from the selected Space group; there is no
  // separate manual centering selector in the Sample UI.
  const sampleSpaceGroup=selectedSampleSpaceGroup();
  const latticeCentering=centeringFromSpaceGroup(sampleSpaceGroup);
  const U=[num("Uh"),num("Uk"),num("Ul")];
  const V=[num("Vh"),num("Vk"),num("Vl")];
  const rl=RL_calc({...lc,sv1:U,sv2:V});
  // Keep the same UB construction as the Python implementation, even though
  // plotting below uses the explicit scattering-plane basis.
  UB_calc({...lc,sv1:U,sv2:V},rl);
  const {ex,ey,ez}=makeSpiceScatteringPlaneBasis(rl,U,V);

  const energyMode=checkedValue("energyMode");
  const lambdaHalf=$("lambdaHalf").checked;
  const energyInput=num("energy");
  let Ei,Ef;
  if(energyMode==="Ef fixed") Ef=lambdaHalf?4*energyInput:energyInput;
  else Ei=lambdaHalf?4*energyInput:energyInput;

  const fixedReferenceEnergy=(energyMode==="Ef fixed"?Ef:Ei);
  const orientationRef=effectiveOrientationReference(rl,fixedReferenceEnergy);
  const ref=orientationRef.hkl;
  const refS1=orientationRef.s1;
  const Qref=hklToQ(rl,ref);
  const QrefNorm=norm(Qref);
  const QrefXY=[dot(Qref,ex),dot(Qref,ey)];
  const phiRef=QrefNorm>1e-10?rad2deg(Math.atan2(QrefXY[1],QrefXY[0])):0;
  const wavelength=9.044/Math.sqrt(energyMode==="Ef fixed"?Ef:Ei);
  let thetaRef=0;
  if(QrefNorm>1e-10){
    const dRef=2*PI/QrefNorm;
    const arg=wavelength/(2*dRef);
    if(arg>1+1e-12) throw new Error("Reference Q is not accessible at the selected reference energy.");
    thetaRef=rad2deg(Math.asin(clamp(arg,-1,1)));
  }

  const darkAssets=getDarkAssets();
  // Each enabled asset keeps its own reference convention. Existing single-asset
  // formulas are reused independently, then their blocked regions are overlaid.
  const s1Offset=-thetaRef+180-phiRef;

  const S2min=num("S2min"), S1min=num("S1min"), S1max=num("S1max");
  let hwList;
  if(lambdaHalf) hwList=[0];
  else if(energyMode==="Ef fixed"){
    const EiMax=maxArray(rangeTable(inst).map(x=>Number(x.Ei)));
    hwList=arange(0,EiMax-Ef,0.1);
  } else {
    hwList=arange(0,Ei,0.1);
  }
  if(hwList.length===0) hwList=[0];

  const regions=[], S2list=[], QmaxList=[];
  const darkKF=[],darkKI=[],darkFixed=[];
  const addDark=$("addDark").checked && darkAssets.length>0;
  const uiSense=checkedValue("sense");
  const sense=calculationTasSense(uiSense);

  // Keep the numerical S1 inversion on its original calibration.  S1 is an
  // absolute physical motor value; do not change its calibration sign merely
  // to alter the displayed Q-E arc direction.
  const s1C2Sign=(sense==="+-+") ? +1 : -1;
  const kRef=Math.sqrt(fixedReferenceEnergy/2.072);
  const s1RangeCalibration=QrefNorm>1e-10
    ? {
        refS1,
        c2Sign:s1C2Sign,
        omegaRef:wrap180(tasPhiLabDeg(kRef,kRef,2*thetaRef)-phiRef)
      }
    : null;

  // Build the already-validated user-facing +-+ S1 calibration explicitly.
  // This lets the -+- Dark region inherit the actual +-+ blocking condition in
  // MOTOR S1 space rather than guessing it from a separate Q-space formula.
  const plusOrientationRef=effectiveOrientationReference(rl,fixedReferenceEnergy,"+-+");
  const plusInternalSense=calculationTasSense("+-+");
  const plusS1Calibration=QrefNorm>1e-10
    ? {
        refS1:plusOrientationRef.s1,
        c2Sign:(plusInternalSense==="+-+") ? +1 : -1,
        omegaRef:wrap180(tasPhiLabDeg(kRef,kRef,2*thetaRef)-phiRef)
      }
    : null;

  // Exact forward partner of calcQ0() / tasMotorAngles() for an in-plane Q.
  // Given a plotted Q and |S2|, recover the absolute physical S1 motor value
  // using the same calibration equation as Angle calculation.
  const motorS1FromPlaneQ=(q,s2,ki,kf,calibration)=>{
    if(!calibration || norm(q)<=1e-12) return null;
    const phiTarget=rad2deg(Math.atan2(q[1],q[0]));
    const omegaTarget=wrap180(tasPhiLabDeg(ki,kf,s2)-phiTarget);
    return calibration.refS1
      + angleDiffDeg(omegaTarget,calibration.omegaRef)/calibration.c2Sign;
  };

  // Q-E S1 RANGE:
  // use the exact inverse of Angle calculation directly for BOTH configurations.
  // S1 is an absolute motor value, so no extra display reflection is allowed.
  // The previous -+- reflection about S1=0 reversed an already-correct inverse
  // mapping and could send a point such as (0,0,3) toward the (0,0,-3) side.
  const calcQRangePoint=(s1,s2,ki,kf)=>
    calcQ0(s1,s2,ki,kf,s1Offset,refS1,QrefXY,sense,s1RangeCalibration);

  for(const hw of hwList){
    let EiHw,EfHw;
    if(energyMode==="Ef fixed"){ EiHw=Ef+hw; EfHw=Ef; }
    else { EiHw=Ei; EfHw=Ei-hw; }
    if(EiHw<=0 || EfHw<=0) continue;
    const ki=0.6947*Math.sqrt(EiHw), kf=0.6947*Math.sqrt(EfHw);
    const S2max=validateEffectiveS2Max(effectiveS2MaxAtEi(inst,EiHw,lambdaHalf),S2min,EiHw);

    // S1min/S1max are physical motor limits. The Q-E boundary is generated
    // from the exact inverse of the same S1 calibration used by Angle calculation.
    const s1range=linspace(S1min,S1max,200);
    const s2range=linspace(S2min,S2max,200);

    const p1=s1range.map(s1=>calcQRangePoint(s1,S2min,ki,kf));
    const p2=s2range.map(s2=>calcQRangePoint(S1max,s2,ki,kf));
    const p3=[...s1range].reverse().map(s1=>calcQRangePoint(s1,S2max,ki,kf));
    const p4=[...s2range].reverse().map(s2=>calcQRangePoint(S1min,s2,ki,kf));
    const boundary=[...p1,...p2,...p3,...p4];
    regions.push(boundary); S2list.push(S2max);
    QmaxList.push(Math.max(...boundary.map(norm)));

    const hwKF=[],hwKI=[],hwFixed=[];
    if(addDark){
      for(const asset of darkAssets){
        const darkRef=asset.ref;
        const darkCal=darkRef==="Reference Q" ? darkReferenceCalibration(asset,rl,ex,ey,energyMode,Ei,Ef) : null;
        if(darkRef==="Reference Q" && !darkCal) continue;
        if(darkRef!=="Fixed" && darkRef!=="Reference Q" && QrefNorm<=1e-10) continue;
        const Qoffset=darkRef==="Reference Q" ? darkCal.Qoffset : 2*thetaRef;
        if(darkRef==="Fixed"){
          // Laboratory-fixed obstacle: compare the SIGNED physical S2 motor angle
          // directly with the fixed angular interval.  Do not use abs(S2): a
          // stopper at +30 deg must not block a -30 deg scattering arm (and vice
          // versa).  The Q-E simulation currently scans the physical S2 branch
          // from S2min to S2max, so a fixed interval on the unused negative branch
          // naturally produces no blocked region.
          for(const rawRange of asset.ranges){
            let [from,to,offset]=rawRange;
            if(from===0 && to===0) continue;
            let a=offset+from, b=offset+to;
            if(b<a) b+=360;

            // Treat the fixed direction periodically, but intersect only with the
            // actually scanned signed S2 interval.  This also handles ranges that
            // cross 0 deg without mirroring the negative side onto the positive side.
            // A laboratory-fixed obstacle can intercept either the outgoing kf
            // arm or the incident ki beam.  The fixed-angle drawing uses the
            // sample as the origin: rotation = 0 deg points along the direct
            // (outgoing) beam, while the incident ki source direction is the
            // opposite ray, 180 deg.  Therefore a range around 0 deg is handled
            // below as an ordinary kf/S2 block; only a range containing 180 deg
            // (modulo 360 deg) blocks ki and makes every Q geometry inaccessible.
            const blocksKi=[-360,0,360].some(shift=>{
              const aa=a+shift, bb=b+shift;
              return aa<=180 && 180<=bb;
            });
            if(blocksKi){
              hwFixed.push(boundary.slice());
              continue;
            }

            // Otherwise the obstacle only blocks the outgoing kf arm.  Intersect
            // its signed angular interval with the actually scanned S2 range.
            for(const shift of [-360,0,360]){
              const lo=Math.max(a+shift,S2min);
              const hi=Math.min(b+shift,S2max);
              if(!(hi>lo)) continue;
              const qRadius=s2=>Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(deg2rad(s2))));
              const r0=qRadius(lo), r1=qRadius(hi), aa=linspace(0,2*Math.PI,241);
              hwFixed.push([...aa.map(t=>[r1*Math.cos(t),r1*Math.sin(t)]),...[...aa].reverse().map(t=>[r0*Math.cos(t),r0*Math.sin(t)])]);
            }
          }
          continue;
        }
        const s2dark=linspace(S2min,S2max,200);
        for(const rawRange of asset.ranges){
          const [from,to,offset]=rawRange; if(from===0 && to===0) continue;
          const directBeamCorrection=darkRef==="Direct beam"
            ? directBeamOrientationCorrection(rl,energyMode,Ei,Ef,uiSense) : 0;
          const correctedOffset=offset+directBeamCorrection;
          const s1from=correctedOffset+from-Qoffset, s1to=correctedOffset+to-Qoffset;

          // Reference-Q dark angles use exactly the old Reference-Q Q-E mapping,
          // rebased on the HKL entered in this dark-angle slot.  In particular,
          // Orientation reference (including Bragg-position S1) is deliberately
          // excluded.  Direct-beam keeps the existing orientation-based mapping.
          const darkS1Offset=darkRef==="Reference Q" ? darkCal.s1Offset : s1Offset;
          const darkQrefXY=darkRef==="Reference Q" ? darkCal.qxy : QrefXY;

          const kiShift=s2=>(180-s2);

          if(uiSense!=="-+-"){
            // Preserve the validated +-+ blocked regions byte-for-byte in
            // numerical behavior: continue using the existing calcQDark path.
            const fromKF=s2dark.map(s2=>calcQDark(s1from,s2,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
            const toKF=s2dark.map(s2=>calcQDark(s1to,s2,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
            const topKF=linspace(s1from,s1to,100).map(s1=>calcQDark(s1,S2max,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
            const bottomKF=linspace(s1to,s1from,100).map(s1=>calcQDark(s1,S2min,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
            hwKF.push([...fromKF,...topKF,...[...toKF].reverse(),...bottomKF]);

            const fromKI=s2dark.map(s2=>calcQDark(s1from-kiShift(s2),s2,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
            const toKI=s2dark.map(s2=>calcQDark(s1to-kiShift(s2),s2,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
            const topKI=linspace(s1from-kiShift(S2max),s1to-kiShift(S2max),100).map(s1=>calcQDark(s1,S2max,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
            const bottomKI=linspace(s1to-kiShift(S2min),s1from-kiShift(S2min),100).map(s1=>calcQDark(s1,S2min,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
            hwKI.push([...fromKI,...topKI,...[...toKI].reverse(),...bottomKI]);
            continue;
          }

          // -+-: derive the block boundaries from the validated +-+ result in
          // ABSOLUTE MOTOR S1, then map them back to Q with calcQ0(), which is
          // the exact inverse of Angle calculation.
          //
          // 1) ki block: same physical S1 condition as +-+.
          // 2) kf block: same +-+ physical S1 condition + 2*|S2|, because kf is
          //    rotated CCW by 2*S2 while positive S1 is CCW in both configs.
          //
          // This makes every plotted -+- Dark boundary round-trip through
          // Angle calculation to the intended S1/S2 motor condition.
          const plusDarkQ=(darkS1Param,s2)=>calcQDark(
            darkS1Param,s2,ki,kf,darkS1Offset,darkQrefXY,plusInternalSense,energyMode
          );
          const plusPhysicalS1=(darkS1Param,s2)=>motorS1FromPlaneQ(
            plusDarkQ(darkS1Param,s2),s2,ki,kf,plusS1Calibration
          );
          const minusQFromPhysicalS1=(physicalS1,s2)=>calcQ0(
            physicalS1,s2,ki,kf,s1Offset,refS1,QrefXY,sense,s1RangeCalibration
          );

          const mapKi=(darkS1Param,s2)=>minusQFromPhysicalS1(
            plusPhysicalS1(darkS1Param-kiShift(s2),s2),s2
          );
          const mapKf=(darkS1Param,s2)=>minusQFromPhysicalS1(
            plusPhysicalS1(darkS1Param,s2)+2*s2,s2
          );

          const fromKF=s2dark.map(s2=>mapKf(s1from,s2));
          const toKF=s2dark.map(s2=>mapKf(s1to,s2));
          const topKF=linspace(s1from,s1to,100).map(p=>mapKf(p,S2max));
          const bottomKF=linspace(s1to,s1from,100).map(p=>mapKf(p,S2min));
          hwKF.push([...fromKF,...topKF,...[...toKF].reverse(),...bottomKF]);

          const fromKI=s2dark.map(s2=>mapKi(s1from,s2));
          const toKI=s2dark.map(s2=>mapKi(s1to,s2));
          const topKI=linspace(s1from,s1to,100).map(p=>mapKi(p,S2max));
          const bottomKI=linspace(s1to,s1from,100).map(p=>mapKi(p,S2min));
          hwKI.push([...fromKI,...topKI,...[...toKI].reverse(),...bottomKI]);
        }
      }
    }
    darkKF.push(hwKF); darkKI.push(hwKI); darkFixed.push(hwFixed);
  }

  if(regions.length===0) throw new Error("No accessible energy-transfer points were generated.");

  // Generate Bragg peaks over the same radial range shown by the Single Crystal plot.
  // Using QmaxList[0] here made the index search depend on the first energy point
  // and could truncate one reciprocal-space direction.  Search out to 1.2 times
  // the instrument's maximum reachable Q over the full calculated energy range.
  const instrumentQmax=Math.max(...QmaxList);
  const QplotLattice=1.2*instrumentQmax;
  const Uq=hklToQ(rl,U), Vq=hklToQ(rl,V);
  const Ulen=norm(Uq), Vlen=norm(Vq);
  const Mmax=Math.ceil(QplotLattice/Ulen)+2, Nmax=Math.ceil(QplotLattice/Vlen)+2;
  const Gpoints=[], magPoints=[];
  // Magnetic satellites are observable in this 2D TAS view only when their
  // propagation vector itself lies in the selected scattering plane.
  const propagationVectors=enabledPropagationVectors().filter(q=>{
    const qCart=hklToQ(rl,q.hkl);
    const scaleQ=Math.max(norm(qCart),1);
    return Math.abs(dot(qCart,ez)) <= 1e-8*scaleQ;
  });

  for(let m=-Mmax;m<=Mmax;m++){
    for(let n=-Nmax;n<=Nmax;n++){
      const hkl=add(scale(U,m),scale(V,n));
      const G=hklToQ(rl,hkl);

      if(norm(G)>QplotLattice) continue;
      if(!isAllowedByCentering(hkl,latticeCentering)) continue;

      const h = Math.round(hkl[0]);
      const k = Math.round(hkl[1]);
      const l = Math.round(hkl[2]);

      const isOrigin=hkl.every(v=>Math.abs(v)<1e-10);
      const sf2=selectedCifStructure && !isOrigin
        ? nuclearStructureFactorSquared(selectedCifStructure,hkl,norm(G))
        : null;
      Gpoints.push({
        x:dot(G,ex),y:dot(G,ey),hkl,label:isOrigin?"":`(${formatHKL(hkl)})`,
        sf2:Number.isFinite(sf2)?sf2:null,sfNorm:null
      });
    }
  }

  if(selectedCifStructure){
    const sfMax=Math.max(0,...Gpoints.map(p=>Number.isFinite(p.sf2)?p.sf2:0));
    for(const p of Gpoints) p.sfNorm=(sfMax>0 && Number.isFinite(p.sf2)) ? p.sf2/sfMax : 0;
    // Remove effectively extinct reflections.  The threshold is relative to the
    // strongest displayed reflection, so exact/systematic extinctions disappear
    // without hiding genuinely weak peaks.
    if(sfMax>0){
      for(let j=Gpoints.length-1;j>=0;j--){
        const p=Gpoints[j];
        if(p.label && Number.isFinite(p.sf2) && p.sf2<=sfMax*1e-10) Gpoints.splice(j,1);
      }
    }
  }

  // Generate magnetic satellites only after nuclear systematic/extinction
  // filtering is complete.  This prevents k-satellites from remaining around
  // a parent nuclear reflection that has disappeared.  The origin is retained
  // intentionally, so +/-k around (0,0,0) continue to be shown.
  for(const parent of Gpoints){
    const hkl=parent.hkl;
    for(const q of propagationVectors){
      const kvec=q.hkl;
      for(const s of [1,-1]){
        const hm=add(hkl,scale(kvec,s));
        const Gm=hklToQ(rl,hm);

        if(norm(Gm)<=QplotLattice){
          magPoints.push({
            x:dot(Gm,ex),
            y:dot(Gm,ey),
            qIndex:q.index,
            label:`k${q.index}: (${hm.map(x=>x.toFixed(2)).join(",")})`
          });
        }
      }
    }
  }

  const ringData=[];
  const qlimit=Math.max(...QmaxList);
  for(const bg of selectedBackgrounds()){
    const material=backgroundMaterials.get(bg.key);
    const peaks=backgroundPowderPeaks(material,qlimit);
    for(const p of peaks){
      const phi=linspace(0,2*PI,361);
      const ratio=p.relativeIntensity;
      ringData.push({
        x:phi.map(t=>p.q*Math.cos(t)), y:phi.map(t=>p.q*Math.sin(t)),
        color:backgroundColor(bg.slot,0.20+0.75*ratio),
        hover:`BG${bg.index+1}: ${bg.key}<br>${representativePowderHklText(p)}<br>Q = ${p.q.toFixed(3)} Å⁻¹<br>S2(elastic) = ${p.elasticS2.toFixed(3)}°<br>I/Imax = ${ratio.toFixed(3)}`
      });
    }
  }

  return {
    inst,lc,latticeCentering,sampleSpaceGroup,U,V,rl,ex,ey,ez,
    energyMode,Ei,Ef,lambdaHalf,hwList,
    regions,S2list,QmaxList,darkKF,darkKI,darkFixed,addDark,
    Gpoints,magPoints,ringData,darkAssets,QrefXY,sense,
    cifStructure:selectedCifStructure,cifFileName:selectedCifFileName
  };
}

function singleMarkerSizes(fullSpan,visibleSpan,peakCount){
  // Keep dense thermal maps readable at the full view, then grow markers smoothly
  // as the user zooms in. Sizes remain bounded so neither view becomes extreme.
  const density=Math.max(0.50,Math.min(1,Math.sqrt(90/Math.max(90,peakCount||0))));
  const zoom=Math.max(1,Math.sqrt(Math.max(1,fullSpan/Math.max(visibleSpan,1e-9))));
  const scale=Math.min(1.55,density*zoom);
  return {nuclear:Math.max(5,12*scale),magnetic:Math.max(3.0,7*scale),star:Math.max(3.5,9*scale)};
}

function singleNuclearLabelStyle(fullSpan,visibleSpan){
  // Scale both font size and marker-to-label clearance with zoom.  A fixed
  // fraction of the visible Q span looks progressively tighter in screen pixels
  // once the text/markers grow, so increase that fraction as we zoom in.
  const span=Math.min(fullSpan,Math.max(1e-9,Number(visibleSpan)||fullSpan));
  const zoom=Math.max(1,fullSpan/span);
  const logZoom=Math.max(0,Math.log2(zoom));
  const fontSize=Math.min(20,11+2.5*logZoom);
  const offsetFraction=Math.min(0.055,0.022+0.006*logZoom);
  const offset=Math.max(span*offsetFraction,fullSpan*0.0015);
  return {offset,fontSize};
}

function bindSingleZoomLabelScaling(cache,Qplot){
  const gd=$("singlePlot");
  if(!gd || typeof gd.on!=="function") return;
  if(gd.__tasLabelRelayoutHandler && typeof gd.removeListener==="function")
    gd.removeListener("plotly_relayout",gd.__tasLabelRelayoutHandler);
  const fullSpan=2*Qplot;
  const applyOffset=span=>{
    const idx=(gd.data||[]).findIndex(tr=>tr.meta==="nuclear-labels");
    if(idx<0) return;
    const style=singleNuclearLabelStyle(fullSpan,span);
    // Keep the label trace point-for-point aligned with the currently visible
    // nuclear peaks.  Using all cache.Gpoints here caused Plotly reset/double-click
    // to pair a shorter text array with a longer x/y array, visually piling labels
    // against one side of the plot.
    const threshold=cache.cifStructure ? sfThresholdFraction() : 0;
    const pts=cache.Gpoints.filter(p=>p.label!=="" && (!cache.cifStructure || !Number.isFinite(p.sfNorm) || p.sfNorm>threshold));
    Plotly.restyle(gd,{
      x:[pts.map(p=>p.x)],
      y:[pts.map(p=>p.y+style.offset)],
      "textfont.size":style.fontSize
    },[idx]);
  };
  const handler=ev=>{
    if(ev?.["xaxis.autorange"]===true || ev?.["yaxis.autorange"]===true){ applyOffset(fullSpan); return; }
    const x0=Number(ev?.["xaxis.range[0]"]),x1=Number(ev?.["xaxis.range[1]"]);
    const y0=Number(ev?.["yaxis.range[0]"]),y1=Number(ev?.["yaxis.range[1]"]);
    if(Number.isFinite(x0)&&Number.isFinite(x1)){ applyOffset(Math.abs(x1-x0)); return; }
    if(Number.isFinite(y0)&&Number.isFinite(y1)){ applyOffset(Math.abs(y1-y0)); return; }
    requestAnimationFrame(()=>{
      const xr=gd?._fullLayout?.xaxis?.range, yr=gd?._fullLayout?.yaxis?.range;
      if(Array.isArray(xr)&&xr.length===2&&xr.every(Number.isFinite)) applyOffset(Math.abs(xr[1]-xr[0]));
      else if(Array.isArray(yr)&&yr.length===2&&yr.every(Number.isFinite)) applyOffset(Math.abs(yr[1]-yr[0]));
      else applyOffset(fullSpan);
    });
  };
  gd.__tasLabelRelayoutHandler=handler;
  gd.on("plotly_relayout",handler);
}

function bindSingleZoomMarkerScaling(cache,Qplot){
  const gd=$("singlePlot");
  if(!gd || typeof gd.on!=="function") return;
  if(gd.__tasMarkerRelayoutHandler && typeof gd.removeListener==="function")
    gd.removeListener("plotly_relayout",gd.__tasMarkerRelayoutHandler);
  const fullSpan=2*Qplot, peakCount=cache.Gpoints.length+cache.magPoints.length;
  const applySizes=span=>{
    // Never let a zoom-out span larger than the original view make markers smaller
    // than their initial density-scaled size.
    span=Math.min(fullSpan,Math.max(1e-9,Number(span)||fullSpan));
    const sizes=singleMarkerSizes(fullSpan,span,peakCount);
    const updates=[],indices=[];
    (gd.data||[]).forEach((tr,j)=>{
      if(tr.name==="Nuclear Bragg peaks"){updates.push(sizes.nuclear);indices.push(j);}
      else if(/^Magnetic Bragg peaks: k\d+$/.test(tr.name||"")){
        const k=Number((tr.name||"").match(/k([123])$/)?.[1]||1);
        updates.push(k===3?sizes.star:sizes.magnetic);indices.push(j);
      }
    });
    indices.forEach((idx,n)=>Plotly.restyle(gd,{"marker.size":updates[n]},[idx]));
  };
  const handler=ev=>{
    // Reset/Autoscale events do not always contain explicit range[0]/range[1].
    // Handle them explicitly, otherwise the enlarged zoom-in marker size can remain.
    if(ev?.["xaxis.autorange"]===true || ev?.["yaxis.autorange"]===true){
      applySizes(fullSpan);
      return;
    }
    const x0=Number(ev?.["xaxis.range[0]"]),x1=Number(ev?.["xaxis.range[1]"]);
    const y0=Number(ev?.["yaxis.range[0]"]),y1=Number(ev?.["yaxis.range[1]"]);
    if(Number.isFinite(x0)&&Number.isFinite(x1)){ applySizes(Math.abs(x1-x0)); return; }
    if(Number.isFinite(y0)&&Number.isFinite(y1)){ applySizes(Math.abs(y1-y0)); return; }

    // Some Plotly zoom-out/reset paths only expose the final range through _fullLayout.
    // Read it after Plotly has finished applying the relayout event.
    requestAnimationFrame(()=>{
      const xr=gd?._fullLayout?.xaxis?.range, yr=gd?._fullLayout?.yaxis?.range;
      if(Array.isArray(xr)&&xr.length===2&&xr.every(Number.isFinite)) applySizes(Math.abs(xr[1]-xr[0]));
      else if(Array.isArray(yr)&&yr.length===2&&yr.every(Number.isFinite)) applySizes(Math.abs(yr[1]-yr[0]));
      else applySizes(fullSpan);
    });
  };
  gd.__tasMarkerRelayoutHandler=handler; gd.on("plotly_relayout",handler);
}

// Preserve the actual Plotly viewport across data recalculations.
// uirevision alone is not sufficient here because these layouts explicitly
// provide fresh axis ranges on every Plotly.react() call.
function currentPlotRanges(id){
  const gd=$(id);
  const xr=gd?._fullLayout?.xaxis?.range;
  const yr=gd?._fullLayout?.yaxis?.range;
  const valid=r=>Array.isArray(r)&&r.length===2&&r.every(v=>Number.isFinite(Number(v)));
  return {
    x:valid(xr)?xr.map(Number):null,
    y:valid(yr)?yr.map(Number):null
  };
}


// Higher-order wavelength contamination warning.
// A label "nki-mkf" denotes an elastic event for the contaminating harmonics,
// n*ki and m*kf.  Since E is proportional to k^2, the condition is
// n^2 Ei = m^2 Ef.  We compare the currently displayed apparent hbar-omega
// (Ei-Ef) with those discrete conditions.
function qeSpurionWarnings(cache, hw){
  if(!Number.isFinite(hw)) return [];
  const list=Array.isArray(cache?.hwList) ? cache.hwList.map(Number).filter(Number.isFinite) : [];
  if(!list.length) return [];

  const fixedEf=Number(cache?.Ef);
  const fixedEi=Number(cache?.Ei);
  const candidates=[];

  // Convention used in the warning label:
  // "nki-mkf" corresponds to ki/kf = n/m.
  // Therefore Ei/Ef = (n/m)^2.
  //
  // Only include an incident higher-order component while its energy
  // n^2 * Ei is <= 100 meV, since the reactor spectrum is negligible above it.
  // The upper n bound below is intentionally generous; the 100-meV test is
  // the actual cutoff.
  for(let n=2;n<=12;n++){
    for(let m=1;m<n;m++){
      let hws, EiAtSpurion, EfAtSpurion;
      const r=(n/m)*(n/m);

      if(cache.energyMode==="Ef fixed"){
        if(!(fixedEf>0)) continue;
        EfAtSpurion=fixedEf;
        EiAtSpurion=fixedEf*r;
        hws=EiAtSpurion-EfAtSpurion;
      }else{
        if(!(fixedEi>0)) continue;
        EiAtSpurion=fixedEi;
        EfAtSpurion=fixedEi/r;
        hws=EiAtSpurion-EfAtSpurion;
      }

      if(!(EiAtSpurion>0) || !(EfAtSpurion>0) || !Number.isFinite(hws)) continue;
      if(n*n*EiAtSpurion > 100 + 1e-9) continue;

      // Reduce duplicate ratios (e.g. 4/2 == 2/1); keep the lowest-order label.
      if(candidates.some(x=>Math.abs(x.hw-hws)<1e-9)) continue;
      candidates.push({label:`${n}ki-${m}kf`,hw:hws});
    }
  }

  // Warn on the two sampled hbar-omega points nearest each theoretical spurion.
  // This makes a 0.1-meV grid show the warning on two adjacent points.
  const hits=[];
  for(const cand of candidates){
    const nearest=list
      .map((v,idx)=>({v,idx,d:Math.abs(v-cand.hw)}))
      .sort((a,b)=>a.d-b.d || a.idx-b.idx)
      .slice(0,Math.min(2,list.length));
    if(nearest.some(p=>Math.abs(p.v-hw)<1e-9)) hits.push(cand);
  }
  return hits;
}

function updateQESpurionWarning(cache,index){
  const box=$("qeSpurionWarning");
  if(!box || !cache?.hwList?.length) return;
  const i=Math.max(0,Math.min(Number(index)||0,cache.hwList.length-1));
  const hw=Number(cache.hwList[i]);
  const hits=qeSpurionWarnings(cache,hw);
  box.textContent=hits.length ? `Spurion warning: ${hits.map(x=>x.label).join(", ")}` : "";
  box.classList.toggle("active",hits.length>0);
}

function updateGeometrySpurionWarning(cache, hw){
  const box=$("geometrySpurionWarning");
  if(!box) return;
  const hits=qeSpurionWarnings(cache,Number(hw));
  box.textContent=hits.length ? `Spurion warning: ${hits.map(x=>x.label).join(", ")}` : "";
  box.classList.toggle("active",hits.length>0);
}

function renderSingle(cache,index=0){
  const keptView=currentPlotRanges("singlePlot");
  const i=Math.max(0,Math.min(index,cache.regions.length-1));
  const boundary=cache.regions[i];
  const qMax = Math.max(0, ...cache.Gpoints.map(p => Math.hypot(p.x, p.y)));

  const s2Min = num("S2min");
  const s2Max = cache.S2list[i];
  const Qplot=1.2*Math.max(...cache.QmaxList);
  const initialMarkerSizes=singleMarkerSizes(2*Qplot,2*Qplot,cache.Gpoints.length+cache.magPoints.length);

  const sfThreshold=cache.cifStructure ? sfThresholdFraction() : 0;
  const visibleGpoints=cache.cifStructure
    ? cache.Gpoints.filter(p=>!p.label || !Number.isFinite(p.sfNorm) || p.sfNorm>sfThreshold)
    : cache.Gpoints;

  const traces=[
    {
      x:boundary.map(p=>p[0]),
      y:boundary.map(p=>p[1]),
      fill:"toself",
      name:`Accessible Q (${s2Min.toFixed(0)}° ≤ S2 ≤ ${s2Max.toFixed(0)}°)`,
      mode:"lines",
      line:{width:0},
      fillcolor:"rgba(255,215,0,0.20)"
    },
    {
      x:[null], y:[null], mode:"markers", name:"Nuclear Bragg peaks",
      marker:{color:"black",size:initialMarkerSizes.nuclear},
      hoverinfo:"skip",
      meta:"nuclear-legend",
      zorder:0
    },
    {
      x:visibleGpoints.map(p=>p.x),
      y:visibleGpoints.map(p=>p.y),
      mode:"markers",
      name:"Nuclear Bragg peaks",
      showlegend:false,
      meta:"nuclear-data",
      zorder:0,
      marker:cache.cifStructure ? {
        color:visibleGpoints.map(p=>Number.isFinite(p.sfNorm)?p.sfNorm:0),
        colorscale:[[0,"rgb(245,245,245)"],[0.25,"rgb(205,205,205)"],[0.5,"rgb(150,150,150)"],[0.75,"rgb(85,85,85)"],[1,"rgb(0,0,0)"]],
        cmin:0,cmax:Math.max(0.01,Math.min(1,Number($("sfColorMaxSlider")?.value)||1)),
        showscale:true,
        colorbar:{title:{text:"|F_N|² / max",side:"right",font:{size:15}},tickfont:{size:14},thickness:16,len:0.62,x:1.02,y:0.52},
        size:initialMarkerSizes.nuclear,
        line:{color:"rgba(80,80,80,0.55)",width:0.4}
      } : {color:"black",size:initialMarkerSizes.nuclear},
      hovertext:visibleGpoints.map(p=>{
        if(!cache.cifStructure || !p.label) return p.label;
        const raw=Number.isFinite(p.sf2)?p.sf2:0, rel=Number.isFinite(p.sfNorm)?p.sfNorm:0;
        return `${p.label}<br>|F<sub>N</sub>|² = ${(raw/100).toPrecision(6)} barn<br>|F<sub>N</sub>|² / max = ${rel.toFixed(4)}`;
      }),
      hovertemplate:"%{hovertext}<extra></extra>"
    },
  ];
  if($("displayNuclearLabels")?.checked){
    const labelPts=visibleGpoints.filter(p=>p.label!=="");
    const labelStyle=singleNuclearLabelStyle(2*Qplot,2*Qplot);
    traces.push({
      x:labelPts.map(p=>p.x),
      y:labelPts.map(p=>p.y+labelStyle.offset),
      mode:"text",
      text:labelPts.map(p=>p.label),
      textposition:"middle center",
      textfont:{color:"black",size:labelStyle.fontSize},
      showlegend:false,
      hoverinfo:"skip",
      meta:"nuclear-labels",
      zorder:0
    });
  }
  // Keep propagation vectors visually distinct by marker shape while retaining
  // one magnetic-peak color.  The symbol sequence cycles only if many k vectors
  // are added; the propagation-vector index remains explicit in the legend.
  const magneticSymbols=["circle","x","star","diamond","cross","triangle-up","square","diamond-open","triangle-down","pentagon"];
  const magneticIndices=[...new Set(cache.magPoints.map(p=>Number(p.qIndex)).filter(Number.isFinite))].sort((a,b)=>a-b);
  for(const qIndex of magneticIndices){
    const pts=cache.magPoints.filter(p=>p.qIndex===qIndex);
    if(!pts.length) continue;
    const symbol=magneticSymbols[(qIndex-1)%magneticSymbols.length];
    traces.push({
      x:pts.map(p=>p.x),y:pts.map(p=>p.y),mode:"markers",name:`Magnetic Bragg peaks: k${qIndex}`,
      marker:{color:"red",size:symbol==="star"?initialMarkerSizes.star:initialMarkerSizes.magnetic,symbol},
      hovertext:pts.map(p=>p.label),hovertemplate:"%{hovertext}<extra></extra>",
      zorder:10
    });
  }
  const selectedS2=syncSingleNavigation(cache,i);
  const selectedQ=selectedQAtS2(cache,i,selectedS2);
  if(Number.isFinite(selectedQ)){
    const phi=linspace(0,2*PI,361);
    traces.push({x:phi.map(t=>selectedQ*Math.cos(t)),y:phi.map(t=>selectedQ*Math.sin(t)),mode:"lines",name:`S2 = ${selectedS2.toFixed(1)}°`,showlegend:false,line:{color:"black",width:1.2,dash:"solid"},hovertemplate:`S2 = ${selectedS2.toFixed(1)}°<br>Q = ${selectedQ.toFixed(3)} Å⁻¹<extra></extra>`});
  }
  for(const ring of cache.ringData){
    traces.push({
      x:ring.x,y:ring.y,mode:"lines",showlegend:false,
      line:{color:ring.color,width:1.5},hovertemplate:ring.hover+"<extra></extra>"
    });
  }
  // Match the Powder view: show one legend entry for each selected BG slot
  // without duplicating a legend item for every individual powder ring.
  for(const bg of selectedBackgrounds()){
    traces.push({
      x:[null],y:[null],mode:"lines",
      name:`BG${bg.index+1}: ${bg.key}`,
      line:{color:backgroundColor(bg.slot,1),width:1.5},
      hoverinfo:"skip",showlegend:true
    });
  }
  if(cache.addDark){
    let fixedLegend=false, kfLegend=false, kiLegend=false;
    for(const r of (cache.darkKI[i]||[])){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (ki side)",showlegend:!kiLegend,legendgroup:"dark-ki",mode:"lines",line:{width:0},fillcolor:"rgba(0,255,0,0.15)",hoverinfo:"skip"});
      kiLegend=true;
    }
    for(const r of (cache.darkKF[i]||[])){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (kf side)",showlegend:!kfLegend,legendgroup:"dark-kf",mode:"lines",line:{width:0},fillcolor:"rgba(80,190,255,0.25)",hoverinfo:"skip"});
      kfLegend=true;
    }
    for(const r of (cache.darkFixed[i]||[])){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (fixed)",showlegend:!fixedLegend,legendgroup:"dark-fixed",mode:"lines",line:{width:0},fillcolor:"rgba(0,0,255,0.15)",hoverinfo:"skip"});
      fixedLegend=true;
    }
  }

  const energyText=cache.energyMode==="Ef fixed"?`Ef=${cache.Ef.toFixed(2)} meV`:`Ei=${cache.Ei.toFixed(2)} meV`;
  const lam=cache.lambdaHalf?" | λ/2":"";
  const title=`${cache.inst.name||"Instrument"} | ${energyText}${lam}<br>`+
    `a=${cache.lc.a.toFixed(3)}, b=${cache.lc.b.toFixed(3)}, c=${cache.lc.c.toFixed(3)} Å<br>`+
    `α=${cache.lc.alpha.toFixed(1)}, β=${cache.lc.beta.toFixed(1)}, γ=${cache.lc.gamma.toFixed(1)}° | `+
    `Space group: #${cache.sampleSpaceGroup?.number ?? 1} ${cache.sampleSpaceGroup?.hm ?? "P1"} (${cache.latticeCentering}) | Plane: (${cache.U.join(",")})-(${cache.V.join(",")})`;

  // Plotly draws later traces on top. Keep the nuclear legend entry where it is,
  // but render the actual nuclear markers/labels last so BG1-BG4 and other
  // line traces cannot cover them.
  const nuclearTop=traces.filter(tr=>tr.meta==="nuclear-data" || tr.meta==="nuclear-labels");
  if(nuclearTop.length){
    for(let j=traces.length-1;j>=0;j--){
      if(traces[j].meta==="nuclear-data" || traces[j].meta==="nuclear-labels") traces.splice(j,1);
    }
    traces.push(...nuclearTop);
  }

  Plotly.react("singlePlot",traces,{
    // Preserve user zoom/pan when controls trigger a recalculation.
    uirevision:"singlePlot",
    title:{text:title,x:0.5,xanchor:"center",font:{size:16}},
    xaxis:{title:{text:"Qx (Å⁻¹)",font:{size:16}},tickfont:{size:14},range:keptView.x||[-Qplot,Qplot],tickmode:"auto",nticks:10,showgrid:true,gridcolor:"lightgray",zeroline:true,constrain:"domain"},
    // Keep the reciprocal-space plotting box square: identical numerical Qx/Qy
    // ranges and a 1:1 data-unit aspect ratio.  `constrain: domain` makes Plotly
    // shrink the axis domain rather than silently expanding one numerical range.
    yaxis:{title:{text:"Qy (Å⁻¹)",font:{size:16}},tickfont:{size:14},range:keptView.y||[-Qplot,Qplot],tickmode:"auto",nticks:10,showgrid:true,gridcolor:"lightgray",zeroline:true,scaleanchor:"x",scaleratio:1,constrain:"domain"},
    // UI-only spacing: reclaim a little space above the plot, while reserving
    // more room below so the x-axis title and horizontal legend do not crowd.
    margin:{l:60,r:cache.cifStructure?88:20,t:92,b:96},
    legend:{orientation:"h",x:0.5,xanchor:"center",y:-0.16,yanchor:"top"}
  },{responsive:true});
  bindSingleZoomMarkerScaling(cache,Qplot);
  bindSingleZoomLabelScaling(cache,Qplot);

  const hwDisplay=$("hwValue");
  if(hwDisplay) hwDisplay.textContent=`${cache.hwList[i].toFixed(1)} meV`;
  const hwEntry=$("hwEntry");
  if(hwEntry && document.activeElement!==hwEntry) hwEntry.value=cache.hwList[i].toFixed(1);
  updateQESpurionWarning(cache,i);
  updateS2MaxDisplayForQERange(cache,i);
  renderGeometry(cache,i);
}

function qeGeometryAngles(cache, senseOverride=null){
  const calc={h:num("geomH"),k:num("geomK"),l:num("geomL"),hw:num("geomHW")};
  // Reuse exactly the same motor-angle calculation as Resolution & Angle.
  // Only override the fixed energy when Q-E Range is in lambda/2 mode, because
  // calculateSingleCrystal() uses four times the entered energy in that mode.
  const b=collectResolutionBase();
  if(cache.energyMode==="Ei fixed"){
    b.config.energy_mode="Ei fixed";
    b.config.Ei=cache.Ei;
    b.config.Ef=null;
  }else{
    b.config.energy_mode="Ef fixed";
    b.config.Ef=cache.Ef;
    b.config.Ei=null;
  }
  b.config.sign_config=senseOverride ?? cache.sense;
  const angles=tasMotorAngles(calc,b);
  const Ei=cache.energyMode==="Ei fixed" ? cache.Ei : cache.Ef+calc.hw;
  const Ef=cache.energyMode==="Ei fixed" ? cache.Ei-calc.hw : cache.Ef;
  return {calc,angles,Ei,Ef,ki:Math.sqrt(Ei/2.072),kf:Math.sqrt(Ef/2.072)};
}

function renderGeometry(cache,index=0){
  const i=Math.max(0,Math.min(index,cache.hwList.length-1));
  // Geometry display follows the user-facing sign directly.
  // cache.sense is the intentionally swapped INTERNAL numerical branch and
  // must not determine which configuration picture is shown.
  const sense=checkedValue("sense");
  const hw=cache.hwList[i] || 0;
  updateGeometrySpurionWarning(cache,num("geomHW"));
  const mirror=sense==="+-+" ? 1 : -1;

  // Default explanatory geometry is retained when the requested target cannot
  // be solved.  A valid h,k,l,hw target switches the drawing to calculated TAS
  // motor angles while keeping all flight-leg lengths equal for readability.
  let target=null;
  let targetError="";
  try{ target=qeGeometryAngles(cache); }
  catch(err){ targetError=err?.message || String(err); }

  const L=2.05;
  let source,mono,sample,analyzer,detector;
  let thetaKi,thetaKf,thetaOut;
  let monoPlaneAngle,anaPlaneAngle;
  let qAngle;
  // Vector-display lengths are derived from the actual wave-vector magnitudes.
  // The fixed-energy side is the visual scale reference: Ef fixed -> kf fixed,
  // Ei fixed -> ki fixed.  Flight-path leg lengths remain schematic/equal.
  let kiVectorLen=0.50*L, kfVectorLen=0.50*L, qVectorLen=1.38;

  if(target){
    // Build one canonical (+-+) drawing, then make -+- an exact left/right
    // reflection of it.  This prevents the two sign configurations from drifting
    // to different screen positions because of their signed motor angles.
    // The schematic has its own display convention. Always construct the
    // canonical user-facing +-+ geometry from the +-+ motor-angle branch, then
    // apply the existing display mirror below only when the UI selects -+-.
    // Numerical Angle/Q-E results remain on the intentionally swapped branches.
    const drawTarget=qeGeometryAngles(cache,"+-+");
    const {angles,ki,kf}=drawTarget;
    source=[-L,0];
    mono=[0,0];
    thetaKi=deg2rad(angles.m2);
    sample=[mono[0]+L*Math.cos(thetaKi),mono[1]+L*Math.sin(thetaKi)];
    thetaKf=thetaKi+deg2rad(angles.s2);
    analyzer=[sample[0]+0.90*L*Math.cos(thetaKf),sample[1]+0.90*L*Math.sin(thetaKf)];
    thetaOut=thetaKf+deg2rad(angles.a2);
    detector=[analyzer[0]+0.80*L*Math.cos(thetaOut),analyzer[1]+0.80*L*Math.sin(thetaOut)];
    monoPlaneAngle=deg2rad(angles.m1);
    anaPlaneAngle=thetaKf+deg2rad(angles.a1);

    // Use the physical ki/kf ratio only to determine Q direction.  The displayed
    // arrow length stays fixed, so cold/thermal settings do not rescale the figure.
    const qx=ki*Math.cos(thetaKi)-kf*Math.cos(thetaKf);
    const qy=ki*Math.sin(thetaKi)-kf*Math.sin(thetaKf);
    const qMag=Math.hypot(qx,qy);
    qAngle=Math.atan2(qy,qx);

    // Encode inelasticity in the vector lengths without changing the instrument
    // flight-path geometry.  The fixed-energy wave vector always has the same
    // displayed length, and the other beam/Q vectors use the identical scale.
    const kFixed=(cache.energyMode==="Ef fixed") ? kf : ki;
    const vectorScale=(Number.isFinite(kFixed) && kFixed>1e-12) ? (0.50*L/kFixed) : 1;
    kiVectorLen=vectorScale*ki;
    kfVectorLen=vectorScale*kf;
    qVectorLen=vectorScale*qMag;

    // Keep the calculated coordinates in one canonical (+-+) frame.
    // For -+-, the Plotly x-axis is reversed below.  Reversing the viewport,
    // rather than recomputing/flipping every coordinate, guarantees a true
    // pixel-for-pixel left/right mirror with the same scale and anchor point.
  }else{
    // Previous idealized fallback.
    sample=[0,0]; mono=[0,L]; source=[-L,L]; analyzer=[-mirror*0.75*L,0]; detector=[-mirror*0.75*L,0.5*L];
    thetaKi=-Math.PI/2; thetaKf=mirror>0?Math.PI:-0; thetaOut=-Math.PI/2;
    monoPlaneAngle=mirror*deg2rad(45); anaPlaneAngle=mirror*deg2rad(45);
    qAngle=-mirror*Math.PI/4;
  }

  // Display-only transform.  First rotate the canonical TAS drawing so the
  // instrument develops mainly downward from the monochromator.  For -+-,
  // reflect the DRAWING coordinates themselves instead of reversing Plotly's
  // x axis.  This makes subsequent auto-fitting straightforward and keeps all
  // labels / dark-angle guides in the same coordinate system.
  const rotateCCW90=([x,y])=>[y,-x];
  source=rotateCCW90(source);
  mono=rotateCCW90(mono);
  sample=rotateCCW90(sample);
  analyzer=rotateCCW90(analyzer);
  detector=rotateCCW90(detector);
  thetaKi-=Math.PI/2;
  thetaKf-=Math.PI/2;
  thetaOut-=Math.PI/2;
  monoPlaneAngle-=Math.PI/2;
  anaPlaneAngle-=Math.PI/2;
  qAngle-=Math.PI/2;

  if(sense==="-+-") {
    const reflectX=([x,y])=>[-x,y];
    source=reflectX(source); mono=reflectX(mono); sample=reflectX(sample);
    analyzer=reflectX(analyzer); detector=reflectX(detector);
    const reflectAngle=a=>Math.PI-a;
    thetaKi=reflectAngle(thetaKi);
    thetaKf=reflectAngle(thetaKf);
    thetaOut=reflectAngle(thetaOut);
    monoPlaneAngle=reflectAngle(monoPlaneAngle);
    anaPlaneAngle=reflectAngle(anaPlaneAngle);
    qAngle=reflectAngle(qAngle);
  }

  const traces=[];
  const addLine=(a,b,color,width=3,dash="solid")=>traces.push({x:[a[0],b[0]],y:[a[1],b[1]],mode:"lines",line:{color,width,dash},hoverinfo:"skip",showlegend:false});
  const flightColor="#cfcfcf";
  addLine(source,mono,flightColor,4); addLine(mono,sample,flightColor,4); addLine(sample,analyzer,flightColor,4); addLine(analyzer,detector,flightColor,4);

  // Fixed, compact display radius: independent of instrument/angle auto-scaling.
  // The guide circle belongs to the dark-angle overlay, so hide it together
  // with the dark-angle sectors when the left-panel "show" checkbox is off.
  const showDarkGeometry=Boolean($("addDark")?.checked);
  const darkRadius=1.0;
  if(showDarkGeometry){
    const circle=linspace(0,2*Math.PI,181);
    traces.push({x:circle.map(t=>sample[0]+darkRadius*Math.cos(t)),y:circle.map(t=>sample[1]+darkRadius*Math.sin(t)),mode:"lines",line:{color:"#d9d9d9",width:1},hoverinfo:"skip",showlegend:false});
  }

  // Draw every enabled dark-angle asset independently. Reference-Q assets
  // rotate with the sample about Q; Direct-beam assets use the ki direction at
  // the Reference-Q condition; Fixed assets remain laboratory-fixed.
  let referenceBase=qAngle, deltaS1=0;
  if(target){
    try{
      const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
      const {ex,ey}=makeSpiceScatteringPlaneBasis(cache.rl,U,V);
      const qPlaneAngle=hkl=>{const q=hklToQ(cache.rl,hkl),x=dot(q,ex),y=dot(q,ey);return Math.hypot(x,y)<1e-12?0:Math.atan2(y,x);};
      const phiTarget=qPlaneAngle([target.calc.h,target.calc.k,target.calc.l]);
      const effectiveRef=effectiveOrientationReference(cache.rl,(cache.energyMode==="Ei fixed")?cache.Ei:cache.Ef);
      const phiRef=qPlaneAngle(effectiveRef.hkl);
      const crystalDelta=phiRef-phiTarget;
      // Keep the validated +-+ Dark-angle motion unchanged.  In the mirrored
      // -+- display, sample-attached directions must rotate with the same
      // counter-clockwise-positive S1 convention as the U/V arrows:
      //   U/V angle = qAngle + (phiAxis - phiTarget)
      // so use the same sign for the Dark-angle reference only in -+-.
      referenceBase=qAngle+(sense==="-+-" ? +crystalDelta : -crystalDelta);
      const refS1=effectiveRef.s1;
      if(Number.isFinite(target.angles?.s1)&&Number.isFinite(refS1)) deltaS1=angleDiffDeg(target.angles.s1,refS1);
    }catch(_err){ referenceBase=qAngle; }
  }

  if(showDarkGeometry) for(const asset of (cache.darkAssets||[])){
    let base=referenceBase, darkReferenceOffset=0;
    if(asset.ref==="Reference Q" && target){
      try{
        const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
        const {ex,ey}=makeSpiceScatteringPlaneBasis(cache.rl,U,V);
        const qPlaneAngle=hkl=>{const q=hklToQ(cache.rl,hkl),x=dot(q,ex),y=dot(q,ey);return Math.hypot(x,y)<1e-12?0:Math.atan2(y,x);};
        const phiTarget=qPlaneAngle([target.calc.h,target.calc.k,target.calc.l]);
        const phiDark=qPlaneAngle(asset.refHkl||[1,0,0]);
        const crystalDelta=phiDark-phiTarget;
        // Same display-only handedness correction as referenceBase above.
        // +-+ remains exactly as before; only -+- follows the U/V rotation sign.
        base=qAngle+(sense==="-+-" ? +crystalDelta : -crystalDelta);
      }catch(_err){}
    }else if(asset.ref==="Direct beam"){
      try{
        const effectiveRef=effectiveOrientationReference(cache.rl,(cache.energyMode==="Ei fixed")?cache.Ei:cache.Ef);
        const qRef=hklToQ(cache.rl,effectiveRef.hkl);
        const qRefNorm=norm(qRef), refEnergy=(cache.energyMode==="Ei fixed")?cache.Ei:cache.Ef;
        if(qRefNorm>1e-12&&Number.isFinite(refEnergy)&&refEnergy>0){
          const kRef=Math.sqrt(refEnergy/2.072), thetaRef=Math.asin(clamp(qRefNorm/(2*kRef),-1,1));
          const qToKi=Math.PI/2-thetaRef;
          // Direct-beam zero must lie on the forward ki extension. Relative
          // to the crystallographic reference direction the two TAS
          // configurations are mirror images:
          //   +-+ : -(90°-theta)
          //   -+- : +(90°-theta)
          base+=(sense==="+-+" ? -1 : +1)*qToKi;
          darkReferenceOffset=(sense==="+-+"?-1:+1)*rad2deg(qToKi);
        }
      }catch(_err){}
    }else if(asset.ref==="Fixed"){
      base=thetaKi; darkReferenceOffset=0;
    }
    asset.ranges.forEach((r,j)=>{
      const [from,to,offset]=r; if(from===0&&to===0) return;
      const directBeamCorrection=asset.ref==="Direct beam"
        ? directBeamOrientationCorrection(cache.rl,cache.energyMode,cache.Ei,cache.Ef,sense) : 0;

      // TAS Geometry display only:
      // after the -+- sample-attached Dark-angle rotation was corrected to follow
      // positive-S1 = counter-clockwise, its Direct-beam zero needs the mirrored
      // half-S2 calibration.  Flip only the -+- DISPLAY correction here.
      // +S2/2 -> -S2/2 changes the zero by exactly one full S2.
      // The Q-E/dark numerical calculation continues to use the existing helper.
      const geometryDirectBeamCorrection=(asset.ref==="Direct beam" && sense==="-+-")
        ? -directBeamCorrection
        : directBeamCorrection;

      let a0=offset+from+geometryDirectBeamCorrection,a1=offset+to+geometryDirectBeamCorrection; if(a1<a0)a1+=360;
      const aa=linspace(a0,a1,120).map(d=>base-deg2rad(d));
      // Display-only differentiation: every Dark angle is red.  Slots are
      // separated radially (1.0, 1.1, 1.2, ... x radius), so color no longer
      // needs to encode the slot number. Numerical dark-angle calculations are unchanged.
      const slotIndex=Math.max(1,Number(asset.slot)||1);
      const assetRadius=darkRadius*(1+0.1*(slotIndex-1));
      const assetColor="#d62728";
      traces.push({x:aa.map(t=>sample[0]+assetRadius*Math.cos(t)),y:aa.map(t=>sample[1]+assetRadius*Math.sin(t)),mode:"lines",line:{color:assetColor,width:4},name:`Dark ${asset.slot}-${j+1}`,hovertemplate:`Dark angle ${asset.slot}-${j+1}<br>Reference=${asset.ref}<br>ΔS1=${deltaS1.toFixed(2)}°<br>Ref offset=${darkReferenceOffset.toFixed(2)}°<extra></extra>`,showlegend:false});
    });
  }

  const crystal=(c,ang,len=0.58)=>{const dx=.5*len*Math.cos(ang),dy=.5*len*Math.sin(ang);addLine([c[0]-dx,c[1]-dy],[c[0]+dx,c[1]+dy],"black",3);};
  crystal(mono,monoPlaneAngle); crystal(analyzer,anaPlaneAngle);
  traces.push({x:[detector[0]],y:[detector[1]],mode:"markers",marker:{size:24,symbol:"circle",color:"orange",line:{color:"black",width:1}},hovertext:["Detector"],hovertemplate:"%{hovertext}<extra></extra>",showlegend:false});
  traces.push({x:[sample[0]],y:[sample[1]],mode:"markers",marker:{size:8,symbol:"circle",color:"black"},hovertext:["Sample"],hovertemplate:"%{hovertext}<extra></extra>",showlegend:false});

  const pointAlong=(a,b,f)=>[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f];
  // ki points into the sample; kf points away from it.  Their lengths now carry
  // the actual |ki|/|kf| ratio.  Q uses the same reciprocal-space scale, so its
  // magnitude and direction are consistent with Q = ki - kf.
  const kiArrow={
    tail:[sample[0]-kiVectorLen*Math.cos(thetaKi),sample[1]-kiVectorLen*Math.sin(thetaKi)],
    head:sample.slice()
  };
  const kfArrow={
    tail:sample.slice(),
    head:[sample[0]+kfVectorLen*Math.cos(thetaKf),sample[1]+kfVectorLen*Math.sin(thetaKf)]
  };
  const qEnd=[sample[0]+qVectorLen*Math.cos(qAngle),sample[1]+qVectorLen*Math.sin(qAngle)];

  // Display-only crystallographic U/V guides. Numerical TAS calculations are unchanged.
  let uArrowAngle=qAngle, vArrowAngle=qAngle;
  try{
    const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
    const {ex,ey}=makeSpiceScatteringPlaneBasis(cache.rl,U,V);
    const planePhi=hkl=>{const q=hklToQ(cache.rl,hkl),x=dot(q,ex),y=dot(q,ey);return Math.atan2(y,x);};
    const targetHKL=target ? [target.calc.h,target.calc.k,target.calc.l] : U;
    const phiT=planePhi(targetHKL), phiU=planePhi(U), phiV=planePhi(V);
    // Display-only U/V convention.
    //
    // -+- is already validated and remains exactly on the existing
    // right-handed formula:
    //   qAngle + (phiAxis - phiTarget)
    //
    // For +-+, U/V must rotate with the already-validated sample-attached
    // Dark-angle motion, BUT the U->V crystallographic separation must keep
    // its original right-handed sign.  Therefore do not negate each
    // (phiAxis-phiTarget) offset (that mirrors U/V into a left-handed pair).
    // Instead:
    //   1) rotate a common crystallographic reference axis with the Dark angle;
    //   2) add the original right-handed U/V offsets from that reference axis.
    if(sense==="+-+"){
      const fixedRefEnergy=(cache.energyMode==="Ei fixed") ? cache.Ei : cache.Ef;
      const orientationRef=effectiveOrientationReference(cache.rl,fixedRefEnergy);
      const phiRef=planePhi(orientationRef.hkl);
      const crystalBase=qAngle-(phiRef-phiT);
      uArrowAngle=crystalBase+(phiU-phiRef);
      vArrowAngle=crystalBase+(phiV-phiRef);
    }else{
      uArrowAngle=qAngle+(phiU-phiT);
      vArrowAngle=qAngle+(phiV-phiT);
    }
  }catch(_err){}
  // Display U and V as vectors, like ki/kf/Q.  Their length is 1.5 times the
  // guide-circle radius so the arrowheads and labels sit clear of the circle.
  const uvVectorLen=1.5*darkRadius;
  const vectorEnd=ang=>[
    sample[0]+uvVectorLen*Math.cos(ang),
    sample[1]+uvVectorLen*Math.sin(ang)
  ];
  const uEnd=vectorEnd(uArrowAngle), vEnd=vectorEnd(vArrowAngle);
  const uColor="#f2b6a0", vColor="#e377c2";

  // Component-label placement only; the TAS geometry/calculation is untouched.
  // Place Monochromator and Analyzer labels beside their components rather than
  // directly underneath them. Put the Sample label farther outside the guide
  // circle on the side opposite to Q so the text does not overlap the circle.
  // Keep the monochromator label on the same screen side as its anchored
  // component: left for +-+, right for -+-.
  const monoLabel=[mono[0]+(sense==="+-+"?-1.05:1.05),mono[1]];
  const anaLabel=[analyzer[0]-1.05,analyzer[1]];
  const sampleLabelRadius=1.55;
  const sampleLabel=[
    sample[0]-sampleLabelRadius*Math.cos(qAngle),
    sample[1]-sampleLabelRadius*Math.sin(qAngle)
  ];
  const detLabel=[detector[0],detector[1]-0.58];
  const kiMid=pointAlong(kiArrow.tail,kiArrow.head,.5),kfMid=pointAlong(kfArrow.tail,kfArrow.head,.5),qMid=pointAlong(sample,qEnd,.5);

  const annotations=[
    {x:uEnd[0],y:uEnd[1],ax:sample[0],ay:sample[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.4,arrowcolor:uColor},
    {x:vEnd[0],y:vEnd[1],ax:sample[0],ay:sample[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.4,arrowcolor:vColor},
    {x:uEnd[0]+0.16*Math.cos(uArrowAngle),y:uEnd[1]+0.16*Math.sin(uArrowAngle),text:"U",showarrow:false,font:{color:uColor,size:14}},
    {x:vEnd[0]+0.16*Math.cos(vArrowAngle),y:vEnd[1]+0.16*Math.sin(vArrowAngle),text:"V",showarrow:false,font:{color:vColor,size:14}},
    {x:monoLabel[0],y:monoLabel[1],text:"Monochromator",showarrow:false},
    {x:sampleLabel[0],y:sampleLabel[1],text:"Sample",showarrow:false},
    {x:anaLabel[0],y:anaLabel[1],text:"Analyzer",showarrow:false},
    {x:detLabel[0],y:detLabel[1],text:"Detector",showarrow:false},
    {x:kiArrow.head[0],y:kiArrow.head[1],ax:kiArrow.tail[0],ay:kiArrow.tail[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.8,arrowcolor:"#7ac943"},
    {x:kfArrow.head[0],y:kfArrow.head[1],ax:kfArrow.tail[0],ay:kfArrow.tail[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.8,arrowcolor:"#58c7e8"},
    {x:kiMid[0]+0.18*Math.sin(thetaKi),y:kiMid[1]-0.18*Math.cos(thetaKi),text:"ki",showarrow:false,font:{color:"#7ac943"}},
    {x:kfMid[0]+0.18*Math.sin(thetaKf),y:kfMid[1]-0.18*Math.cos(thetaKf),text:"kf",showarrow:false,font:{color:"#58c7e8"}},
    {x:qEnd[0],y:qEnd[1],ax:sample[0],ay:sample[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.8,arrowcolor:"#000"},
    {x:qMid[0]-0.18*Math.sin(qAngle),y:qMid[1]+0.18*Math.cos(qAngle),text:"Q",showarrow:false,font:{color:"#000"}}
  ];

  // Auto-fit the full TAS drawing to the geometry card, while anchoring
  // the monochromator at a fixed screen position so changing the hbar-omega
  // slider does not make the whole schematic jump.  +-+ anchors Mono toward
  // the left; -+- anchors Mono farther toward the right so the whole mirrored
  // configuration sits closer to the right edge, as requested.  Sample /
  // analyzer / detector / guide-circle positions are otherwise free to move
  // with the calculated angles.
  const fitPoints=[source,mono,sample,analyzer,detector,kiArrow.tail,kiArrow.head,kfArrow.head,qEnd,uEnd,vEnd,monoLabel,anaLabel,sampleLabel,detLabel];
  const radial=Math.max(darkRadius,uvVectorLen,qVectorLen,kiVectorLen,kfVectorLen);
  fitPoints.push(
    [sample[0]-radial,sample[1]],[sample[0]+radial,sample[1]],
    [sample[0],sample[1]-radial],[sample[0],sample[1]+radial]
  );
  // Display layout only.
  // Keep +-+ at its established left-side anchor.  The mirrored -+- drawing was
  // effectively pushed to ~90% of the card width (0.85 anchor + 5% viewport
  // shift), which could clip labels.  Bring it back to a safer ~80% position.
  const monoFracX=sense==="+-+" ? 0.23 : 0.80;
  const monoFracY=0.78;

  // Reduce the auto-fit whitespace by about 1.5x.  Fit constraints below still
  // win whenever the actual TAS geometry/labels need more room, so this enlarges
  // roomy drawings without blindly cropping wide configurations.
  const geometryDisplayScale=1.5;
  const fitPad=(0.32/geometryDisplayScale)*L;
  let span=(2.5/geometryDisplayScale)*L;
  for(const p of fitPoints){
    const dx=p[0]-mono[0], dy=p[1]-mono[1];
    if(dx<0) span=Math.max(span,(-dx+fitPad)/monoFracX);
    else if(dx>0) span=Math.max(span,(dx+fitPad)/(1-monoFracX));
    if(dy<0) span=Math.max(span,(-dy+fitPad)/monoFracY);
    else if(dy>0) span=Math.max(span,(dy+fitPad)/(1-monoFracY));
  }
  // Keep the same anti-overzoom floor, but at ~1.5x larger display scale.
  span=Math.max(span,(4.0/geometryDisplayScale)*L);
  const xMin=mono[0]-monoFracX*span, xMax=xMin+span;
  const yMin=mono[1]-monoFracY*span, yMax=yMin+span;

  const angleBox=$("geometryAngles");
  if(angleBox){
    if(target){
      const a=target.angles;
      angleBox.classList.remove("error-text");
      const energyLine=`Ei=${target.Ei.toFixed(3)} meV, Ef=${target.Ef.toFixed(3)} meV`;

      // Display-only S2 sign in the Angle calculation & TAS geometry card.
      // Keep target.angles.s2 unchanged because it is used by the geometry.
      const s2Display=sense==="+-+"
        ? -Math.abs(Number(a.s2))
        : +Math.abs(Number(a.s2));

      const angleLine=`M1=${formatAngle(-a.m1)}°, M2=${formatAngle(-a.m2)}°, S1=${formatAngle(a.s1)}°, S2=${formatAngle(s2Display)}°, A1=${formatAngle(-a.a1)}°, A2=${formatAngle(-a.a2)}°`+
        (a.warning?` &nbsp; | &nbsp; ${a.warning}`:"");
      angleBox.innerHTML=`<div class="geometry-result-line geometry-energy-line">${energyLine}</div><div class="geometry-result-line geometry-angle-line">${angleLine}</div>`;
    }else{
      angleBox.classList.add("error-text"); angleBox.textContent=`Angle calculation unavailable: ${targetError}`;
    }
  }

  Plotly.react("geometryPlot",traces,{
    xaxis:{range:[xMin,xMax],showgrid:false,zeroline:false,showticklabels:false,fixedrange:true,constrain:"domain"},
    yaxis:{range:[yMin,yMax],showgrid:false,zeroline:false,showticklabels:false,scaleanchor:"x",scaleratio:1,fixedrange:true,constrain:"domain"},
    annotations,margin:{l:10,r:10,t:12,b:10},showlegend:false
  },{responsive:true,displayModeBar:false});
}

function powderS2ForQAtHW(q,hw){
  const wv=powderWavevectors(hw);
  if(!wv) return NaN;
  const {ki,kf}=wv;
  const denom=2*ki*kf;
  if(!(denom>0)) return NaN;
  const c=(ki*ki+kf*kf-q*q)/denom;
  if(c < -1-1e-10 || c > 1+1e-10) return NaN;
  return rad2deg(Math.acos(clamp(c,-1,1)));
}

function powderSfText(sf2){
  if(!Number.isFinite(sf2)) return "N/A";
  const a=Math.abs(sf2);
  const s=(a!==0 && (a>=1e5 || a<1e-3)) ? sf2.toExponential(4) : sf2.toFixed(4).replace(/\.?0+$/,"");
  return `|F_N|² = ${s} fm²`;
}

function groupPowderReflectionsByQ(entries){
  const groups=new Map();
  for(const e of entries){
    const key=Number(e.q).toFixed(6);
    let g=groups.get(key);
    if(!g){
      g={q:Number(e.q),entries:[]};
      groups.set(key,g);
    }
    g.entries.push(e);
  }
  return [...groups.values()].sort((a,b)=>a.q-b.q);
}

function backgroundPowderCorrectionAtElasticQ(q){
  // Background nuclear Bragg scattering is treated as elastic.  The selected
  // fixed TAS energy therefore sets the constant wavelength with Ei = Ef = E,
  // for both "Ef fixed" and "Ei fixed" UI modes.
  //
  // FullProf constant-wavelength neutron powder (K=0) uses
  //   Lp = 1 / (2 sin^2(theta) cos(theta))
  //      = 1 / (sin(theta) sin(2 theta)).
  //
  // Calculate the elastic powder pattern all the way through S2 = 180 deg
  // (Q = 2k).  The geometrical factor is singular exactly at 180 deg, so only
  // the numerical denominator is protected at machine precision; S2 itself
  // remains exactly 180 deg at the endpoint.
  const E=num("energy");
  if(!(E>0) || !(q>0)) return null;
  const k=Math.sqrt(E/2.072);
  const sinTheta=q/(2*k);
  if(!(sinTheta>0) || sinTheta>1+1e-10) return null;
  const theta=Math.asin(clamp(sinTheta,0,1));
  const s2=2*theta;
  const denomRaw=Math.abs(Math.sin(theta)*Math.sin(s2));
  const denom=Math.max(denomRaw,Number.EPSILON);
  return {
    s2Deg:Math.min(180,rad2deg(s2)),
    lorentzDebye:1/denom
  };
}

function backgroundPowderPeaks(material,qLimit){
  const structure=material?.structure;
  const lc=structure?.lattice;
  if(!lc) return [];
  const vals=[lc.a,lc.b,lc.c,lc.alpha,lc.beta,lc.gamma].map(Number);
  if(!vals.every(Number.isFinite)) return [];

  // Build/normalize the BG powder pattern over the complete elastic
  // backscattering interval S2 = 0..180 deg, irrespective of the current
  // instrument S2 limit.  Rendering is still clipped to the current plot Q
  // window below.
  const E=num("energy");
  if(!(E>0)) return [];
  const kElastic=Math.sqrt(E/2.072);
  const qCalcLimit=2*kElastic; // S2 = 180 deg.

  const rv=reciprocalVectors(...vals);
  const hmax=Math.max(1,Math.ceil(lc.a*qCalcLimit/(2*PI))+1);
  const kmax=Math.max(1,Math.ceil(lc.b*qCalcLimit/(2*PI))+1);
  const lmax=Math.max(1,Math.ceil(lc.c*qCalcLimit/(2*PI))+1);
  const entries=[];

  for(let h=-hmax;h<=hmax;h++){
    for(let k=-kmax;k<=kmax;k++){
      for(let l=-lmax;l<=lmax;l++){
        if(h===0 && k===0 && l===0) continue;
        const hkl=[h,k,l];
        const G=add(add(scale(rv.astar,h),scale(rv.bstar,k)),scale(rv.cstar,l));
        const q=norm(G);
        if(!(q>1e-8) || q>qCalcLimit+1e-10) continue;
        const sf2=nuclearStructureFactorSquared(structure,hkl,q);
        if(Number.isFinite(sf2)) entries.push({hkl,q,sf2});
      }
    }
  }

  if(!entries.length) return [];
  const sfMax=Math.max(0,...entries.map(p=>p.sf2));
  const surviving=sfMax>0 ? entries.filter(p=>p.sf2>sfMax*1e-10) : entries;
  const groups=groupPowderReflectionsByQ(surviving);

  const corrected=[];
  for(const g of groups){
    const correction=backgroundPowderCorrectionAtElasticQ(g.q);
    // A constant-wavelength elastic powder Bragg peak has no real 2theta when
    // q > 2k, so it is not part of the corresponding FullProf-like pattern.
    if(!correction) continue;

    // Coincident powder reflections are summed first, so the represented hkl
    // multiplicity contributes directly.  Then apply the neutron powder
    // Lorentz / Debye-cone correction at the elastic S2.
    g.sf2Sum=g.entries.reduce((sum,p)=>sum+Math.max(0,Number(p.sf2)||0),0);
    g.elasticS2=correction.s2Deg;
    g.lorentzDebye=correction.lorentzDebye;
    g.intensity=g.sf2Sum*g.lorentzDebye;
    corrected.push(g);
  }

  const maxIntensity=Math.max(0,...corrected.map(g=>g.intensity));
  for(const g of corrected) g.relativeIntensity=maxIntensity>0 ? g.intensity/maxIntensity : 0;

  // Keep the full 0..180-deg calculation for normalization, but only return
  // peaks that lie inside the Q range currently being drawn.
  return corrected.filter(g=>g.q<=qLimit+1e-10);
}

function representativePowderHklText(group){
  const entries=(group?.entries||[]).slice().sort((a,b)=>
    formatHKL(a.hkl).localeCompare(formatHKL(b.hkl))
  );
  if(!entries.length) return "N/A";
  const label=`(${formatHKL(entries[0].hkl)})`;
  return entries.length>1 ? `${label} & equivalent` : label;
}

function powderS2HoverText(q,hw){
  const s2=powderS2ForQAtHW(q,hw);
  return Number.isFinite(s2) ? `${s2.toFixed(3)}°` : "N/A";
}

function appendPowderBackgroundCurve(target,q,hwList,detailHtml){
  let open=false;
  for(const w of hwList){
    const s2=powderS2ForQAtHW(q,w);
    if(!Number.isFinite(s2)){
      if(open){
        target.x.push(null); target.y.push(null); target.customdata.push(null);
        open=false;
      }
      continue;
    }
    target.x.push(q);
    target.y.push(w);
    target.customdata.push([detailHtml,q,`${s2.toFixed(3)}°`]);
    open=true;
  }
  if(open){
    target.x.push(null); target.y.push(null); target.customdata.push(null);
  }
}

function appendPowderBraggLine(target,q,hwList,detailHtml){
  // Draw every Bragg line over the exact same hbar-omega span.  The yellow
  // accessible region shows where the instrument can actually reach the peak;
  // S2 is still evaluated point-by-point for hover and becomes N/A only when
  // no real scattering angle exists at that (Q,hbar-omega).
  for(const w of hwList){
    target.x.push(q);
    target.y.push(w);
    target.customdata.push([detailHtml,q,powderS2HoverText(q,w)]);
  }
  target.x.push(null);
  target.y.push(null);
  target.customdata.push(null);
}

function calculatePowder(){
  const inst=currentInstrument();
  const lc=latticeParams();
  const rv=reciprocalVectors(lc.a,lc.b,lc.c,lc.alpha,lc.beta,lc.gamma);
  const energyMode=checkedValue("energyMode");
  const E=num("energy"), S2min=num("S2min");

  const qmin=[],qmax=[],hw=[],s2minList=[],s2maxList=[];

  if(energyMode==="Ef fixed"){
    const Ef=E;
    const EiMax=Math.max(...rangeTable(inst).map(x=>Number(x.Ei)));
    for(const Ei of arange(Ef+0.01,EiMax,0.1)){
      const s2max=validateEffectiveS2Max(effectiveS2MaxAtEi(inst,Ei,false),S2min,Ei);
      const ki=0.6947*Math.sqrt(Ei), kf=0.6947*Math.sqrt(Ef);
      const tmin=deg2rad(S2min),tmax=deg2rad(s2max);
      qmin.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmin)));
      qmax.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmax)));
      hw.push(Ei-Ef);
      s2minList.push(S2min);
      s2maxList.push(s2max);
    }
  } else {
    const Ei=E;
    const s2max=validateEffectiveS2Max(effectiveS2MaxAtEi(inst,Ei,false),S2min,Ei);
    const ki=0.6947*Math.sqrt(Ei);
    for(const w of arange(0,Ei-0.01,0.1)){
      const Ef=Ei-w;
      if(Ef<=0) continue;
      const kf=0.6947*Math.sqrt(Ef),tmin=deg2rad(S2min),tmax=deg2rad(s2max);
      qmin.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmin)));
      qmax.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmax)));
      hw.push(w);
      s2minList.push(S2min);
      s2maxList.push(s2max);
    }
  }
  if(!qmax.length) throw new Error("No accessible powder range was generated.");

  const traces=[{
    x:[...qmin,...[...qmax].reverse()],
    y:[...hw,...[...hw].reverse()],
    fill:"toself",
    fillcolor:"rgba(255,215,0,0.20)",
    line:{width:0},
    name:"Accessible QE range",
    legendrank:0,
    hoverinfo:"skip"
  }];

  const Qlim=Math.max(...qmax), hwmin=Math.min(...hw), hwmax=Math.max(...hw);
  const latticeCentering=selectedSampleCentering();

  // Enumerate genuine powder reciprocal-lattice reflections rather than only
  // plotting integer multiples of a*, b*, c*.  The exact index bounds follow
  // |h| <= a|Q|/(2π), etc., from h = a·Q/(2π), so non-orthogonal cells are
  // covered without relying on an orthogonal-axis approximation.
  const propagation=enabledPropagationVectors()
    .map(kv=>({...kv,K:hklToQ({astar:rv.astar,bstar:rv.bstar,cstar:rv.cstar},kv.hkl)}))
    .filter(kv=>norm(kv.K)>1e-10);
  const maxK=propagation.length ? Math.max(...propagation.map(kv=>norm(kv.K))) : 0;
  const parentQlim=Qlim+maxK+1e-8;
  const hmax=Math.max(1,Math.ceil(lc.a*parentQlim/(2*PI))+1);
  const kmax=Math.max(1,Math.ceil(lc.b*parentQlim/(2*PI))+1);
  const lmax=Math.max(1,Math.ceil(lc.c*parentQlim/(2*PI))+1);

  const parentCandidates=[];
  for(let h=-hmax;h<=hmax;h++){
    for(let k=-kmax;k<=kmax;k++){
      for(let l=-lmax;l<=lmax;l++){
        const hkl=[h,k,l];
        const isOrigin=h===0&&k===0&&l===0;
        if(!isOrigin && !isAllowedByCentering(hkl,latticeCentering)) continue;
        const G=add(add(scale(rv.astar,h),scale(rv.bstar,k)),scale(rv.cstar,l));
        const q=norm(G);
        if(q>parentQlim+1e-10) continue;
        const sf2=selectedCifStructure && !isOrigin
          ? nuclearStructureFactorSquared(selectedCifStructure,hkl,q)
          : null;
        parentCandidates.push({hkl,q,isOrigin,sf2:Number.isFinite(sf2)?sf2:null});
      }
    }
  }

  // Match the existing Single-crystal CIF extinction handling: remove
  // effectively extinct nuclear parents only when a CIF structure factor is
  // available.  Keep the origin as a valid magnetic-satellite parent.
  if(selectedCifStructure){
    const sfMax=Math.max(0,...parentCandidates.filter(p=>!p.isOrigin).map(p=>Number.isFinite(p.sf2)?p.sf2:0));
    if(sfMax>0){
      for(let i=parentCandidates.length-1;i>=0;i--){
        const p=parentCandidates[i];
        if(!p.isOrigin && Number.isFinite(p.sf2) && p.sf2<=sfMax*1e-10) parentCandidates.splice(i,1);
      }
    }
  }

  // Background powder peaks are calculated directly from BG_material CIFs.
  // Intensity is multiplicity-weighted Σ|F_N|² times the FullProf-like
  // constant-wavelength neutron Lorentz / Debye-cone factor
  // 1 / (sin(theta) sin(2theta)), normalized within each BG material.
  for(const bg of selectedBackgrounds()){
    const material=backgroundMaterials.get(bg.key);
    const visiblePeaks=backgroundPowderPeaks(material,Qlim);

    visiblePeaks.forEach((p,index)=>{
      const ratio=p.relativeIntensity;
      const data={x:[],y:[],customdata:[]};
      appendPowderBackgroundCurve(
        data,p.q,hw,
        `BG${bg.index+1}: ${bg.key}<br>${representativePowderHklText(p)}<br>I/Imax = ${ratio.toFixed(3)}`
      );
      if(!data.x.length) return;
      traces.push({
        ...data,
        mode:"lines",
        name:`BG${bg.index+1}: ${bg.key}`,
        legendgroup:`background-scattering-${bg.index}`,
        showlegend:index===0,
        legendrank:30+bg.index,
        line:{
          color:backgroundColor(bg.slot,0.20+0.75*ratio),
          width:1.5
        },
        hovertemplate:`%{customdata[0]}<br>Q = %{customdata[1]:.4f} Å⁻¹<br>ħω = %{y:.3f} meV<br>S2 = %{customdata[2]}<extra></extra>`
      });
    });
  }

  // Nuclear Bragg peaks: all black solid lines have the same hbar-omega
  // length.  Reflections with the same powder Q are merged into one line, and
  // the hover text lists every contributing index and its own |F_N|².
  const nuclearGroups=groupPowderReflectionsByQ(
    parentCandidates.filter(p=>!p.isOrigin && p.q>1e-8 && p.q<=Qlim+1e-10)
  );
  const nuclearData={x:[],y:[],customdata:[]};
  for(const group of nuclearGroups){
    const entries=[...group.entries]
      .sort((a,b)=>formatHKL(a.hkl).localeCompare(formatHKL(b.hkl)));
    const rep=entries[0];
    const hklText=representativePowderHklText(group);
    const details=`${hklText}<br>${powderSfText(rep?.sf2)}`;
    appendPowderBraggLine(nuclearData,group.q,hw,details);
  }
  if(nuclearData.x.length){
    traces.push({
      ...nuclearData,
      mode:"lines",
      name:"Nuclear Bragg peaks",
      legendgroup:"powder-nuclear",
      showlegend:true,
      legendrank:10,
      line:{color:"black",width:1.25,dash:"solid"},
      hovertemplate:`Nuclear Bragg peaks<br>%{customdata[0]}<br>Q = %{customdata[1]:.4f} Å⁻¹<br>ħω = %{y:.3f} meV<br>S2 = %{customdata[2]}<extra></extra>`,
      zorder:0
    });
  }

  // Magnetic Bragg peaks: use surviving nuclear parents, exactly as the
  // Single-crystal path does conceptually.  Magnetic structure factors are
  // intentionally not invented here; the current application does not
  // calculate them.  All k1/k2/k3 satellites share one red solid-line style,
  // one compact legend entry, and the same hbar-omega line length.
  const magneticUnique=new Map();
  for(const parent of parentCandidates){
    for(const kv of propagation){
      for(const sign of [1,-1]){
        const hm=add(parent.hkl,scale(kv.hkl,sign));
        const Gm=hklToQ({astar:rv.astar,bstar:rv.bstar,cstar:rv.cstar},hm);
        const q=norm(Gm);
        if(!(q>1e-8) || q>Qlim+1e-10) continue;
        const hklKey=hm.map(x=>Number(x).toFixed(8)).join(",");
        const key=`${kv.index}:${hklKey}`;
        if(!magneticUnique.has(key)){
          magneticUnique.set(key,{q,hkl:hm,qIndex:kv.index});
        }
      }
    }
  }
  const magneticGroups=groupPowderReflectionsByQ([...magneticUnique.values()]);
  const magneticData={x:[],y:[],customdata:[]};
  for(const group of magneticGroups){
    const entries=[...group.entries]
      .sort((a,b)=>a.qIndex-b.qIndex || formatHKL(a.hkl).localeCompare(formatHKL(b.hkl)));
    const rep=entries[0];
    const suffix=entries.length>1 ? " & equivalent" : "";
    const details=rep ? `k${rep.qIndex}: (${formatHKL(rep.hkl)})${suffix}` : "N/A";
    appendPowderBraggLine(magneticData,group.q,hw,details);
  }
  if(magneticData.x.length){
    traces.push({
      ...magneticData,
      mode:"lines",
      name:"Magnetic Bragg peaks",
      legendgroup:"powder-magnetic",
      showlegend:true,
      legendrank:20,
      line:{color:"red",width:1.25,dash:"solid"},
      hovertemplate:`Magnetic Bragg peaks<br>%{customdata[0]}<br>Q = %{customdata[1]:.4f} Å⁻¹<br>ħω = %{y:.3f} meV<br>S2 = %{customdata[2]}<extra></extra>`,
      zorder:10
    });
  }

  const qMargin=0.1*Qlim;
  const title=`${inst.name||"Instrument"} | ${energyMode==="Ef fixed"?"Ef":"Ei"}=${E.toFixed(2)} meV | `+
    `a=${lc.a.toFixed(3)}, b=${lc.b.toFixed(3)}, c=${lc.c.toFixed(3)} Å<br>`+
    `α=${lc.alpha.toFixed(1)}, β=${lc.beta.toFixed(1)}, γ=${lc.gamma.toFixed(1)}°`;

  const keptPowderView=currentPlotRanges("powderPlot");

  Plotly.react("powderPlot",traces,{
    uirevision:"powderPlot-q",
    title:{text:title,x:0.5,xanchor:"center",font:{size:16}},
    xaxis:{
      title:"Q (Å⁻¹)",
      // Powder Q is non-negative by definition.  Always anchor the displayed
      // x-axis at Q = 0; preserve only a previously zoomed positive upper edge.
      range:[0,(keptPowderView.x && keptPowderView.x[1]>0) ? keptPowderView.x[1] : Qlim+qMargin],
      showgrid:true,gridcolor:"lightgray",zeroline:false,
      // Draw a complete rectangular plotting frame on all four sides.
      showline:true,mirror:"allticks",ticks:"outside",linecolor:"black",linewidth:1.5,automargin:true
    },
    yaxis:{
      title:"ħω (meV)",
      // Keep the displayed hbar-omega range exactly on the generated
      // accessible-range endpoints; no extra top/bottom padding.
      range:[hwmin,hwmax],
      showgrid:true,gridcolor:"lightgray",zeroline:false,
      // Match the x-axis with a complete rectangular plotting frame.
      showline:true,mirror:"allticks",ticks:"outside",linecolor:"black",linewidth:1.5,automargin:true
    },
    plot_bgcolor:"white",paper_bgcolor:"white",
    legend:{orientation:"h",x:0.5,xanchor:"center",y:-0.16,yanchor:"top"},
    margin:{l:66,r:34,t:80,b:110},
    hovermode:"closest"
  },{responsive:true});
}

let timer=null;
function scheduleRecalc(){
  clearTimeout(timer);
  timer=setTimeout(recalculate,50);
}
function setGeometryTargetHKL(hkl){
  const values=hkl.map(Number);
  if(values.length!==3 || values.some(v=>!Number.isFinite(v))) return;
  $("geomH").value=values[0];
  $("geomK").value=values[1];
  $("geomL").value=values[2];
  // Quick-target buttons and the initial Reference-Q target change HKL only.
  // Keep the current geometry energy transfer (geomHW / slider) untouched.
  scheduleRecalc();
}
function setGeometryTargetFromU(){ setGeometryTargetHKL([num("Uh"),num("Uk"),num("Ul")]); }
function setGeometryTargetFromV(){ setGeometryTargetHKL([num("Vh"),num("Vk"),num("Vl")]); }
function setGeometryKiOrientationCondition(mode){
  try{
    const b=collectResolutionBase();
    // Geometry target selection uses the same canonical physical orientation as
    // Angle / Q-E / Dark-angle, so equivalent labels execute the same path.
    mode=canonicalOrientationMode(b.rl,mode);
    const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
    const {ex,ey}=makeSpiceScatteringPlaneBasis(b.rl,U,V);
    const qU=hklToQ(b.rl,U), qV=hklToQ(b.rl,V);
    const ux=dot(qU,ex), uy=dot(qU,ey), vx=dot(qV,ex), vy=dot(qV,ey);
    const phiU=rad2deg(Math.atan2(uy,ux)), phiV=rad2deg(Math.atan2(vy,vx));
    const usesV=mode==="perpV" || mode==="parallelV";
    const isParallel=mode==="parallelU" || mode==="parallelV";
    const phiAxis=usesV?phiV:phiU;

    // Perpendicular-condition buttons are absolute quick targets, not operations
    // on the previously entered Q.  Start from the corresponding fundamental
    // U/V Bragg position at elastic transfer so a previous high-Q target cannot
    // select a higher-|Q| solution.
    const currentHKL=(usesV?V:U).slice();
    const hw=0;
    $("geomH").value=currentHKL[0];
    $("geomK").value=currentHKL[1];
    $("geomL").value=currentHKL[2];
    $("geomHW").value=0;
    const qCurrent=hklToQ(b.rl,currentHKL), qNorm=norm(qCurrent);
    if(!(qNorm>1e-12)) throw new Error(`${usesV?"V":"U"} must be non-zero.`);
    const em=b.config.energy_mode;
    const Ei=em==="Ei fixed"?Number(b.config.Ei):Number(b.config.Ef)+hw;
    const Ef=em==="Ei fixed"?Number(b.config.Ei)-hw:Number(b.config.Ef);
    if(!(Ei>0) || !(Ef>0)) throw new Error("Ei and Ef must be positive.");
    const ki=Math.sqrt(Ei/2.072), kf=Math.sqrt(Ef/2.072);
    const cosS2=(ki*ki+kf*kf-qNorm*qNorm)/(2*ki*kf);
    if(cosS2<-1-1e-10||cosS2>1+1e-10) throw new Error("Current |Q| is not accessible at this energy transfer.");
    const s2Geom=rad2deg(Math.acos(clamp(cosS2,-1,1))), t=deg2rad(s2Geom);
    const phiQlab=rad2deg(Math.atan2(-kf*Math.sin(t),ki-kf*Math.cos(t)));
    const orient=canonicalOrientationMode(
      b.rl,$('orientationReference')?.value||'perpU'
    );
    let s1Perp;
    if(orient==='perpU') s1Perp=wrap180(-(phiAxis-phiU));
    else if(orient==='perpV') s1Perp=wrap180(-(phiAxis-phiV));
    else{
      const tx=dot(qCurrent,ex),ty=dot(qCurrent,ey),phi0=rad2deg(Math.atan2(ty,tx));
      const a0=tasMotorAngles({h:currentHKL[0],k:currentHKL[1],l:currentHKL[2],hw},b);
      const phiTargetPerp=wrap180(phiQlab+phiAxis-90);
      s1Perp=wrap180(a0.s1-angleDiffDeg(phiTargetPerp,phi0));
    }
    let phiTargetDeg;
    // For a matching ki-perpendicular Orientation reference, derive the
    // quick-target azimuth from the same calibrated S1 relation used by
    // tasMotorAngles().  At elastic transfer and equal |Q|:
    //
    //   S1 = S1_ref + (phi_ref - phi_target)/c2Sign
    //
    // Requiring S1=0 gives:
    //
    //   phi_target = phi_ref + c2Sign*S1_ref
    //
    // This is especially important for user-facing -+-, whose perpendicular
    // virtual Bragg reference is +S2/2 rather than -S2/2.
    if(orient===mode && ['perpU','perpV','parallelU','parallelV'].includes(mode)){
      const fixedE=em==="Ei fixed" ? Number(b.config.Ei) : Number(b.config.Ef);
      const orientationRef=effectiveOrientationReference(b.rl,fixedE);
      const c2Sign=(b.config.sign_config==='+-+') ? +1 : -1;
      phiTargetDeg=wrap180(phiAxis+c2Sign*orientationRef.s1);
    }else if(orient==='perpU') phiTargetDeg=wrap180(-90+phiU-phiQlab-s1Perp);
    else if(orient==='perpV') phiTargetDeg=wrap180(-90+phiV-phiQlab-s1Perp);
    else{
      const tx=dot(qCurrent,ex),ty=dot(qCurrent,ey),phi0=rad2deg(Math.atan2(ty,tx));
      const a0=tasMotorAngles({h:currentHKL[0],k:currentHKL[1],l:currentHKL[2],hw},b);
      phiTargetDeg=wrap180(phi0-angleDiffDeg(s1Perp,a0.s1));
    }
    const phiTarget=deg2rad(phiTargetDeg), qx=qNorm*Math.cos(phiTarget), qy=qNorm*Math.sin(phiTarget);
    const det=ux*vy-uy*vx; if(Math.abs(det)<=1e-12) throw new Error("U and V do not define an independent scattering plane.");
    const aa=(qx*vy-qy*vx)/det, bb=(ux*qy-uy*qx)/det;
    setGeometryTargetHKL([aa*U[0]+bb*V[0],aa*U[1]+bb*V[1],aa*U[2]+bb*V[2]].map(x=>Number(x.toFixed(3))));
  }catch(err){ console.error(err); alert(err?.message||String(err)); }
}
function setGeometryKiPerpU(){ setGeometryKiOrientationCondition("perpU"); }
function setGeometryKiPerpV(){ setGeometryKiOrientationCondition("perpV"); }
function setGeometryKiParallelU(){ setGeometryKiOrientationCondition("parallelU"); }
function setGeometryKiParallelV(){ setGeometryKiOrientationCondition("parallelV"); }
function setGeometryTargetFromBragg(){ setGeometryTargetHKL([num("refh"),num("refk"),num("refl")]); }

// Keep the Angle calculation & TAS geometry target synchronized with the
// selected Sample orientation reference.  This intentionally reuses the exact
// same functions as the visible quick-target buttons, so changing the
// orientation reference is equivalent to clicking the corresponding
// Set ki ⟂ U/V, Set ki ∥ U/V, or Set Bragg peak button.
function syncGeometryTargetToOrientationReference(){
  const mode=$('orientationReference')?.value || 'perpU';
  if(mode==='perpU') return setGeometryKiPerpU();
  if(mode==='perpV') return setGeometryKiPerpV();
  if(mode==='parallelU') return setGeometryKiParallelU();
  if(mode==='parallelV') return setGeometryKiParallelV();
  if(mode==='bragg') return setGeometryTargetFromBragg();
}
function setGeometryTargetFromDarkRef(slot){
  const ids=darkAssetIds(slot);
  setGeometryTargetHKL([num(ids.refH),num(ids.refK),num(ids.refL)]);
}

function syncGeometryHWSlider(cache){
  const slider=$("geomHWSlider"), output=$("geomHWValue"), entry=$("geomHW");
  if(!slider || !output || !entry || !cache?.hwList?.length) return;
  const lo=Math.min(...cache.hwList), hi=Math.max(...cache.hwList);
  const diffs=cache.hwList.slice(1).map((x,i)=>Math.abs(x-cache.hwList[i])).filter(x=>x>1e-9);
  const step=diffs.length ? Math.min(...diffs) : 0.1;
  slider.min=lo; slider.max=hi; slider.step=step;
  const v=Math.max(lo,Math.min(hi,Number(entry.value)||0));
  slider.value=v;
  output.textContent=`${Number(entry.value||0).toFixed(1)} meV`;
}


function ensureNuclearLabelControl(){
  if($("displayNuclearLabels")) return;
  const plot=$("singlePlot");
  const sliderRow=$("hwSlider")?.closest(".energy-slider-row");
  if(!plot || !sliderRow) return;
  const row=document.createElement("div");
  row.className="nuclear-label-control";
  row.innerHTML='<label class="checkbox-label"><input id="displayNuclearLabels" type="checkbox" checked><span>Display labels of nuclear Bragg peaks</span></label>';
  sliderRow.parentNode.insertBefore(row,sliderRow);
}

function ensureQESliderControls(){
  if(!$('hwEntry')){
    const row=$('hwSlider')?.closest('.energy-slider-row');
    if(row){
      const parent=row.parentNode;
      const grid=document.createElement('div');
      grid.id='qeRangeControlGrid';
      grid.className='qe-range-control-grid';

      const hwCard=document.createElement('div');
      hwCard.className='qe-range-control';
      hwCard.innerHTML='<div id="qeSpurionWarning" class="qe-spurion-warning" aria-live="polite"></div><label class="qe-control-entry">ħω (meV)<input id="hwEntry" type="number" step="0.1" value="0.0"></label>';
      hwCard.appendChild($('hwSlider'));
      const hwOut=$('hwValue'); if(hwOut) hwOut.classList.add('hidden');

      const s2Card=document.createElement('div');
      s2Card.className='qe-range-control';
      s2Card.innerHTML='<label class="qe-control-entry">S2 (deg)<input id="s2Entry" type="number" step="0.1" value="0.0"></label><input id="s2Slider" type="range" min="0" max="180" step="0.1" value="0">';

      const sfCard=document.createElement('div');
      sfCard.id='sfColorMaxRow';
      sfCard.className='qe-range-control sf-control hidden';
      sfCard.innerHTML='<label class="qe-control-entry">Threshold (% of max)<input id="sfThresholdEntry" type="number" min="0" max="100" step="0.1" value="0.0"></label><label class="qe-control-entry">Colorbar scale<input id="sfColorMaxEntry" type="number" min="0.01" max="1" step="0.01" value="1.00"></label><input id="sfColorMaxSlider" type="range" min="0.01" max="1" step="0.01" value="1"><output id="sfColorMaxValue" class="hidden">1.00</output>';

      grid.append(hwCard,s2Card,sfCard);
      parent.insertBefore(grid,row);
      row.remove();
    }
  }
}
function nearestHWIndex(cache,value){
  let best=0, d=Infinity; cache.hwList.forEach((x,i)=>{const di=Math.abs(x-value); if(di<d){d=di;best=i;}}); return best;
}
function syncSingleNavigation(cache,index){
  const i=Math.max(0,Math.min(index,cache.hwList.length-1));
  if($('hwSlider')) $('hwSlider').value=i;
  if($('hwEntry')) $('hwEntry').value=cache.hwList[i].toFixed(1);
  if($('hwValue')) $('hwValue').textContent=`${cache.hwList[i].toFixed(1)} meV`;
  const lo=0, hi=180;
  const slider=$('s2Slider'), entry=$('s2Entry');
  if(slider){ slider.min=lo; slider.max=hi; slider.step=0.1; }
  let v=Number(entry?.value); if(!Number.isFinite(v)) v=Math.max(0,num('S2min')); v=Math.max(lo,Math.min(hi,v));
  if(slider) slider.value=v; if(entry) entry.value=v.toFixed(1); if($('s2Value')) $('s2Value').textContent=`${v.toFixed(1)}°`;
  return v;
}
function selectedQAtS2(cache,index,s2){
  const hw=cache.hwList[index]; let Ei,Ef;
  if(cache.energyMode==='Ef fixed'){Ef=cache.Ef;Ei=Ef+hw;} else {Ei=cache.Ei;Ef=Ei-hw;}
  if(!(Ei>0&&Ef>0)) return NaN;
  const ki=0.6947*Math.sqrt(Ei), kf=0.6947*Math.sqrt(Ef);
  return Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(deg2rad(s2))));
}
function recalculate(){
  clearError();
  updateEnergyLabel();
  updateS2MaxDisplay();
  updateModeVisibility();
  try{
    if(checkedValue("sampleMode")==="single"){
      singleCache=calculateSingleCrystal();
      syncGeometryHWSlider(singleCache);
      $("hwSlider").min=0;
      $("hwSlider").max=Math.max(0,singleCache.regions.length-1);
      $("hwSlider").step=1;
      const idx=Math.min(Number($("hwSlider").value)||0,singleCache.regions.length-1);
      $("hwSlider").value=idx;
      renderSingle(singleCache,idx);
    } else {
      calculatePowder();
      updatePowderRelation(powderRelationDriver);
    }
  }catch(err){
    showError(err);
  }
}

$("instrument").addEventListener("change",()=>{
  applyInstrumentDefaults();
  scheduleRecalc();
});

bindDynamicSidebarUI();


$("hwSlider").addEventListener("input",()=>{ if(singleCache) renderSingle(singleCache,Number($("hwSlider").value)); });

$("geomHWSlider").addEventListener("input",()=>{
  const v=Number($("geomHWSlider").value);
  $("geomHW").value=Number.isFinite(v) ? v.toFixed(1) : "0.0";
  $("geomHWValue").textContent=`${Number($("geomHW").value).toFixed(1)} meV`;
  scheduleRecalc();
});

$("geomHW").addEventListener("input",()=>{
  if(singleCache) syncGeometryHWSlider(singleCache);
});

$("geomSetU").addEventListener("click",setGeometryTargetFromU);
$("geomSetV").addEventListener("click",setGeometryTargetFromV);
$("geomPerpU").addEventListener("click",setGeometryKiPerpU);
$("geomPerpV").addEventListener("click",setGeometryKiPerpV);
$("geomParallelU").addEventListener("click",setGeometryKiParallelU);
$("geomParallelV").addEventListener("click",setGeometryKiParallelV);
$("geomSetBragg").addEventListener("click",setGeometryTargetFromBragg);

// Either S2 control may be used as the user's entry point.  Effective is an
// absolute value; convert it to Delta before the normal recalculation handler
// runs.  Editing Delta needs no conversion because Effective is derived from it.
$('S2maxEffective')?.addEventListener('input',syncS2DeltaFromEffective);
$('S2maxEffective')?.addEventListener('change',syncS2DeltaFromEffective);

document.querySelectorAll("input,select").forEach(el=>{
  if([
    "instrument",
    "seSelect","seSelect2","seSelect3",
    ...BACKGROUND_SLOTS.map(slot=>slot.id),
    "hwSlider",
    "geomHWSlider"
  ].includes(el.id)) return;

  el.addEventListener("input",scheduleRecalc);
  el.addEventListener("change",scheduleRecalc);
});


// ==================== Resolution calculator ====================
let scanResults=[];
let scanResolutionPlotLimits=null;
function formatAutoHKL(v){return v.map(x=>{if(Math.abs(x)<1e-10)return '0';const r=Math.round(x);if(Math.abs(x-r)<1e-10)return String(r);return Number(x.toPrecision(6)).toString();}).join(', ');}
function buildResolutionLattice(){
  const lc={...latticeParams(),sv1:[num('Uh'),num('Uk'),num('Ul')],sv2:[num('Vh'),num('Vk'),num('Vl')]};
  const rl=RLRes(lc);
  // Preserve the entered U/V order exactly.  Their order defines the
  // scattering-plane handedness used by W, UB, TAS geometry and resolution.
  lc.sv3=inferOutOfPlaneHKL(rl,lc.sv1,lc.sv2);
  $('Wauto').textContent=`auto: (${formatAutoHKL(lc.sv3)})`;
  return {lc,rl};
}
function updateAutoW(){try{buildResolutionLattice();}catch(_e){if($('Wauto'))$('Wauto').textContent='auto: unavailable';}}
function flipScatteringPlaneUV(){
  const idsU=['Uh','Uk','Ul'], idsV=['Vh','Vk','Vl'];
  const u=idsU.map(id=>$(id).value);
  const v=idsV.map(id=>$(id).value);
  idsU.forEach((id,i)=>{$(id).value=v[i];});
  idsV.forEach((id,i)=>{$(id).value=u[i];});
  updateAutoW();
  scheduleRecalc();
}
function collectResolutionBase(){
  const {lc,rl}=buildResolutionLattice(), em=$('energyMode').value,E=num('energy');
  const config={energy_mode:em,Ei:em==='Ei fixed'?E:null,Ef:em==='Ef fixed'?E:null,geometry:$('geometry').value,sign_config:calculationTasSense($('sense').value)};
  const approximation={method:$('method').value};
  const focusing={monochromator:{horizontal:{enabled:$('monoHF').checked,blades:num('monoHB')},vertical:{enabled:$('monoVF').checked,blades:num('monoVB')}},analyzer:{horizontal:{enabled:$('anaHF').checked,blades:num('anaHB')},vertical:{enabled:$('anaVF').checked,blades:num('anaVB')}}};
  const col={gm_1st:$('gm1').checked,div_1st_m:num('div1m'),div_1st_h:num('div1h'),div_1st_v:num('div1v'),div_2nd_h:num('div2h'),div_2nd_v:num('div2v'),div_3rd_h:num('div3h'),div_3rd_v:num('div3v'),div_4th_h:num('div4h'),div_4th_v:num('div4v')};
  const mos={d_mono:num('dMono'),mos_mono_h:num('mosMonoH'),mos_mono_v:num('mosMonoV'),mos_sam_h:num('mosSamH'),mos_sam_v:num('mosSamV'),d_ana:num('dAna'),mos_ana_h:num('mosAnaH'),mos_ana_v:num('mosAnaV')};
  const geom={L0:num('L0'),L1:num('L1'),L2:num('L2'),L3:num('L3'),beam_width:num('beamW'),beam_height:num('beamH'),mono_width:num('monoW'),mono_height:num('monoH'),mono_thickness:num('monoT'),ana_width:num('anaW'),ana_height:num('anaH'),ana_thickness:num('anaT'),det_width:num('detW'),det_height:num('detH')};
  return {lc,rl,col,mos,config,approximation,focusing,geom,unitMode:$('unit').value};
}
function wrap180(x){
  let y=(Number(x)+180)%360;
  if(y<0) y+=360;
  return y-180;
}

function angleDiffDeg(a,b){
  return wrap180(Number(a)-Number(b));
}

function tasMotorAngles(calc,b){
  const em=b.config.energy_mode;
  let Ei,Ef;
  if(em==='Ei fixed'){
    Ei=Number(b.config.Ei);
    Ef=Ei-Number(calc.hw);
  }else{
    Ef=Number(b.config.Ef);
    Ei=Ef+Number(calc.hw);
  }
  if(!(Ei>0) || !(Ef>0)) throw new Error('Ei and Ef must be positive to calculate TAS angles.');

  const ki=Math.sqrt(Ei/2.072);
  const kf=Math.sqrt(Ef/2.072);

  const braggAngle=(E,d,label)=>{
    const k=Math.sqrt(E/2.072);
    const arg=(2*PI/Number(d))/(2*k);
    if(arg>1+1e-12 || arg<-1-1e-12){
      throw new Error(`${label} Bragg condition is inaccessible at the selected energy.`);
    }
    return rad2deg(Math.asin(clamp(arg,-1,1)));
  };

  let m1abs=braggAngle(Ei,b.mos.d_mono,'Monochromator');
  let a1abs=braggAngle(Ef,b.mos.d_ana,'Analyzer');
  if(b.config.geometry==='anti-W') a1abs=-a1abs;

  let senseM,senseS,senseA;
  if(b.config.sign_config==='+-+'){
    senseM=+1; senseS=-1; senseA=+1;
  }else if(b.config.sign_config==='-+-'){
    senseM=-1; senseS=+1; senseA=-1;
  }else{
    throw new Error(`Unsupported TAS sign configuration: ${b.config.sign_config}`);
  }

  const m1=senseM*m1abs;
  const m2=2*m1;
  const a1=senseA*a1abs;
  const a2=2*a1;

  const target=[Number(calc.h),Number(calc.k),Number(calc.l)];
  const Qt=hklToQ(b.rl,target);
  const QtNorm=norm(Qt);
  if(QtNorm<1e-12) throw new Error('Q = 0 cannot define TAS sample angles.');

  const cosS2=(ki*ki+kf*kf-QtNorm*QtNorm)/(2*ki*kf);
  if(cosS2<-1-1e-10 || cosS2>1+1e-10){
    throw new Error('The requested Q and energy transfer are kinematically inaccessible.');
  }
  const s2=senseS*rad2deg(Math.acos(clamp(cosS2,-1,1)));

  // Reference-Q calibration of S1.
  // The entered Reference Q is observed at refs1 in the elastic condition.
  const U=b.lc.sv1, V=b.lc.sv2;
  const {ex,ey}=makeSpiceScatteringPlaneBasis(b.rl,U,V);
  const qAngle=(q,{allowZeroProjection=false}={})=>{
    const x=dot(q,ex), y=dot(q,ey);
    if(Math.hypot(x,y)<1e-12){
      // Match the Q-E range convention for Reference Q: Reference Q is
      // allowed to lie outside the scattering plane because it is used only
      // to establish the S1 offset.  When its in-plane projection vanishes,
      // use phi_ref = 0 rather than aborting the resolution calculation.
      if(allowZeroProjection) return 0;
      throw new Error('Calculation Q has no in-plane component and cannot define the TAS sample orientation.');
    }
    return rad2deg(Math.atan2(y,x));
  };

  // Reference Q is needed only for the optional S1/S2 angle calibration.
  // A bad Reference Q must never suppress an otherwise valid resolution result.
  const fixedE=em==='Ei fixed' ? Number(b.config.Ei) : Number(b.config.Ef);
  const orientationRef=effectiveOrientationReference(b.rl,fixedE);
  const ref=orientationRef.hkl;
  const Qr=hklToQ(b.rl,ref);
  const QrNorm=norm(Qr);

  if(QrNorm<1e-12){
    return {Ei,Ef,m1,m2,s1:null,s2,a1,a2,
      warning:'Reference Q is zero; S1 is unavailable.'};
  }

  const k0=Math.sqrt(fixedE/2.072);
  const cosRef=(2*k0*k0-QrNorm*QrNorm)/(2*k0*k0);
  if(cosRef<-1-1e-10 || cosRef>1+1e-10){
    return {Ei,Ef,m1,m2,s1:null,s2,a1,a2,
      warning:'Reference Q is outside the measurable range at the selected reference energy; S1 is unavailable.'};
  }
  const s2Ref=senseS*rad2deg(Math.acos(clamp(cosRef,-1,1)));

  // S1 is a physical sample-axis encoder calibration and must not change when
  // the TAS sign configuration is switched.  The validated -+- convention
  // uses the positive scattering branch, so use that same branch for the S1
  // UB/reference calculation in both -+- and +-+.  Only the displayed/physical
  // S2 motor angle above retains senseS.
  const s2ForS1=rad2deg(Math.acos(clamp(cosS2,-1,1)));
  const s2RefForS1=rad2deg(Math.acos(clamp(cosRef,-1,1)));

  // Match the validated Python UB/reference geometry exactly.  In the
  // canonical PDF frame, +z is the incident beam and +x is the in-plane
  // transverse direction.  For a horizontal detector:
  //   Q_lab = (-kf*sin(S2), 0, ki-kf*cos(S2))
  // and the physical sample rotation is
  //   omega = atan2(Qlab_x,Qlab_z) - atan2(Q0_x,Q0_z).
  // Reference Q determines omega_ref only; the encoder offset is then
  // transferred to the target by S1 = S1_ref + (omega_target-omega_ref).
  // makeSpiceScatteringPlaneBasis gives ex along entered U and ey along the
  // entered-V side of the in-plane transverse direction.  These correspond to PDF z and
  // PDF x respectively, so atan2(ey,ex) is atan2(Q0_x,Q0_z).
  const phiTarget=qAngle(Qt);
  const phiRef=qAngle(Qr,{allowZeroProjection:true});
  const omegaTarget=wrap180(tasPhiLabDeg(ki,kf,s2ForS1)-phiTarget);
  const omegaRef=wrap180(tasPhiLabDeg(k0,k0,s2RefForS1)-phiRef);

  // The validated Python simulation uses C2_TO_OMEGA_SIGN = +1 for its
  // native scattering sense.  The opposite TAS sign configuration is the
  // left/right-mirrored instrument, so its sample encoder must run with the
  // opposite C2->omega sign.  Without this factor +-+ and -+- collapse onto
  // the same S1 solution after the signed-S2 geometry is formed.
  //
  //   omega = omega_ref + c2Sign * (S1-S1_ref)
  //   S1    = S1_ref + (omega-omega_ref)/c2Sign
  //
  // Keep +-+ as the already validated result and mirror only -+-.
  const c2Sign=(b.config.sign_config==='+-+') ? +1 : -1;
  const s1=orientationRef.s1 + angleDiffDeg(omegaTarget,omegaRef)/c2Sign;

  return {Ei,Ef,m1,m2,s1,s2,a1,a2,warning:''};
}

function calcOne(calc){
  const b=collectResolutionBase();

  // Resolution sense convention:
  // The resolution core already defines the physical +-+ / -+- branches.
  // Pass the user-facing selection directly here.  Keep b.config unchanged,
  // because Angle calculation / TAS geometry and Q-E calculations retain the
  // previously validated internal sense mapping via calculationTasSense().
  const resolutionConfig={...b.config,sign_config:checkedValue('sense')};
  const result=calcResolution(b.lc,b.rl,b.col,b.mos,resolutionConfig,b.approximation,b.focusing,b.geom,calc,b.unitMode);
  let angles;
  try{
    angles=tasMotorAngles(calc,b);
  }catch(err){
    // Angle calculation is supplemental.  Do not hide a valid resolution
    // result just because motor angles cannot be determined.
    angles={m1:null,m2:null,s1:null,s2:null,a1:null,a2:null,
      warning:`Angle calculation unavailable: ${err?.message || String(err)}`};
  }
  return {calc,...b,result,angles};
}
function matrixText(M){return M.map(r=>'[ '+r.map(x=>Number(x).toExponential(6).padStart(14)).join('  ')+' ]').join('\n');}
function traceEllipse(p,name,dash='solid'){return{x:p.x,y:p.y,mode:'lines',name,line:{dash},hoverinfo:'skip'};}

// Resolution plots use explicit symmetric limits around the calculation point.
// A single Calc always resets to the current ellipse size so the ellipse cannot
// remain clipped by a viewport left over from an earlier calculation.  A Scan
// supplies limits precomputed over every scan point; those same limits are then
// reused for every slider position so the apparent ellipse evolution is not
// contaminated by changing plot scales.
function baseLayout(title,xlabel,ylabel,xlim,ylim,equal=false,plotId=null){
  const safe=(v,fallback=1)=>Number.isFinite(Number(v))&&Number(v)>0?Number(v):fallback;
  const xl=safe(xlim), yl=safe(ylim);
  return {
    uirevision:plotId||'resolutionPlots',
    title:{text:title,font:{size:14}},
    margin:{l:60,r:20,t:45,b:55},
    xaxis:{title:xlabel,range:[-xl,xl],zeroline:true,showgrid:true},
    yaxis:{title:ylabel,range:[-yl,yl],zeroline:true,showgrid:true,...(equal?{scaleanchor:'x',scaleratio:1}:{})},
    showlegend:false
  };
}

function resolutionPlotLimitsFromEntries(entries){
  const valid=Array.isArray(entries)?entries.filter(Boolean):[];
  if(!valid.length) return null;
  const maxLim=key=>{
    let m=0;
    for(const entry of valid){
      const v=Number(entry?.result?.lim?.[key]);
      if(Number.isFinite(v) && v>m) m=v;
    }
    return m>0?m:null;
  };
  const U=maxLim('U'), V=maxLim('V'), W=maxLim('W'), E=maxLim('E');
  return {U,V,W,E};
}
function formatAngle(value,absolute=false){
  if(value===null || value===undefined || !Number.isFinite(Number(value))) return '';
  const v=absolute ? Math.abs(Number(value)) : Number(value);
  return v.toFixed(3);
}

function renderResolution(entry,indexInfo='',plotLimits=null){
  const {result:r,calc,unitMode,lc,angles}=entry;
  const limits=plotLimits || r.lim;
  const qUnit=unitMode==='rlu'?'r.l.u.':'Å⁻¹';
  const ax=r.displayAxes || {U:lc.sv1,V:lc.sv2,W:lc.sv3};
  const fmtAxis=v=>`(${v.map(x=>{
    const y=Number(x);
    return Math.abs(y-Math.round(y))<1e-10 ? String(Math.round(y)) : Number(y.toPrecision(6)).toString();
  }).join(', ')})`;

  $('result').classList.remove('hidden');

  // Display-only S2 sign convention for Angle calculation.
  // Do not modify angles.s2 itself: the internal signed S2 is used by TAS
  // geometry/calibration logic.  User-facing convention is:
  //   +-+ -> negative S2
  //   -+- -> positive S2
  const uiSense=checkedValue("sense");
  const s2Display=Number.isFinite(Number(angles.s2))
    ? (uiSense==="+-+" ? -Math.abs(Number(angles.s2)) : +Math.abs(Number(angles.s2)))
    : angles.s2;

  $('summary').innerHTML=
    `<div><b>Calculation point</b> ℏω=${calc.hw.toFixed(3)} meV, `+
    `h=${calc.h.toFixed(3)}, k=${calc.k.toFixed(3)}, l=${calc.l.toFixed(3)} ${indexInfo}</div>`+
    `<div><b>Resolution</b> δQ//${fmtAxis(ax.U)}=${r.display.U.toFixed(4)} (${r.display.Ucoh.toFixed(4)}) ${qUnit}, `+
    `δQ//${fmtAxis(ax.V)}=${r.display.V.toFixed(4)} (${r.display.Vcoh.toFixed(4)}) ${qUnit}, `+
    `δQ//${fmtAxis(ax.W)}=${r.display.W.toFixed(4)} (${r.display.Wcoh.toFixed(4)}) ${qUnit}, `+
    `δℏω=${r.display.E.toFixed(4)} (${r.display.Ecoh.toFixed(4)}) meV</div>`+
    `<div><b>Resolution axes</b> U=${fmtAxis(ax.U)}, V=${fmtAxis(ax.V)}, W=${fmtAxis(ax.W)}</div>`+
    `<div><b>Angles (deg)</b> M1=${formatAngle(angles.m1)}, M2=${formatAngle(angles.m2)}, `+
    `S1=${formatAngle(angles.s1)}, S2=${formatAngle(s2Display)}, `+
    `A1=${formatAngle(angles.a1)}, A2=${formatAngle(angles.a2)}`+
    `${angles.warning ? ` &nbsp;⚠ ${angles.warning}` : ''}</div>`;

  // RM is the original TAS local matrix (Q_parallel,Q_perp,E,Q_out).
  // RM_U is the same matrix rotated to the U-based orthogonal frame.
  // In this display V denotes the automatically orthogonalized in-plane V.
  const matrixHeader=$('matrix').previousElementSibling;
  if(matrixHeader) matrixHeader.textContent='Resolution matrices';
  $('matrix').textContent=
    `Local matrix order (Q∥, Q⊥, E, Qout)\n${matrixText(r.RM)}\n\n`+
    `U-based matrix order (U, V, E, W)\n${matrixText(r.RM_U)}`;

  Plotly.react(
    'plotUE',
    [traceEllipse(r.ellipses.projUE,'projection'),traceEllipse(r.ellipses.sliceUE,'slice','dash')],
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.U)} (${qUnit})`,'δℏω (meV)',limits.U,limits.E,false,'plotUE'),
    {responsive:true}
  );

  Plotly.react(
    'plotVE',
    [traceEllipse(r.ellipses.projVE,'projection'),traceEllipse(r.ellipses.sliceVE,'slice','dash')],
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.V)} (${qUnit})`,'δℏω (meV)',limits.V,limits.E,false,'plotVE'),
    {responsive:true}
  );

  Plotly.react(
    'plotWE',
    [traceEllipse(r.ellipses.projWE,'projection'),traceEllipse(r.ellipses.sliceWE,'slice','dash')],
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.W)} (${qUnit})`,'δℏω (meV)',limits.W,limits.E,false,'plotWE'),
    {responsive:true}
  );

  // Scattering-plane display scaling:
  // - r.l.u.: U and V are different reciprocal-lattice coordinates, so give
  //   each axis its own resolution range and do not force a 1:1 plot aspect.
  // - Å^-1: both axes are physical reciprocal-space lengths, so keep a common
  //   range and a 1:1 aspect ratio.
  const uvEqual=(unitMode!=='rlu');
  const uLim=uvEqual ? Math.max(limits.U,limits.V) : limits.U;
  const vLim=uvEqual ? uLim : limits.V;
  const uline={x:[-uLim,uLim],y:[0,0],mode:'lines',line:{width:1},hoverinfo:'skip'};
  const vline={x:[0,0],y:[-vLim,vLim],mode:'lines',line:{width:1},hoverinfo:'skip'};

  Plotly.react(
    'plotUV',
    [traceEllipse(r.ellipses.projUV,'projection'),traceEllipse(r.ellipses.sliceUV,'slice','dash'),uline,vline],
    baseLayout(
      'Scattering-plane resolution ellipse',
      `δQ ∥ ${fmtAxis(ax.U)} (${qUnit})`,
      `δQ ∥ ${fmtAxis(ax.V)} (${qUnit})`,
      uLim,vLim,uvEqual,'plotUV'
    ),
    {responsive:true}
  );
}
function doSingleResolution(){
  clearError();
  try{
    const e=calcOne({hw:num('hw'),h:num('h'),k:num('k'),l:num('l')});
    scanResolutionPlotLimits=null;
    $('scanNav').classList.add('hidden');
    // Single-point Calc: always fit to this calculation's resolution ellipse.
    renderResolution(e,'',e.result.lim);
  }catch(e){showError(e);}
}
function doScanResolution(){
  clearError();
  try{
    const n=Math.max(2,Math.round(num('npts'))),xs=(a,b)=>linspace(a,b,n),hs=xs(num('h0'),num('h1')),ks=xs(num('k0'),num('k1')),ls=xs(num('l0'),num('l1')),ws=xs(num('hw0'),num('hw1'));
    scanResults=Array.from({length:n},(_,i)=>calcOne({hw:ws[i],h:hs[i],k:ks[i],l:ls[i]}));
    // Use the largest required extent across the complete scan.  This is
    // especially important for constant-E Q scans, where the ellipse shape can
    // change strongly with Q; the slider must not rescale the plot underneath it.
    scanResolutionPlotLimits=resolutionPlotLimitsFromEntries(scanResults);
    $('scanSlider').min=1;
    $('scanSlider').max=n;
    $('scanSlider').value=1;
    $('scanNav').classList.remove('hidden');
    renderResolutionScan(1);
  }catch(e){
    scanResolutionPlotLimits=null;
    showError(e);
  }
}
function renderResolutionScan(i){
  i=Math.max(1,Math.min(scanResults.length,Number(i)));
  $('scanSlider').value=i;
  $('scanIndex').textContent=`${i} / ${scanResults.length}`;
  renderResolution(scanResults[i-1],`| scan ${i}/${scanResults.length}`,scanResolutionPlotLimits || scanResults[i-1].result.lim);
}


// Display-only terminology: magnetic propagation vectors are k1, k2, ...
function updatePropagationVectorLabels(){
  const symbols=["●","×","★","◆","+","▲","■","◇","▼","⬟"];
  for(const i of propagationVectorIndices()){
    const enable=$(`q_enable${i}`);
    const row=enable?.closest('.propagation-row');
    if(!row) continue;
    const span=enable.closest('label')?.querySelector('span');
    if(span) span.textContent=`k${i} (${symbols[(i-1)%symbols.length]})`;
    const labels=[...row.querySelectorAll('label')].filter(x=>x!==enable.closest('label'));
    ['h','k','l'].forEach((c,j)=>{
      if(labels[j] && labels[j].firstChild) labels[j].firstChild.nodeValue=`k${i}_${c}`;
    });
  }
}

// ==================== Toolbox: neutron unit conversion ====================
const NEUTRON_E_LAMBDA=81.8042;       // E[meV] = 81.8042 / lambda[Å]^2
const MEV_PER_THz=4.135667696;        // E[meV] = h * f[THz]
const K_PER_MEV=11.60451812;          // equivalent temperature E/kB
const CM1_PER_MEV=8.065543937;        // spectroscopic wavenumber
const NEUTRON_V_LAMBDA=3956.034;      // v[m/s] = 3956.034 / lambda[Å]
const J_PER_MEV=1.602176634e-22;      // exact SI conversion
const J_PER_CAL=4.184;                // thermochemical calorie
const C_LIGHT=299792458;              // m/s
const MEV_PER_TESLA=5.78838e-2;       // user convention: 1 T = 5.78838e-5 eV = 0.0578838 meV
let toolboxUpdating=false;

function ensureExtendedToolboxUI(){
  const grid=document.querySelector('#toolboxPanel .toolbox-grid');
  if(!grid) return;
  const fields=[
    ['toolMass','Mass equivalent (kg)','any'],
    ['toolField','Magnetic field (T)','any'],
    ['toolJ','Energy (J)','any'],
    ['toolCal','Heat (cal)','any']
  ];
  for(const [id,labelText] of fields){
    if($(id)) continue;
    const label=document.createElement('label');
    label.append(document.createTextNode(labelText));
    const input=document.createElement('input');
    input.id=id; input.type='number'; input.step='any'; input.min='0';
    label.appendChild(input); grid.appendChild(label);
  }
  // Keep all 11 entry boxes on one row on a wide screen; allow horizontal scrolling
  // instead of squeezing the fields until they become unusable on a narrow screen.
  if(!document.getElementById('toolboxExtendedStyle')){
    const style=document.createElement('style'); style.id='toolboxExtendedStyle';
    style.textContent=`#toolboxPanel .toolbox-grid{grid-template-columns:repeat(11,minmax(105px,1fr))!important;overflow-x:auto;align-items:end} #toolboxPanel .toolbox-grid label{min-width:105px}`;
    document.head.appendChild(style);
  }
  // Extend the wavelength-multiple table with the same four quantities.
  const table=document.querySelector('#toolboxPanel .harmonic-table');
  if(table && !document.getElementById('harmBaseMass')){
    const old=[...table.children];
    const oldCols=8; // row label + 7 original quantities
    const prefixes=['harmThird','harmHalf','harmBase','harmDouble','harmTriple'];
    const extraHeaders=['Mass equivalent (kg)','Magnetic field (T)','Energy (J)','Heat (cal)'];
    const suffixes=['Mass','Field','J','Cal'];
    const frag=document.createDocumentFragment();
    for(let row=0;row<6;row++){
      for(let col=0;col<oldCols;col++) frag.appendChild(old[row*oldCols+col]);
      if(row===0){
        for(const text of extraHeaders){ const d=document.createElement('div'); d.textContent=text; frag.appendChild(d); }
      }else{
        const prefix=prefixes[row-1];
        for(const suffix of suffixes){ const out=document.createElement('output'); out.id=`${prefix}${suffix}`; frag.appendChild(out); }
      }
    }
    table.replaceChildren(frag);
    table.style.gridTemplateColumns='max-content repeat(11,minmax(105px,1fr))';
    table.style.minWidth='1450px';
  }
  const note=document.querySelector('#toolboxPanel .tool-note');
  if(note) note.textContent='Editing any one of λ, E, k, THz, K, cm⁻¹, velocity, mass equivalent, magnetic field, J, or cal updates all other values and the wavelength-multiple table.';
}

function toolboxValues(lambda){
  const E=NEUTRON_E_LAMBDA/(lambda*lambda);
  const joule=E*J_PER_MEV;
  return {
    lambda,E,k:2*Math.PI/lambda,thz:E/MEV_PER_THz,temp:E*K_PER_MEV,
    cm:E*CM1_PER_MEV,velocity:NEUTRON_V_LAMBDA/lambda,
    mass:joule/(C_LIGHT*C_LIGHT),field:E/MEV_PER_TESLA,joule,cal:joule/J_PER_CAL
  };
}
function setToolboxFrom(kind){
  if(toolboxUpdating) return;
  toolboxUpdating=true;
  try{
    let lambda;
    const value=Number($(kind).value);
    if(!Number.isFinite(value) || value<=0) return;
    if(kind==='toolLambda') lambda=value;
    else if(kind==='toolEnergy') lambda=Math.sqrt(NEUTRON_E_LAMBDA/value);
    else if(kind==='toolK') lambda=2*Math.PI/value;
    else if(kind==='toolTHz') lambda=Math.sqrt(NEUTRON_E_LAMBDA/(value*MEV_PER_THz));
    else if(kind==='toolTemp') lambda=Math.sqrt(NEUTRON_E_LAMBDA/(value/K_PER_MEV));
    else if(kind==='toolCm') lambda=Math.sqrt(NEUTRON_E_LAMBDA/(value/CM1_PER_MEV));
    else if(kind==='toolVelocity') lambda=NEUTRON_V_LAMBDA/value;
    else if(kind==='toolMass') lambda=Math.sqrt(NEUTRON_E_LAMBDA/((value*C_LIGHT*C_LIGHT)/J_PER_MEV));
    else if(kind==='toolField') lambda=Math.sqrt(NEUTRON_E_LAMBDA/(value*MEV_PER_TESLA));
    else if(kind==='toolJ') lambda=Math.sqrt(NEUTRON_E_LAMBDA/(value/J_PER_MEV));
    else if(kind==='toolCal') lambda=Math.sqrt(NEUTRON_E_LAMBDA/((value*J_PER_CAL)/J_PER_MEV));
    const v=toolboxValues(lambda);
    const formatted={
      toolLambda:v.lambda.toFixed(6), toolEnergy:v.E.toFixed(6), toolK:v.k.toFixed(6),
      toolTHz:v.thz.toFixed(6), toolTemp:v.temp.toFixed(6), toolCm:v.cm.toFixed(6),
      toolVelocity:v.velocity.toFixed(3), toolMass:v.mass.toExponential(6),
      toolField:v.field.toExponential(6), toolJ:v.joule.toExponential(6), toolCal:v.cal.toExponential(6)
    };
    for(const [id,text] of Object.entries(formatted)){ if(id!==kind && $(id)) $(id).value=text; }
    for(const [factor,prefix] of [[1/3,'harmThird'],[1/2,'harmHalf'],[1,'harmBase'],[2,'harmDouble'],[3,'harmTriple']]){
      const x=toolboxValues(lambda*factor);
      $(`${prefix}Lambda`).textContent=x.lambda.toFixed(6);
      $(`${prefix}Energy`).textContent=x.E.toFixed(6);
      $(`${prefix}K`).textContent=x.k.toFixed(6);
      $(`${prefix}THz`).textContent=x.thz.toFixed(6);
      $(`${prefix}Temp`).textContent=x.temp.toFixed(3);
      $(`${prefix}Cm`).textContent=x.cm.toFixed(3);
      $(`${prefix}Velocity`).textContent=x.velocity.toFixed(1);
      $(`${prefix}Mass`).textContent=x.mass.toExponential(6);
      $(`${prefix}Field`).textContent=x.field.toExponential(6);
      $(`${prefix}J`).textContent=x.joule.toExponential(6);
      $(`${prefix}Cal`).textContent=x.cal.toExponential(6);
    }
  }finally{ toolboxUpdating=false; }
}

// ==================== Powder Q / hw / 2theta helper ====================
let powderRelationDriver='powderTwoTheta';
function powderWavevectors(hw){
  const E=num('energy');
  const mode=checkedValue('energyMode');
  const Ei=mode==='Ef fixed' ? E+hw : E;
  const Ef=mode==='Ef fixed' ? E : E-hw;
  if(!(Ei>0) || !(Ef>0)) return null;
  return {ki:Math.sqrt(Ei/2.072),kf:Math.sqrt(Ef/2.072)};
}
function updatePowderRelation(driver=powderRelationDriver){
  if(!$('powderQ') || !$('powderHW') || !$('powderTwoTheta')) return;
  powderRelationDriver=driver;
  const hw=Number($('powderHW').value);
  if(!Number.isFinite(hw)) return;
  const wv=powderWavevectors(hw);
  const note=$('powderRelationNote');
  if(!wv){ note.textContent='This ħω is outside the positive Ei/Ef range.'; return; }
  const {ki,kf}=wv;
  if(driver==='powderQ'){
    const q=Number($('powderQ').value);
    if(!Number.isFinite(q) || q<0) return;
    const c=(ki*ki+kf*kf-q*q)/(2*ki*kf);
    if(c < -1-1e-10 || c > 1+1e-10){ note.textContent='The entered Q is not accessible at this ħω.'; return; }
    $('powderTwoTheta').value=rad2deg(Math.acos(clamp(c,-1,1))).toFixed(4);
  }else{
    const tt=Number($('powderTwoTheta').value);
    if(!Number.isFinite(tt)) return;
    const t=deg2rad(tt);
    const q=Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(t)));
    $('powderQ').value=q.toFixed(6);
  }
  note.textContent=`Ei=${(ki*ki*2.072).toFixed(4)} meV, Ef=${(kf*kf*2.072).toFixed(4)} meV`;
}

function resizeVisiblePlots(){
  if(typeof Plotly === "undefined" || !Plotly.Plots) return;
  const panel = [$("qePanel"),$("resolutionPanel"),$("toolboxPanel"),$("cifGeneratorPanel")].find(p=>p && !p.classList.contains("hidden"));
  if(!panel) return;
  panel.querySelectorAll(".js-plotly-plot").forEach(el=>{
    try{ Plotly.Plots.resize(el); }catch(_err){}
  });
}

function setActiveTab(name){
  const isQE=name==='qe', isResolution=name==='resolution', isToolbox=name==='toolbox', isCifGenerator=name==='cif-generator';
  const sampleMode=$('sampleMode');
  if(isResolution){
    if(sampleMode.value!=="single"){
      sampleMode.value="single";
      updateModeVisibility();
      scheduleRecalc();
    }
    sampleMode.disabled=true;
    try{ buildResolutionLattice(true); }catch(_err){}
  }else{
    sampleMode.disabled=false;
  }
  $('qePanel').classList.toggle('hidden',!isQE);
  $('resolutionPanel').classList.toggle('hidden',!isResolution);
  $('toolboxPanel').classList.toggle('hidden',!isToolbox);
  $('cifGeneratorPanel').classList.toggle('hidden',!isCifGenerator);
  for(const [id,on] of [['tabQe',isQE],['tabResolution',isResolution],['tabToolbox',isToolbox],['tabCifGenerator',isCifGenerator]]){
    $(id).classList.toggle('active',on);
    $(id).setAttribute('aria-selected',String(on));
  }
  try{ localStorage.setItem(ACTIVE_TAB_STORAGE_KEY,name); }catch(_e){}
  requestAnimationFrame(()=>requestAnimationFrame(resizeVisiblePlots));
}
function updateCalcMode(){const scan=$('calcMode').value==='scan';$('singleInputs').classList.toggle('hidden',scan);$('scanInputs').classList.toggle('hidden',!scan);}

// ==================== App chrome + right-panel persistence ====================
const RIGHT_PANEL_STORAGE_KEY='tas-simulator-right-panel-v1';
const ACTIVE_TAB_STORAGE_KEY='tas-simulator-active-tab-v1';
let restoringRightPanel=false;

function setupAppHeader(){
  document.title='TAS Simulator';
  const header=document.querySelector('header');
  const h1=header?.querySelector('h1');
  if(h1) h1.textContent='TAS Simulator';
  if(!header || document.getElementById('githubLink')) return;

  // Project repository: fixed URL so the GitHub link works identically on
  // localhost, GitHub Pages, and custom-domain deployments.
  const repoUrl='https://github.com/Hodaka-Kikuchi/TAS_Simulator';

  const a=document.createElement('a');
  a.id='githubLink';
  a.href=repoUrl;
  a.target='_blank';
  a.rel='noopener noreferrer';
  a.textContent='GitHub';
  a.title='Open this project on GitHub';
  Object.assign(a.style,{marginLeft:'auto',whiteSpace:'nowrap',fontWeight:'600'});
  header.appendChild(a);
  // Keep the link at the far right without requiring a styles.css change.
  header.style.display='flex';
  header.style.alignItems='center';
  header.style.gap='14px';
  const status=header.querySelector('#status');
  if(status) status.style.marginLeft='auto';
  a.style.marginLeft='0';
}

function rightPanelControls(){
  return [...document.querySelectorAll('#qePanel input[id], #qePanel select[id], #resolutionPanel input[id], #resolutionPanel select[id], #toolboxPanel input[id], #toolboxPanel select[id]')]
    .filter(el=>el.type!=='button' && el.type!=='submit');
}

function saveRightPanelState(){
  if(restoringRightPanel) return;
  try{
    const values={};
    for(const el of rightPanelControls()){
      values[el.id]=(el.type==='checkbox'||el.type==='radio') ? !!el.checked : el.value;
    }
    localStorage.setItem(RIGHT_PANEL_STORAGE_KEY,JSON.stringify({version:1,values}));
  }catch(_e){ /* localStorage may be unavailable in a restricted browser context. */ }
}

function restoreRightPanelState(){
  let saved;
  try{saved=JSON.parse(localStorage.getItem(RIGHT_PANEL_STORAGE_KEY)||'null');}catch(_e){return false;}
  if(!saved || !saved.values || typeof saved.values!=='object') return false;
  restoringRightPanel=true;
  try{
    for(const el of rightPanelControls()){
      const value=saved.values[el.id];
      if(value===undefined) continue;
      if(el.type==='checkbox'||el.type==='radio') el.checked=!!value;
      else if(el.tagName==='SELECT'){
        if([...el.options].some(o=>o.value===String(value))) el.value=String(value);
      }else el.value=String(value);
    }
    updateCalcMode();
    return true;
  }finally{restoringRightPanel=false;}
}

function savedActiveTab(){
  try{
    const name=localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    return ['qe','resolution','toolbox','cif-generator'].includes(name) ? name : 'qe';
  }catch(_e){ return 'qe'; }
}

function enableRightPanelPersistence(){
  for(const panelId of ['qePanel','resolutionPanel','toolboxPanel']){
    const panel=$(panelId); if(!panel) continue;
    panel.addEventListener('input',saveRightPanelState);
    panel.addEventListener('change',saveRightPanelState);
  }
}

setupAppHeader();

// ==================== Local left-panel persistence ====================
// Instrument/sample JSON files are the source of available choices and defaults.
// Restore the user's browser-local values only AFTER those JSON files have loaded,
// so saved values never race with or get overwritten by configuration loading.
const LEFT_PANEL_STORAGE_KEY='tas-qe-left-panel-v1';
let restoringLeftPanel=false;

function leftPanelControls(){
  return [...document.querySelectorAll('.sidebar input[id], .sidebar select[id]')].filter(el=>el.type!=='file');
}

function resolutionInstrumentDetailControls(){
  return [...document.querySelectorAll('#resolutionInstrumentDetails input[id], #resolutionInstrumentDetails select[id]')]
    .filter(el=>el.type!=='file');
}

function saveLeftPanelState(){
  if(restoringLeftPanel) return;
  try{
    const values={};
    for(const el of leftPanelControls()){
      values[el.id]=(el.type==='checkbox'||el.type==='radio') ? !!el.checked : el.value;
    }
    localStorage.setItem(LEFT_PANEL_STORAGE_KEY,JSON.stringify({version:1,values}));
  }catch(_e){ /* localStorage may be unavailable in a restricted browser context. */ }
}

function setSavedControl(id,value,{dispatchChange=false}={}){
  const el=$(id); if(!el || value===undefined) return false;
  if(el.type==='checkbox'||el.type==='radio') el.checked=!!value;
  else if(el.tagName==='SELECT'){
    if(![...el.options].some(o=>o.value===String(value))) return false;
    el.value=String(value);
  }else el.value=String(value);
  if(dispatchChange) el.dispatchEvent(new Event('change'));
  return true;
}

function restoreLeftPanelState(){
  let saved;
  try{saved=JSON.parse(localStorage.getItem(LEFT_PANEL_STORAGE_KEY)||'null');}catch(_e){return false;}
  if(!saved || !saved.values || typeof saved.values!=='object') return false;
  const v=saved.values;
  restoringLeftPanel=true;
  try{
    // 1) The instrument must exist before its dependent defaults can be applied.
    if(setSavedControl('instrument',v.instrument)) applyInstrumentDefaults();

    // Recreate the dynamic Propagation/Dark UI before restoring individual
    // controls.  For legacy fixed-3/fixed-4 saves, only actually used extra
    // slots/ranges are expanded.
    const nonzero=x=>Number.isFinite(Number(x)) && Math.abs(Number(x))>1e-12;
    let propagationCount=Number(v.propagationCount);
    if(!(propagationCount>=1)){
      propagationCount=1;
      for(let i=2;i<=3;i++){
        if(v[`q_enable${i}`] || ["h","k","l"].some(c=>nonzero(v[`q${i}_${c}`]))) propagationCount=i;
      }
    }
    setPropagationVectorCount(propagationCount);

    let backgroundCount=Number(v.backgroundCount);
    if(!(backgroundCount>=1)){
      backgroundCount=1;
      for(let i=2;i<=BACKGROUND_SLOTS.length;i++) if(v[`backgroundSelect${i}`]) backgroundCount=i;
    }
    setBackgroundCount(backgroundCount);

    let darkCount=Number(v.darkAssetCount);
    if(!(darkCount>=1)){
      darkCount=1;
      for(let slot=2;slot<=3;slot++){
        const ids=darkAssetIds(slot);
        const used=!!v[ids.enable] || !!v[ids.se] || (v[ids.ref] && v[ids.ref]!=="Reference Q") ||
          nonzero(v[ids.rotation]) || (v[ids.refH]!==undefined && Math.abs(Number(v[ids.refH])-1)>1e-12) || nonzero(v[ids.refK]) || nonzero(v[ids.refL]) ||
          [0,1,2,3].some(i=>nonzero(v[ids.from(i)])||nonzero(v[ids.to(i)])||nonzero(v[ids.offset(i)]));
        if(used) darkCount=slot;
      }
    }
    setDarkAssetCount(darkCount);
    for(const slot of darkAssetSlots()){
      const ids=darkAssetIds(slot);
      let rangeCount=Number(v[ids.rangeCount]);
      if(!(rangeCount>=1)){
        rangeCount=1;
        if(slot<=3){
          for(let i=1;i<4;i++){
            if(nonzero(v[ids.from(i)])||nonzero(v[ids.to(i)])||nonzero(v[ids.offset(i)])) rangeCount=i+1;
          }
        }
      }
      setDarkRangeCount(slot,rangeCount);
      refreshDarkEnvironmentSelect(slot);
    }

    // 2) The sample-environment JSON can populate dark-angle fields, so apply it
    //    before restoring the user's individual left-panel values.
    for(const slot of darkAssetSlots()){ const ids=darkAssetIds(slot); if(setSavedControl(ids.se,v[ids.se])) applySampleEnvironmentDefaults(slot); }

    // Migrate the v57 single background selection into BG1 once, if present.
    if(v.backgroundSelect1===undefined && v.sampleSelect!==undefined) v.backgroundSelect1=v.sampleSelect;

    // Migrate v71/v72 q_h1 naming (and the older single-vector controls)
    // into the q1_h/q1_k/q1_l convention.
    if(v.q_enable1===undefined && v.showK!==undefined) v.q_enable1=!!v.showK;
    for(let i=1;i<=3;i++){
      for(const c of ["h","k","l"]){
        const newId=`q${i}_${c}`, oldId=`q_${c}${i}`;
        if(v[newId]===undefined && v[oldId]!==undefined) v[newId]=v[oldId];
      }
    }
    if(v.q1_h===undefined && v.kh!==undefined) v.q1_h=v.kh;
    if(v.q1_k===undefined && v.kk!==undefined) v.q1_k=v.kk;
    if(v.q1_l===undefined && v.kl!==undefined) v.q1_l=v.kl;

    // 3) Restore every left-side parameter.  For crystal selectors, run their
    //    existing UI handler first; dMono/dAna are restored afterwards in DOM order.
    const darkSeIds=new Set(darkAssetSlots().map(slot=>darkAssetIds(slot).se));
    // The Resolution-only instrument details used to live in the permanent
    // sidebar. Include them here only for migration of the old left-panel
    // localStorage values; subsequent edits are persisted by resolutionPanel.
    const legacyRestoreControls=[...leftPanelControls(),...resolutionInstrumentDetailControls()];
    for(const el of legacyRestoreControls){
      if(el.id==='instrument'||darkSeIds.has(el.id)) continue;
      setSavedControl(el.id,v[el.id],{dispatchChange:el.id==='monoCrystal'||el.id==='anaCrystal'});
    }

    updateModeVisibility(); updateEnergyLabel(); updateS2MaxDisplay(); updateSupermirrorUI(); updateAutoW();
    return true;
  }finally{restoringLeftPanel=false;}
}

document.querySelector('.sidebar').addEventListener('input',saveLeftPanelState);
document.querySelector('.sidebar').addEventListener('change',saveLeftPanelState);

async function tryLoadDir(directory,map){try{return await loadJsonDirectory(directory,map);}catch(_e){map.clear();return 0;}}
async function tryLoadCifDir(directory,map){try{return await loadCifDirectory(directory,map);}catch(_e){map.clear();return 0;}}
function mergeLegacyRangeData(){
  for(const [key,inst] of instruments){
    if(Array.isArray(inst.S2_limits)||(inst.qe_range&&(Array.isArray(inst.qe_range.S2_limits)||Array.isArray(inst.qe_range.configuration)))) continue;
    let legacy=legacyRangeInstruments.get(key);
    if(!legacy){const target=(inst.name||key).toLowerCase();legacy=[...legacyRangeInstruments.values()].find(x=>(x.name||'').toLowerCase()===target);}
    if(legacy) inst.qe_range=legacy;
  }
}
async function initialize(){
  clearError(); fillCrystal('monoCrystal','dMono');fillCrystal('anaCrystal','dAna');updateModeVisibility();updateEnergyLabel();updateCalcMode();updateSupermirrorUI();updateAutoW();
  setStatus('instrument / BG_material / sample_environments loading...');
  const nInstrument=await loadJsonDirectory('instrument',instruments);
  const [nBG,nSE]=await Promise.all([tryLoadCifDir('BG_material',backgroundMaterials),tryLoadDir('sample_environments',sampleEnvironments)]);
  await tryLoadDir('instruments',legacyRangeInstruments); // migration compatibility only
  mergeLegacyRangeData();
  refreshSelect(instruments,$('instrument'),null);setBackgroundCount(Number($('backgroundCount')?.value)||1);for(const slot of darkAssetSlots()) refreshDarkEnvironmentSelect(slot);
  if(!instruments.size) throw new Error('instrument directory has no JSON files.');
  $('instrument').selectedIndex=0;for(const i of backgroundRowIndices()) $(`backgroundSelect${i}`).value='';for(const slot of darkAssetSlots()) $(darkAssetIds(slot).se).value='';applyInstrumentDefaults();for(const slot of darkAssetSlots()) applySampleEnvironmentDefaults(slot);updateBackgroundSelectAvailability();
  // JSON configuration is now fully loaded.  Only at this point is it safe to
  // overlay browser-local user parameters (including the selected instrument).
  const restoredLocalState=restoreLeftPanelState();
  // Restoring sidebar values can change Dark-angle Reference after the sample-
  // environment defaults were applied.  Re-sync the h/k/l row explicitly.
  for(const slot of darkAssetSlots()) updateDarkReferenceUI(slot);
  // Geometry starts at the current Reference Q HKL while preserving the current energy transfer.
  setGeometryTargetHKL([num("refh"),num("refk"),num("refl")]);
  setPropagationVectorCount(propagationVectorIndices().length); setDarkAssetCount(darkAssetSlots().length); updatePropagationVectorLabels(); ensureExtendedToolboxUI(); ensureNuclearLabelControl(); ensureQESliderControls(); updateCifUI(); await initializeCifGenerator();
  // Right-side controls are restored only after dynamic Toolbox controls exist and
  // after the default geometry target has been initialized, so saved values win.
  const restoredRightState=restoreRightPanelState();
  syncSfColorMaxControl("restore");
  enableRightPanelPersistence();
  $('tabQe').addEventListener('click',()=>setActiveTab('qe'));$('tabResolution').addEventListener('click',()=>setActiveTab('resolution'));$('tabToolbox').addEventListener('click',()=>setActiveTab('toolbox'));$('tabCifGenerator').addEventListener('click',()=>setActiveTab('cif-generator'));
  for(const id of ['toolLambda','toolEnergy','toolK','toolTHz','toolTemp','toolCm','toolVelocity','toolMass','toolField','toolJ','toolCal']) $(id).addEventListener('input',()=>setToolboxFrom(id));
  $('powderQ').addEventListener('input',()=>updatePowderRelation('powderQ'));$('powderTwoTheta').addEventListener('input',()=>updatePowderRelation('powderTwoTheta'));$('powderHW').addEventListener('input',()=>updatePowderRelation(powderRelationDriver));
  $('hwEntry').addEventListener('change',()=>{if(singleCache){const i=nearestHWIndex(singleCache,Number($('hwEntry').value));renderSingle(singleCache,i);saveRightPanelState();}});
  $('s2Slider').addEventListener('input',()=>{$('s2Entry').value=Number($('s2Slider').value).toFixed(1);if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));});
  $('s2Entry').addEventListener('change',()=>{if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));});
  $('displayNuclearLabels').addEventListener('change',()=>{if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));saveRightPanelState();});
  $('sfColorMaxSlider')?.addEventListener('input',()=>{
    syncSfColorMaxControl("slider");
    if(singleCache) renderSingle(singleCache,Number($('hwSlider').value));
  });
  $('sfColorMaxEntry')?.addEventListener('change',()=>{
    syncSfColorMaxControl("entry");
    if(singleCache) renderSingle(singleCache,Number($('hwSlider').value));
    saveRightPanelState();
  });
  $('sfThresholdEntry')?.addEventListener('change',()=>{
    sfThresholdFraction();
    if(singleCache) renderSingle(singleCache,Number($('hwSlider').value));
    saveRightPanelState();
  });
  $('cifSelectButton').addEventListener('click',()=>$('cifFileInput').click());
  $('cifClearButton')?.addEventListener('click',clearSelectedCif);
  $('cifFileInput').addEventListener('change',async()=>{
    const file=$('cifFileInput').files?.[0];
    if(!file) return;
    try{ await selectCifFile(file); }catch(err){ showError(err); }
    finally{ $('cifFileInput').value=''; }
  });
  setToolboxFrom('toolLambda'); updatePowderRelation('powderTwoTheta');
  setActiveTab(savedActiveTab());
  $('gm1').addEventListener('change',updateSupermirrorUI);$('calcMode').addEventListener('change',updateCalcMode);$('calc').addEventListener('click',doSingleResolution);$('calcScan').addEventListener('click',doScanResolution);$('scanSlider').addEventListener('input',()=>renderResolutionScan(num('scanSlider')));$('prev').addEventListener('click',()=>renderResolutionScan(num('scanSlider')-1));$('next').addEventListener('click',()=>renderResolutionScan(num('scanSlider')+1));
  for(const id of ['a','b','c','alpha','beta','gamma','Uh','Uk','Ul','Vh','Vk','Vl']) $(id).addEventListener('input',updateAutoW);
  $('flipUV')?.addEventListener('click',flipScatteringPlaneUV);
  updateOrientationReferenceUI(); applyDarkAngleSlotColors(); updateGeometryQuickTargetButtons();
  $('orientationReference')?.addEventListener('change',()=>{
    updateOrientationReferenceUI();
    updateGeometryQuickTargetButtons();

    // Changing the sample orientation reference defines an elastic
    // configuration.  Reset only the TAS-geometry energy transfer here; the
    // visible quick-target button functions themselves keep their existing
    // behavior.
    if($('geomHW')) $('geomHW').value='0';

    syncGeometryTargetToOrientationReference();
  });
  $('addDark')?.addEventListener('change',updateGeometryQuickTargetButtons);
  setStatus(`${nInstrument} instrument(s), ${nBG} BG CIF material(s), ${nSE} sample environment(s) loaded${(restoredLocalState||restoredRightState) ? ' / local parameters restored' : ''}`);recalculate();
}
initialize().catch(err=>{showError(err);setStatus('Configuration loading failed. Open the project through an HTTP server.');});
