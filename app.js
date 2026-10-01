import {
  PI, EPS, deg2rad, rad2deg, clamp,
  add, sub, scale, dot, norm, cross, normalize,
  RL_calc, UB_calc, makeSpiceScatteringPlaneBasis, reciprocalVectors,
  linspace, arange, interpExtrap
} from "./tas-core.js";
import {RL_calc as RLRes, inferOutOfPlaneHKL, calcResolution} from "./resolution-core.js";
import {
  parseCifStructure, nuclearStructureFactorSquared, setNeutronData, neutronAbsorptionSummary
} from "./cif-structure.js";

const $ = id => document.getElementById(id);
const instruments = new Map();
const backgroundMaterials = new Map();
const sampleEnvironments = new Map();

async function initializeNeutronData(){
  const response=await fetch("neutron-data.json",{cache:"no-store"});
  if(!response.ok) throw new Error(`Failed to load neutron-data.json: HTTP ${response.status}`);
  const payload=await response.json();
  setNeutronData(payload);
  return Object.keys(payload?.elements||{}).length;
}

// Background-scattering slots are dynamic. Preserve the original first four
// colors, then continue through a high-contrast palette and generated hues.
const BACKGROUND_COLOR_PALETTE=[
  [0,0,128],      // navy
  [165,42,42],    // brown
  [44,160,44],    // green
  [148,103,189],  // purple
  [255,127,14],   // orange
  [23,190,207],   // cyan
  [214,39,40],    // red
  [188,189,34],   // olive
  [227,119,194],  // pink
  [127,127,127],  // gray
  [31,119,180],   // blue
  [140,86,75]     // muted brown
];
const BACKGROUND_SLOTS=[];
function backgroundRgbForIndex(index){
  const i=Math.max(1,Math.floor(Number(index)||1));
  if(i<=BACKGROUND_COLOR_PALETTE.length) return BACKGROUND_COLOR_PALETTE[i-1].slice();
  // Golden-angle hue stepping keeps later backgrounds visually separated.
  const h=((i-BACKGROUND_COLOR_PALETTE.length)*137.508)%360;
  const c=0.62, l=0.48, hp=h/60, x=c*(1-Math.abs((hp%2)-1));
  let r=0,g=0,b=0;
  if(hp<1){r=c;g=x;} else if(hp<2){r=x;g=c;} else if(hp<3){g=c;b=x;}
  else if(hp<4){g=x;b=c;} else if(hp<5){r=x;b=c;} else {r=c;b=x;}
  const m=l-c/2;
  return [r,g,b].map(v=>Math.round((v+m)*255));
}
function backgroundSlot(index){
  const i=Math.max(1,Math.floor(Number(index)||1));
  while(BACKGROUND_SLOTS.length<i){
    const n=BACKGROUND_SLOTS.length+1;
    BACKGROUND_SLOTS.push({id:`backgroundSelect${n}`,rgb:backgroundRgbForIndex(n)});
  }
  return BACKGROUND_SLOTS[i-1];
}
for(let i=1;i<=4;i++) backgroundSlot(i);
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
  const slot=backgroundSlot(index);
  const [r,g,b]=slot.rgb;
  const row=document.createElement("div");
  row.className="background-row";
  row.dataset.backgroundIndex=String(index);
  row.innerHTML=`<label><span class="background-label"><i class="bg-swatch bg${index}" style="background:rgb(${r},${g},${b})"></i>BG${index}</span><select id="backgroundSelect${index}"><option value="">None</option></select></label>`+
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
  backgroundSlot(rows.length);
  host.replaceChildren();
  rows.forEach((value,i)=>{
    const row=createBackgroundRow(i+1,value);
    if(row) host.appendChild(row);
  });
  if($("backgroundCount")) $("backgroundCount").value=String(rows.length);
  updateBackgroundSelectAvailability();
  const add=$("addBackground");
  if(add) add.disabled=false;
  if(recalc) scheduleRecalc();
}

function setBackgroundCount(count,{recalc=false}={}){
  count=Math.max(1,Math.floor(Number(count)||1));
  backgroundSlot(count);
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
let powderCache = null;
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
    name.value=selectedCifFileName || "No file selected";
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
  updateAbsorptionCalculator();
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

  // Keep CIF Generator synchronized with the currently selected sample CIF.
  // Only editable generator fields are populated; file inputs are never set
  // programmatically.
  if(cifSpaceGroups.length) loadParsedCifIntoGenerator(parsed,fileName,{message:false});

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
  if($("cifDownloadTable")) $("cifDownloadTable").disabled=!ready;
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

function refreshCifAtomRowIndices(){
  const host=$("cifAtomRows");
  if(!host) return;
  [...host.querySelectorAll(".cif-atom-row")].forEach((row,i)=>{
    const cell=row.querySelector(".cif-atom-index");
    if(cell) cell.textContent=String(i+1);
  });
}

function validateCifAtomNumericInput(input){
  if(!input || !["x","y","z","occupancy"].includes(input.dataset.cifAtomField)) return true;
  const raw=String(input.value??"").trim();
  const n=parseNumericValue(raw);
  const valid=raw!=="" && Number.isFinite(n) && (input.dataset.cifAtomField!=="occupancy" || (n>=0 && n<=1));
  input.classList.toggle("cif-invalid-number",!valid);
  input.setAttribute("aria-invalid",valid?"false":"true");
  return valid;
}

function addCifAtomRow(values={}, {invalidate=true}={}){
  const host=$("cifAtomRows");
  if(!host) return;
  const row=document.createElement("div");
  row.className="cif-atom-row";
  const indexCell=document.createElement("div");
  indexCell.className="cif-atom-cell cif-atom-index";
  indexCell.setAttribute("aria-label","Atom row index");
  row.appendChild(indexCell);
  const specs=[
    ["element","text",values.element ?? ""],
    ["x","fraction",values.x ?? 0],
    ["y","fraction",values.y ?? 0],
    ["z","fraction",values.z ?? 0],
    ["occupancy","fraction",values.occupancy ?? 1]
  ];
  for(const [key,type,value] of specs){
    const cell=document.createElement("div"); cell.className="cif-atom-cell";
    const input=document.createElement("input");
    input.type=type==="fraction" ? "text" : type;
    input.dataset.cifAtomField=key;
    input.value=String(value);
    if(type==="fraction") input.inputMode="text";
    if(key==="element") input.placeholder="e.g. Cu";
    if(type==="fraction"){
      input.addEventListener("input",()=>validateCifAtomNumericInput(input));
      input.addEventListener("change",()=>validateCifAtomNumericInput(input));
    }
    cell.appendChild(input); row.appendChild(cell);
    if(type==="fraction") validateCifAtomNumericInput(input);
  }
  const action=document.createElement("div"); action.className="cif-atom-cell";
  const remove=document.createElement("button"); remove.type="button"; remove.textContent="Remove";
  remove.addEventListener("click",()=>{
    row.remove();
    if(!host.querySelector(".cif-atom-row")) addCifAtomRow({}, {invalidate:false});
    refreshCifAtomRowIndices();
    invalidateGeneratedCif();
  });
  action.appendChild(remove); row.appendChild(action);
  host.appendChild(row);
  refreshCifAtomRowIndices();
  if(invalidate) invalidateGeneratedCif();
}

function cifAtomRowValues(row){
  if(!row) return null;
  const get=key=>row.querySelector(`[data-cif-atom-field="${key}"]`)?.value ?? "";
  return {
    element:get("element"),
    x:get("x"),
    y:get("y"),
    z:get("z"),
    occupancy:get("occupancy")
  };
}

function copyLastCifAtomRow(){
  const rows=[...document.querySelectorAll("#cifAtomRows .cif-atom-row")];
  if(!rows.length){
    addCifAtomRow();
    return;
  }
  const values=cifAtomRowValues(rows[rows.length-1]);
  addCifAtomRow(values||{});
}

function replaceCifAtomRows(atoms){
  const host=$("cifAtomRows");
  if(!host) return;
  host.replaceChildren();
  for(const atom of atoms) addCifAtomRow(atom,{invalidate:false});
  if(!atoms.length) addCifAtomRow({}, {invalidate:false});
  refreshCifAtomRowIndices();
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
    const xInput=rows[i].querySelector('[data-cif-atom-field="x"]');
    const yInput=rows[i].querySelector('[data-cif-atom-field="y"]');
    const zInput=rows[i].querySelector('[data-cif-atom-field="z"]');
    const occInput=rows[i].querySelector('[data-cif-atom-field="occupancy"]');
    const xyzValid=[xInput,yInput,zInput].map(validateCifAtomNumericInput);
    const occValid=validateCifAtomNumericInput(occInput);
    const x=parseNumericValue(get("x")), y=parseNumericValue(get("y")), z=parseNumericValue(get("z")), occupancy=parseNumericValue(get("occupancy"));
    if(!xyzValid.every(Boolean)) throw new Error(`Atom ${i+1}: x, y, and z must be finite fractional coordinates.`);
    if(!occValid) throw new Error(`Atom ${i+1}: occupancy must be between 0 and 1.`);
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

function cleanCifBaseName(raw){
  let name=String(raw||"generated_structure").trim().replace(/[\\/:*?"<>|]+/g,"_");
  name=name.replace(/\.cif$/i,"");
  return name || "generated_structure";
}
function cleanCifFileName(raw){
  return `${cleanCifBaseName(raw)}.cif`;
}
function nextCifGeneratedBaseName(raw){
  const current=cleanCifBaseName(raw);
  const numbered=current.match(/^(.*)_generate(\d+)$/i);
  if(numbered){
    const n=Math.max(0,Number(numbered[2])||0)+1;
    return `${numbered[1]}_generate${String(n).padStart(2,"0")}`;
  }
  const base=current.replace(/_generate$/i,"");
  return `${base}_generate01`;
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

function syncCifReflectionBeamFromInstrument(){
  const e=Number($("energy")?.value);
  if(!(e>0)) return;
  const wavelength=9.044/Math.sqrt(e);
  const wavevector=2*Math.PI/wavelength;
  if($("cifReflectionEnergy")) $("cifReflectionEnergy").value=e.toFixed(4);
  if($("cifReflectionWavelength")) $("cifReflectionWavelength").value=wavelength.toFixed(5);
  if($("cifReflectionWavevector")) $("cifReflectionWavevector").value=wavevector.toFixed(5);
}
function syncCifReflectionBeamFrom(source){
  let e,lambda,k;
  if(source==="wavelength"){
    lambda=Number($("cifReflectionWavelength")?.value);
    if(!(lambda>0)) return;
    e=(9.044/lambda)**2;
    k=2*Math.PI/lambda;
  }else if(source==="wavevector"){
    k=Number($("cifReflectionWavevector")?.value);
    if(!(k>0)) return;
    lambda=2*Math.PI/k;
    e=(9.044/lambda)**2;
  }else{
    e=Number($("cifReflectionEnergy")?.value);
    if(!(e>0)) return;
    lambda=9.044/Math.sqrt(e);
    k=2*Math.PI/lambda;
  }
  if($("cifReflectionEnergy")) $("cifReflectionEnergy").value=e.toFixed(5);
  if($("cifReflectionWavelength")) $("cifReflectionWavelength").value=lambda.toFixed(5);
  if($("cifReflectionWavevector")) $("cifReflectionWavevector").value=k.toFixed(5);
  recalculateGeneratedReflections();
}
function currentCifReflectionBeam(){
  // The Generator starts from Instrument configuration, but Energy/Wavelength/
  // wavevector can be changed locally without changing the Instrument setup.
  const energyMode=checkedValue("energyMode") || $("energyMode")?.value;
  let enteredEnergy=Number($("cifReflectionEnergy")?.value);
  let wavelength=Number($("cifReflectionWavelength")?.value);
  let wavevector=Number($("cifReflectionWavevector")?.value);
  if(!(wavelength>0) && wavevector>0) wavelength=2*Math.PI/wavevector;
  if(!(enteredEnergy>0) && wavelength>0) enteredEnergy=(9.044/wavelength)**2;
  if(!(wavelength>0) && enteredEnergy>0) wavelength=9.044/Math.sqrt(enteredEnergy);
  if(!(wavevector>0) && wavelength>0) wavevector=2*Math.PI/wavelength;
  if(!(enteredEnergy>0) || !(wavelength>0) || !(wavevector>0)) throw new Error("Energy, wavelength, and wavevector must be greater than zero to calculate reflections.");
  const lambdaHalf=!!$("cifReflectionLambdaHalf")?.checked;
  const effectiveEnergy=lambdaHalf ? 4*enteredEnergy : enteredEnergy;
  const effectiveWavelength=lambdaHalf ? wavelength/2 : wavelength;
  return {energyMode,enteredEnergy,effectiveEnergy,lambdaHalf,wavelength:effectiveWavelength,baseWavelength:wavelength,wavevector};
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
      reflectionNumberText(r.intensity/100,4),
      String(r.multiplicity),
      reflectionNumberText(r.totalIntensity/100,4),
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

function downloadCifReflectionTable(){
  if(!lastGeneratedReflections.length) throw new Error("No reflections are available to download.");
  const rows=sortedCifReflections(lastGeneratedReflections,cifReflectionSort);
  const csv=[
    ["h","k","l","|F|^2 (barn)","Multiplicity","Total |F|^2 (barn)","2theta (deg)","Q (A^-1)","d (A)"].join(","),
    ...rows.map(r=>[r.hkl[0],r.hkl[1],r.hkl[2],r.intensity/100,r.multiplicity,r.totalIntensity/100,r.twoTheta,r.q,r.d].join(","))
  ].join("\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download=`${cleanCifBaseName(lastGeneratedCifName)}_reflection_table.csv`;
  document.body.appendChild(a); a.click(); a.remove();
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

function loadParsedCifIntoGenerator(parsed,fileName="selected_structure.cif",{message=true}={}){
  if(!parsed) return false;
  const sg=findGeneratorSpaceGroup(parsed);
  if(!sg) return false;
  const lattice=parsed.lattice || {};
  for(const key of ["a","b","c","alpha","beta","gamma"]){
    if(!Number.isFinite(Number(lattice[key]))) return false;
  }
  if(!Array.isArray(parsed.asymmetricSites) || !parsed.asymmetricSites.length) return false;
  if(!$("cifSpaceGroup") || !$("cifAtomRows")) return false;
  $("cifSpaceGroup").value=String(sg.number);
  for(const [key,id] of Object.entries(CIF_LATTICE_FIELDS)) if($(id)) $(id).value=String(lattice[key]);
  replaceCifAtomRows(parsed.asymmetricSites.map(a=>({element:a.element,x:a.x,y:a.y,z:a.z,occupancy:a.occupancy})));
  if($("cifGeneratedName")) $("cifGeneratedName").value=cleanCifBaseName(fileName);
  updateCifSpaceGroupInfo();
  invalidateGeneratedCif("");
  if(message) setCifGeneratorMessage(`Loaded ${fileName} for editing: #${sg.number} ${sg.hm}, ${parsed.asymmetricSites.length} asymmetric site(s). Press Generate to review the regenerated CIF and reflection table.`);
  return true;
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
  if(!loadParsedCifIntoGenerator(parsed,file.name,{message:true})) throw new Error(`Could not load ${file.name} into CIF Generator.`);
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
    syncCifReflectionBeamFromInstrument();
    if(selectedCifStructure) loadParsedCifIntoGenerator(selectedCifStructure,selectedCifFileName||"selected_structure.cif",{message:false});

    setCifGeneratedReady(false);
    clearCifReflectionTable("Press Generate to calculate reflections.");
    setCifOutputTab("preview");

    select.addEventListener("change",updateCifSpaceGroupInfo);
    $("cifSpaceGroupNumber")?.addEventListener("change",jumpToCifSpaceGroupNumber);
    $("cifSpaceGroupNumber")?.addEventListener("keydown",ev=>{ if(ev.key==="Enter"){ ev.preventDefault(); jumpToCifSpaceGroupNumber(); } });
    $("cifA")?.addEventListener("input",applyCifLatticeConstraints);
    $("cifGeneratedName")?.addEventListener("change",()=>{
      $("cifGeneratedName").value=cleanCifBaseName($("cifGeneratedName").value);
    });

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
      if(["cifLoadFile","cifReflectionEnergy","cifReflectionWavelength","cifReflectionWavevector"].includes(ev.target?.id)) return;
      invalidateGeneratedCif();
    });
    inputPane?.addEventListener("change",ev=>{
      if(["cifLoadFile","cifReflectionEnergy","cifReflectionWavelength","cifReflectionWavevector"].includes(ev.target?.id)) return;
      invalidateGeneratedCif();
    });

    $("cifCopyLattice")?.addEventListener("click",()=>{
      copyCurrentLatticeToGenerator();
      invalidateGeneratedCif("Current sample lattice copied — press Generate to review the updated CIF.");
    });
    $("cifCopyAtom")?.addEventListener("click",copyLastCifAtomRow);
    $("cifAddAtom")?.addEventListener("click",()=>addCifAtomRow());
    $("cifLoadExisting")?.addEventListener("click",()=>$("cifLoadFile")?.click());
    $("cifLoadFile")?.addEventListener("change",async ev=>{
      const file=ev.target.files?.[0];
      try{ await loadCifIntoGenerator(file); }
      catch(err){ setCifGeneratorMessage(err?.message||String(err),true); }
      finally{ ev.target.value=""; }
    });

    $("cifGenerate")?.addEventListener("click",()=>{
      const nameInput=$("cifGeneratedName");
      const previousName=nameInput?.value ?? "generated_structure";
      if(nameInput) nameInput.value=nextCifGeneratedBaseName(previousName);
      try{ generateCifForReview(); }
      catch(err){
        if(nameInput) nameInput.value=previousName;
        invalidateGeneratedCif("");
        setCifGeneratorMessage(err?.message||String(err),true);
      }
    });
    $("cifDownload")?.addEventListener("click",()=>{
      if(!lastGeneratedCifText){ setCifGeneratorMessage("Press Generate before downloading.",true); return; }
      downloadGeneratedCif(lastGeneratedCifText,lastGeneratedCifName);
      setCifGeneratorMessage(`Downloaded ${lastGeneratedCifName}.`);
    });
    $("cifDownloadTable")?.addEventListener("click",()=>{
      try{ downloadCifReflectionTable(); }
      catch(err){ setCifGeneratorMessage(err?.message||String(err),true); }
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
    $("cifReflectionEnergy")?.addEventListener("change",()=>syncCifReflectionBeamFrom("energy"));
    $("cifReflectionWavelength")?.addEventListener("change",()=>syncCifReflectionBeamFrom("wavelength"));
    $("cifReflectionWavevector")?.addEventListener("change",()=>syncCifReflectionBeamFrom("wavevector"));
    // Instrument configuration supplies the default Generator beam condition.
    const syncGeneratorBeam=()=>{ syncCifReflectionBeamFromInstrument(); recalculateGeneratedReflections(); };
    $("energy")?.addEventListener("change",syncGeneratorBeam);
    $("energyMode")?.addEventListener("change",syncGeneratorBeam);
    $("instrument")?.addEventListener("change",syncGeneratorBeam);
    $("S2maxUser")?.addEventListener("change",recalculateGeneratedReflections);
    $("S2maxEffective")?.addEventListener("change",recalculateGeneratedReflections);
    for(const id of ["Uh","Uk","Ul","Vh","Vk","Vl"]){
      $(id)?.addEventListener("change",recalculateGeneratedReflections);
    }
  }catch(err){
    select.innerHTML='<option value="">Space-group data unavailable</option>';
    for(const id of ["cifLoadExisting","cifGenerate","cifDownload","cifDownloadTable","cifSet","cifSpaceGroupNumber"]){ if($(id)) $(id).disabled=true; }
    setCifGeneratorMessage(`CIF Generator could not load space-group data: ${err?.message||String(err)}`,true);
  }
}

function parseNumericValue(value){
  const raw=String(value??"").trim();
  if(!raw) return NaN;
  const normalized=raw.replace(/[⁄／]/g,"/");
  const direct=Number(normalized);
  if(Number.isFinite(direct)) return direct;
  const numberPart='[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const match=normalized.match(new RegExp(`^\\s*(${numberPart})\\s*/\\s*(${numberPart})\\s*$`));
  if(!match) return NaN;
  const numerator=Number(match[1]);
  const denominator=Number(match[2]);
  if(!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator===0) return NaN;
  return numerator/denominator;
}

function num(id){
  const raw=String($(id)?.value??"");
  return raw.trim()==="" ? Number(raw) : parseNumericValue(raw);
}

// TAS sign routing.
//
// +++ must reproduce exactly the user-facing behavior that this application
// previously exposed under the label +-+.  That legacy UI branch intentionally
// entered the opposite internal Q-E/Angle branch.
//
// The newly restored +-+ branch is the direct/native +-+ calculation from the
// supplied reference implementation: M/S/A = (+,-,+), with c2Sign = +1 for S1.
// This gives the requested clockwise-positive S1 convention.
//
// -+- keeps the previously validated user-facing behavior.
function legacyTasSense(uiSense){
  // Used where the old public sign labels themselves are required (Resolution,
  // displayed S2 sign, schematic left/right placement).
  if(uiSense==="+++") return "+-+";
  return uiSense;
}
function calculationTasSense(uiSense){
  if(uiSense==="+++") return "-+-"; // exact former user-facing +-+ behavior
  if(uiSense==="+-+") return "+-+"; // native/pure +-+ branch from reference code
  if(uiSense==="-+-") return "+-+"; // existing validated user-facing -+- mapping
  return uiSense;
}
function assertImplementedUiSense(){
  return checkedValue("sense");
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
function userFacingTasMessage(value){
  return String(value??'').replace(/\bsv1\b/g,'U').replace(/\bsv2\b/g,'V');
}
function showError(err){
  const raw=err instanceof Error ? err.message : String(err);
  $("errorBox").textContent = userFacingTasMessage(raw);
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

  // Preserve the validated +++ / -+- orientation calibration exactly as in v66.
  // Only the real/pure +-+ instrument uses a clockwise-positive S1 encoder.
  // For that branch the virtual Bragg reference therefore reverses sign.
  const uiSense=uiSenseOverride ?? checkedValue("sense");
  const c2Sign=(uiSense==="+-+") ? -1 : (legacyTasSense(uiSense)==="+-+" ? +1 : -1);
  let s1Ref=-c2Sign*0.5*s2Ref;
  // ki ∥ U/V uses the same virtual elastic Bragg reference as ki ⟂ U/V,
  // but moves the S1=0 sample orientation by +90 degrees about the plane normal.
  if(isParallel) s1Ref+=c2Sign*90;
  return {mode,hkl,s1:wrap180(s1Ref),s2Ref};
}

function updateOrientationReferenceUI(){
  const mode=$('orientationReference')?.value || 'bragg';
  $('braggReferenceInputs')?.classList.toggle('hidden',mode!=='bragg');
  updateBraggOrientationPlaneWarning();
}

// UI-only validation for Sample orientation > Bragg peak position.
// Reuse the same reciprocal-space plane test already used by Time estimate;
// this does not alter TAS/Q-E/Resolution/Dark-angle calculations.
function updateBraggOrientationPlaneWarning(){
  const box=$('braggPlaneWarning');
  if(!box) return;
  const mode=$('orientationReference')?.value || 'bragg';
  if(mode!=='bragg'){
    box.classList.add('hidden');
    box.textContent='';
    return;
  }
  const hkl=[num('refh'),num('refk'),num('refl')];
  const result=hklInCurrentScatteringPlane(hkl);
  if(result.ok){
    box.classList.add('hidden');
    box.textContent='';
    return;
  }
  box.classList.remove('hidden');
  box.textContent=result.error
    ? `Warning: ${result.error}`
    : `Warning: Bragg peak (${hkl.map(v=>Number(v.toPrecision(6))).join(', ')}) is outside the current U-V scattering plane.`;
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
function isLocalDirectoryListingHost(){
  return ["localhost","127.0.0.1","::1"].includes(window.location.hostname);
}

async function discoverJsonFilesFromGitHub(directory){
  const owner=window.location.hostname.split('.')[0];
  const parts=window.location.pathname.split('/').filter(Boolean);
  const repo=parts[0];
  if(!repo) throw new Error("GitHub Pages repository name could not be inferred. Add directory/index.json.");
  const apiUrl=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${directory}`;
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
  // Local development with python -m http.server exposes directory listings.
  if(isLocalDirectoryListingHost()){
    const files=await discoverJsonFilesFromDirectoryListing(directory);
    if(files.length===0) throw new Error(`${directory}/ に JSON ファイルを見つけられませんでした。`);
    return files;
  }

  // GitHub Pages does not expose directory listings.  Query the repository
  // that owns the *current* Pages URL directly instead of probing an optional
  // directory/index.json first.  This both restores optional data directories
  // (BG material / sample environments) and avoids noisy manifest 404s.
  if(isGitHubPages()){
    const files=await discoverJsonFilesFromGitHub(directory);
    if(files.length===0) throw new Error(`${directory}/ に JSON ファイルがありません。`);
    return files;
  }

  // Other static hosts may provide an explicit manifest.
  try{
    const manifestResponse=await fetch(`${directory}/index.json`,{cache:"no-store"});
    if(manifestResponse.ok){
      const manifest=await manifestResponse.json();
      const files=normalizeJsonFileList(manifest)
        .filter(name=>/\.json$/i.test(name))
        .filter(name=>name.toLowerCase()!=="index.json");
      if(files.length>0) return files.sort((a,b)=>a.localeCompare(b));
    }
  }catch(_err){}

  const files=await discoverJsonFilesFromDirectoryListing(directory);
  if(files.length===0) throw new Error(`${directory}/ に JSON ファイルを見つけられませんでした。`);
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
  const apiUrl=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${directory}`;
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
  // On the local Python server, the directory listing is authoritative.
  if(isLocalDirectoryListingHost()) return await discoverCifFilesFromDirectoryListing(directory);

  // On GitHub Pages, use the current repository directly.  Do not probe a
  // possibly absent BG_material/index.json, because the repository contents
  // API already gives the authoritative CIF list without a console 404.
  if(isGitHubPages()) return await discoverCifFilesFromGitHub(directory);

  // Optional manifest for other static hosts that do not expose listings.
  try{
    const response=await fetch(`${directory}/index.json`,{cache:"no-store"});
    if(response.ok){
      const manifest=await response.json();
      const files=normalizeCifFileList(manifest).filter(name=>/\.cif$/i.test(name));
      if(files.length) return files.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
    }
  }catch(_err){}

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
    `<label>k${index}_h<input id="q${index}_h" type="text" inputmode="text" value="0"></label>`+
    `<label>k${index}_k<input id="q${index}_k" type="text" inputmode="text" value="0"></label>`+
    `<label>k${index}_l<input id="q${index}_l" type="text" inputmode="text" value="0"></label>`+
    `<button type="button" class="remove-propagation-vector" data-q-index="${index}">Remove</button>`;
  row.querySelector(`#q_enable${index}`).checked=values.enabled!==undefined ? !!values.enabled : true;
  for(const c of ["h","k","l"]){
    const raw=values[c] ?? 0;
    const value=parseNumericValue(raw);
    row.querySelector(`#q${index}_${c}`).value=Number.isFinite(value)?String(raw):"0";
  }
  return row;
}

function propagationVectorValues(){
  return propagationVectorIndices().map(index=>({
    enabled:!!$(`q_enable${index}`)?.checked,
    // Preserve the user's exact text (including fractions) when rows are
    // added/removed; numerical calculations parse these values via num().
    h:$(`q${index}_h`)?.value ?? "0",
    k:$(`q${index}_k`)?.value ?? "0",
    l:$(`q${index}_l`)?.value ?? "0"
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

  // Instrument configuration is intentionally identical for Single crystal and
  // Powder. Only sample-specific controls and the left Q-E plot switch modes.
  $("geometryRow")?.classList.remove("hidden");
  $("senseRow")?.classList.remove("hidden");
  $("s1minWrap")?.classList.remove("hidden");
  $("s1maxWrap")?.classList.remove("hidden");
  // Powder has no sample-orientation degree of freedom. Keep the common
  // Instrument configuration layout, but make the S1 limits read-only in
  // practice by disabling their entry boxes only while Powder is selected.
  if($("S1min")) $("S1min").disabled=!single;
  if($("S1max")) $("S1max").disabled=!single;
  $("lambdaHalf")?.closest("label")?.classList.remove("hidden");
  if($("s2Label")?.childNodes?.length) $("s2Label").childNodes[0].nodeValue="S2 min (deg)";

  // Q-E Range uses one shared two-column workspace for Single crystal and Powder.
  // Only the left plot and the Angle-calculation target controls change with mode;
  // Time estimate and the TAS-geometry card remain in the same place and size.
  $("singlePlot")?.classList.toggle("hidden",!single);
  $("powderPlot")?.classList.toggle("hidden",single);
  $("qeMapTabVector")?.classList.toggle("hidden",!single);
  if(!single && !$('qeVectorMapPane')?.classList.contains('hidden')) setQEMapTab('constant');
  if($('qeMapUnit')){
    $('qeMapUnit').disabled=!single;
    if(!single) $('qeMapUnit').value='ainv';
  }
  updateGeometryCalculationModeVisibility();
  $("geometrySpurionWarning")?.classList.toggle("hidden",!single);
  $("qeRangeControlGrid")?.classList.toggle("hidden",!single);
  document.querySelector('.nuclear-label-control')?.classList.toggle('hidden',!single);
  if(!single) syncPowderLinkedInputs();
  updateCifUI();
  requestAnimationFrame(scheduleVisiblePlotResize);
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

// Pure +-+ (HODACA) uses the opposite detector-side Q_lab convention from the
// legacy +++ / validated -+- branches.  Keep the legacy helper above unchanged
// so +++ and -+- remain byte-for-byte equivalent in their angle calibration.
// For pure +-+, positive S2 is on the +transverse side and positive S1 is CW.
function tasPhiLabDegForUiSense(ki,kf,s2deg,uiSense){
  if(uiSense!=="+-+") return tasPhiLabDeg(ki,kf,s2deg);
  const t=deg2rad(s2deg);
  const qx=+kf*Math.sin(t);
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
      wrap180(tasPhiLabDegForUiSense(ki,kf,s2,s1Calibration.uiSense)-omegaTarget)
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
  const s1C2Sign=(uiSense==="+-+") ? -1 : ((sense==="+-+") ? +1 : -1);
  const kRef=Math.sqrt(fixedReferenceEnergy/2.072);
  let s1RangeCalibration=QrefNorm>1e-10
    ? {
        refS1,
        c2Sign:s1C2Sign,
        omegaRef:wrap180(tasPhiLabDegForUiSense(kRef,kRef,2*thetaRef,uiSense)-phiRef),
        uiSense
      }
    : null;

  // Pure +-+ now uses the same exact S1/Q_lab inverse as Angle calculation.
  // This keeps its Q-E boundary consistent with the measured positive-S2,
  // clockwise-positive-S1 geometry.

  // Build the already-validated former +-+ (now +++) S1 calibration explicitly.
  // This lets the -+- Dark region inherit the actual +-+ blocking condition in
  // MOTOR S1 space rather than guessing it from a separate Q-space formula.
  const plusOrientationRef=effectiveOrientationReference(rl,fixedReferenceEnergy,"+++");
  const plusInternalSense=calculationTasSense("+++");
  const plusS1Calibration=QrefNorm>1e-10
    ? {
        refS1:plusOrientationRef.s1,
        c2Sign:(plusInternalSense==="+-+") ? +1 : -1,
        omegaRef:wrap180(tasPhiLabDeg(kRef,kRef,2*thetaRef)-phiRef),
        uiSense:"+++"
      }
    : null;

  // Exact forward partner of calcQ0() / tasMotorAngles() for an in-plane Q.
  // Given a plotted Q and |S2|, recover the absolute physical S1 motor value
  // using the same calibration equation as Angle calculation.
  const motorS1FromPlaneQ=(q,s2,ki,kf,calibration)=>{
    if(!calibration || norm(q)<=1e-12) return null;
    const phiTarget=rad2deg(Math.atan2(q[1],q[0]));
    const omegaTarget=wrap180(tasPhiLabDegForUiSense(ki,kf,s2,calibration.uiSense)-phiTarget);
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
    const unit=currentQEMapUnit();
    const qpts=pts.map(p=>qeXYForUnit(cache,[p.x,p.y],unit));
    Plotly.restyle(gd,{
      x:[qpts.map(p=>p[0])],
      y:[qpts.map(p=>p[1]+style.offset)],
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
      const xRange=gd?._fullLayout?.xaxis?.range;
      const yRange=gd?._fullLayout?.yaxis?.range;
      if(Array.isArray(xRange) && xRange.length>=2 && Number.isFinite(Number(xRange[0])) && Number.isFinite(Number(xRange[1]))){
        applyOffset(Math.abs(Number(xRange[1])-Number(xRange[0])));
      }else if(Array.isArray(yRange) && yRange.length>=2 && Number.isFinite(Number(yRange[0])) && Number.isFinite(Number(yRange[1]))){
        applyOffset(Math.abs(Number(yRange[1])-Number(yRange[0])));
      }
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

function currentQEMapUnit(){
  return $('qeMapUnit')?.value==='rlu' ? 'rlu' : 'ainv';
}

function qePlaneRluBasis(cache){
  const uq=hklToQ(cache.rl,cache.U), vq=hklToQ(cache.rl,cache.V);
  return {
    ux:dot(uq,cache.ex), uy:dot(uq,cache.ey),
    vx:dot(vq,cache.ex), vy:dot(vq,cache.ey)
  };
}

function qeXYForUnit(cache,p,unit=currentQEMapUnit()){
  const x=Number(p?.[0]), y=Number(p?.[1]);
  if(unit!=='rlu') return [x,y];
  const b=qePlaneRluBasis(cache);
  const det=b.ux*b.vy-b.uy*b.vx;
  if(Math.abs(det)<1e-12) return [x,y];
  return [(x*b.vy-y*b.vx)/det,(b.ux*y-b.uy*x)/det];
}

function qePointInPolygon(point,polygon){
  const x=point[0], y=point[1];
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const xi=polygon[i][0], yi=polygon[i][1], xj=polygon[j][0], yj=polygon[j][1];
    const cross=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-30)+xi);
    if(cross) inside=!inside;
  }
  return inside;
}

function qeVectorHKL(which){
  return [num(`qeVecH${which}`),num(`qeVecK${which}`),num(`qeVecL${which}`)];
}

function qeMapHeaderTitle(cache){
  const energyText=cache.energyMode==="Ef fixed"?`Ef=${cache.Ef.toFixed(2)} meV`:`Ei=${cache.Ei.toFixed(2)} meV`;
  const lam=cache.lambdaHalf?" | λ/2":"";
  return `${cache.inst.name||"Instrument"} | ${energyText}${lam}<br>`+
    `a=${cache.lc.a.toFixed(3)}, b=${cache.lc.b.toFixed(3)}, c=${cache.lc.c.toFixed(3)} Å<br>`+
    `α=${cache.lc.alpha.toFixed(1)}, β=${cache.lc.beta.toFixed(1)}, γ=${cache.lc.gamma.toFixed(1)}° | `+
    `Space group: #${cache.sampleSpaceGroup?.number ?? 1} ${cache.sampleSpaceGroup?.hm ?? "P1"} (${cache.latticeCentering}) | Plane: (${cache.U.join(",")})-(${cache.V.join(",")})`;
}

function renderQEVectorMap(cache){
  const plot=$('qeVectorPlot'), msg=$('qeVectorMessage');
  if(!plot || !cache || cache.powder) return;
  try{
    const a=qeVectorHKL(0), b=qeVectorHKL(1), dh=b.map((v,i)=>v-a[i]);
    const dhNorm=Math.hypot(...dh);
    if(!(dhNorm>1e-12)) throw new Error('HKL 1 and HKL 2 must be different points.');
    const qa=hklToQ(cache.rl,a), qb=hklToQ(cache.rl,b);
    const p0=[dot(qa,cache.ex),dot(qa,cache.ey)], p1=[dot(qb,cache.ex),dot(qb,cache.ey)];
    const dx=p1[0]-p0[0], dy=p1[1]-p0[1], lineLen=Math.hypot(dx,dy);
    if(!(lineLen>1e-12)) throw new Error('The selected HKL points do not define a line in the scattering plane.');
    const ux=dx/lineLen, uy=dy/lineLen;
    const qLimit=1.2*Math.max(...cache.QmaxList);
    const proj=p0[0]*ux+p0[1]*uy;
    const perp2=Math.max(0,p0[0]*p0[0]+p0[1]*p0[1]-proj*proj);
    const reach=Math.sqrt(Math.max(0,qLimit*qLimit-perp2));
    const sMin=-proj-reach, sMax=-proj+reach;
    const ns=260;
    const sVals=linspace(sMin,sMax,ns);
    // Q vector–E uses the line parameter t directly:
    // HKL(t) = HKL1 + t (HKL2 - HKL1).  This makes the horizontal
    // coordinate independent of the Constant-E map unit selector.
    const xVals=sVals.map(v=>v/lineLen);
    const z=[], darkKiZ=[], darkKfZ=[], darkFixedZ=[], hover=[];
    for(let i=0;i<cache.hwList.length;i++){
      const row=[], kiRow=[], kfRow=[], fixedRow=[], hrow=[];
      const region=cache.regions[i];
      const darkKi=cache.darkKI[i]||[], darkKf=cache.darkKF[i]||[], darkFixed=cache.darkFixed[i]||[];
      for(const sv of sVals){
        const pt=[p0[0]+sv*ux,p0[1]+sv*uy];
        const geometric=qePointInPolygon(pt,region);
        // Dark-angle geometry is an independent display layer.  Do not clip it
        // to the Accessible-Q polygon: a blocked motor geometry can lie outside
        // the currently reachable S1 envelope and should still be visible on
        // the Q-vector–E map when it falls inside the displayed axes.
        const inKi=darkKi.some(poly=>qePointInPolygon(pt,poly));
        const inKf=darkKf.some(poly=>qePointInPolygon(pt,poly));
        const inFixed=darkFixed.some(poly=>qePointInPolygon(pt,poly));
        // Keep the underlying accessible region yellow and draw dark-angle
        // regions as explicit colored overlays, including outside Accessible Q.
        row.push(geometric?1:0);
        kiRow.push(inKi?1:null);
        kfRow.push(inKf?1:null);
        fixedRow.push(inFixed?1:null);
        const t=sv/lineLen;
        const hkl=a.map((v,k)=>v+t*dh[k]);
        let status='';
        if(inKi || inKf || inFixed){
          const labels=[];
          if(inKi) labels.push('dark angle: ki side');
          if(inKf) labels.push('dark angle: kf side');
          if(inFixed) labels.push('dark angle: fixed');
          status=`<br>${labels.join(', ')}`;
        }
        hrow.push(`HKL = (${hkl.map(v=>v.toFixed(3)).join(', ')})<br>ℏω = ${cache.hwList[i].toFixed(2)} meV${status}`);
      }
      z.push(row); darkKiZ.push(kiRow); darkKfZ.push(kfRow); darkFixedZ.push(fixedRow); hover.push(hrow);
    }
    const endX=1;
    const tMin=sMin/lineLen, tMax=sMax/lineLen;
    let firstTick=Math.ceil(tMin-1e-9), lastTick=Math.floor(tMax+1e-9);
    const tickCount=Math.max(0,lastTick-firstTick+1);
    const tickStep=Math.max(1,Math.ceil(tickCount/9));
    let tickTs=[];
    for(let t=firstTick;t<=lastTick;t+=tickStep) tickTs.push(t);
    for(const t of [0,1]) if(t>=tMin-1e-9 && t<=tMax+1e-9 && !tickTs.some(x=>Math.abs(x-t)<1e-8)) tickTs.push(t);

    // Add every integer-HKL point across the full *displayed* horizontal range,
    // not only between HKL1 (t=0) and HKL2 (t=1).  A point is labelled when
    // h, k and l are all integers simultaneously.  Using the most strongly
    // varying component to enumerate candidates also catches fractional t,
    // e.g. (0,0,0)->(2,2,0) gives (1,1,0) at t=0.5.
    const varying=dh.map((v,i)=>[Math.abs(v),i]).sort((x,y)=>y[0]-x[0])[0][1];
    const hklAtTMin=a[varying]+tMin*dh[varying];
    const hklAtTMax=a[varying]+tMax*dh[varying];
    const lo=Math.ceil(Math.min(hklAtTMin,hklAtTMax)-1e-9);
    const hi=Math.floor(Math.max(hklAtTMin,hklAtTMax)+1e-9);
    for(let n=lo;n<=hi;n++){
      const t=(n-a[varying])/dh[varying];
      if(t<tMin-1e-9 || t>tMax+1e-9) continue;
      const hkl=a.map((v,k)=>v+t*dh[k]);
      if(hkl.every(v=>Math.abs(v-Math.round(v))<1e-8) && !tickTs.some(x=>Math.abs(x-t)<1e-8)) tickTs.push(t);
    }
    tickTs.sort((x,y)=>x-y);
    const fmtHkl=v=>{
      const r=Math.round(v);
      return Math.abs(v-r)<1e-8 ? String(r) : Number(v.toFixed(3)).toString();
    };
    const tickVals=tickTs.slice();
    const tickText=tickTs.map(t=>`(${a.map((v,k)=>fmtHkl(v+t*dh[k])).join(',')})`);
    const traces=[{
      type:'heatmap',x:xVals,y:cache.hwList,z,
      zmin:0,zmax:1,showscale:false,hoverinfo:'text',text:hover,
      colorscale:[[0,'rgba(255,255,255,1)'],[0.499,'rgba(255,255,255,1)'],[0.5,'rgba(255,222,105,0.72)'],[1,'rgba(255,222,105,0.72)']],
      name:'Accessible Q–E',showlegend:false
    },{
      type:'scatter',mode:'markers',x:[null],y:[null],hoverinfo:'skip',
      marker:{size:11,symbol:'square',color:'rgba(255,222,105,0.90)',line:{color:'#c7a62c',width:1}},
      name:'Accessible Q',showlegend:true,legendrank:0
    }];
    const addDarkOverlay=(mask,name,color,legendrank)=>{
      if(!mask.some(row=>row.some(v=>v===1))) return;
      traces.push({type:'heatmap',x:xVals,y:cache.hwList,z:mask,zmin:0,zmax:1,showscale:false,hoverinfo:'skip',
        colorscale:[[0,color],[1,color]],name,showlegend:true,legendrank});
    };
    // Keep legend ordering consistent with the Constant E map: Accessible Q,
    // background materials, then dark-angle overlays.

    // Overlay selected BG-material powder reflections on the Q-vector path.
    // A powder reflection is a |Q| = const ring/sphere.  Intersect that with
    // the selected reciprocal-space line p(s)=p0+s*u; each real intersection
    // becomes a vertical line in the t (= s/lineLen) coordinate.  This is a
    // display-only overlay and reuses the same BG powder peak calculation and
    // intensity convention as the Powder Q-E map.
    const qVectorLimit=Math.max(
      Math.hypot(p0[0]+sMin*ux,p0[1]+sMin*uy),
      Math.hypot(p0[0]+sMax*ux,p0[1]+sMax*uy)
    );
    for(const bg of selectedBackgrounds()){
      const material=backgroundMaterials.get(bg.key);
      const visiblePeaks=backgroundPowderPeaks(material,qVectorLimit);
      let bgLegendShown=false;
      for(const peak of visiblePeaks){
        const discriminant=peak.q*peak.q-perp2;
        if(discriminant < -1e-10) continue;
        const root=Math.sqrt(Math.max(0,discriminant));
        const roots=[-proj-root,-proj+root];
        const uniqueRoots=[];
        for(const sv of roots){
          if(sv < sMin-1e-9 || sv > sMax+1e-9) continue;
          if(uniqueRoots.some(v=>Math.abs(v-sv)<1e-8)) continue;
          uniqueRoots.push(sv);
        }
        for(const sv of uniqueRoots){
          const t=sv/lineLen;
          const x=[], y=[], customdata=[];
          let open=false;
          for(const w of cache.hwList){
            const s2=powderS2ForQAtHW(peak.q,w);
            if(!Number.isFinite(s2)){
              if(open){ x.push(null); y.push(null); customdata.push(null); open=false; }
              continue;
            }
            const hkl=a.map((v,k)=>v+t*dh[k]);
            x.push(t); y.push(w);
            customdata.push([
              `BG${bg.index+1}: ${bg.key}<br>${representativePowderHklText(peak)}<br>I/Imax = ${peak.relativeIntensity.toFixed(3)}<br>HKL path = (${hkl.map(v=>v.toFixed(3)).join(', ')})`,
              peak.q,
              `${s2.toFixed(3)}°`
            ]);
            open=true;
          }
          if(open){ x.push(null); y.push(null); customdata.push(null); }
          if(!x.length) continue;
          traces.push({
            type:'scatter',mode:'lines',x,y,customdata,
            name:`BG${bg.index+1}: ${bg.key}`,
            legendgroup:`background-scattering-${bg.index}`,
            showlegend:!bgLegendShown,
            legendrank:10+bg.index,
            line:{
              color:backgroundColor(bg.slot,0.20+0.75*peak.relativeIntensity),
              width:1.5
            },
            hovertemplate:`%{customdata[0]}<br>Q = %{customdata[1]:.4f} Å⁻¹<br>ħω = %{y:.3f} meV<br>S2 = %{customdata[2]}<extra></extra>`
          });
          bgLegendShown=true;
        }
      }
    }

    addDarkOverlay(darkKiZ,'Dark angle (ki side)','rgba(75,190,105,0.55)',20);
    addDarkOverlay(darkKfZ,'Dark angle (kf side)','rgba(75,170,235,0.55)',21);
    addDarkOverlay(darkFixedZ,'Dark angle (fixed)','rgba(95,105,220,0.50)',22);

    Plotly.react(plot,traces,{
      uirevision:'qeVector-hkl',
      plot_bgcolor:'#fff',paper_bgcolor:'#fff',
      title:{text:qeMapHeaderTitle(cache),x:0.5,xanchor:'center',font:{size:16}},
      xaxis:{title:{text:'HKL along selected Q vector',font:{size:15}},tickmode:'array',tickvals:tickVals,ticktext:tickText,tickangle:0,zeroline:true,zerolinecolor:'#777',showgrid:true,gridcolor:'#c3c9cf',gridwidth:1,showline:true,linecolor:'#555',linewidth:1.2,mirror:true},
      yaxis:{title:{text:'ℏω (meV)',font:{size:15}},showgrid:true,gridcolor:'#c3c9cf',gridwidth:1,zeroline:true,zerolinecolor:'#777',showline:true,linecolor:'#555',linewidth:1.2,mirror:true},
      shapes:[
        {type:'line',x0:0,x1:0,y0:0,y1:1,yref:'paper',line:{color:'black',width:1,dash:'dot'}},
        {type:'line',x0:endX,x1:endX,y0:0,y1:1,yref:'paper',line:{color:'black',width:1,dash:'dot'}}
      ],
      annotations:[
        {x:0,xref:'x',y:1.002,yref:'paper',text:'HKL 1',showarrow:false,yanchor:'bottom',font:{size:12}},
        {x:endX,xref:'x',y:1.002,yref:'paper',text:'HKL 2',showarrow:false,yanchor:'bottom',font:{size:12}}
      ],
      legend:{orientation:'h',x:0.5,xanchor:'center',y:-0.19,yanchor:'top'},
      margin:{l:66,r:30,t:126,b:96}
    },{responsive:true});
    if(msg) msg.textContent='';
  }catch(err){
    if(msg) msg.textContent=err?.message||String(err);
    try{Plotly.purge(plot);}catch(_e){}
  }
}

function setQEMapTab(name){
  const vector=name==='vector';
  $('qeMapTabConstant')?.classList.toggle('active',!vector);
  $('qeMapTabVector')?.classList.toggle('active',vector);
  $('qeMapTabConstant')?.setAttribute('aria-selected',String(!vector));
  $('qeMapTabVector')?.setAttribute('aria-selected',String(vector));
  $('qeConstantMapPane')?.classList.toggle('hidden',vector);
  $('qeVectorMapPane')?.classList.toggle('hidden',!vector);
  try{localStorage.setItem('tas-qe-map-tab-v1',vector?'vector':'constant');}catch(_e){}
  requestAnimationFrame(()=>{
    if(vector && singleCache) renderQEVectorMap(singleCache);
    else { safeResizePlot($('singlePlot')); safeResizePlot($('powderPlot')); }
  });
}

function renderSingle(cache,index=0){
  const unit=currentQEMapUnit();
  const plotNode=$("singlePlot");
  const keptView=plotNode?.dataset?.qeUnit===unit ? currentPlotRanges("singlePlot") : {x:null,y:null};
  const i=Math.max(0,Math.min(index,cache.regions.length-1));
  const rawBoundary=cache.regions[i];
  const T=p=>qeXYForUnit(cache,p,unit);
  const boundary=rawBoundary.map(T);
  const transformedG=cache.Gpoints.map(p=>({...p,...(()=>{const q=T([p.x,p.y]);return {x:q[0],y:q[1]};})()}));
  const transformedMag=cache.magPoints.map(p=>({...p,...(()=>{const q=T([p.x,p.y]);return {x:q[0],y:q[1]};})()}));
  const allViewPoints=[...boundary,...transformedG.map(p=>[p.x,p.y]),...transformedMag.map(p=>[p.x,p.y])];
  const qMax = Math.max(0, ...allViewPoints.map(p => Math.hypot(p[0], p[1])));

  const s2Min = num("S2min");
  const s2Max = cache.S2list[i];
  const Qplot=Math.max(1e-6,1.15*Math.max(...allViewPoints.map(p=>Math.max(Math.abs(p[0]),Math.abs(p[1]))),1));
  const initialMarkerSizes=singleMarkerSizes(2*Qplot,2*Qplot,cache.Gpoints.length+cache.magPoints.length);

  const sfThreshold=cache.cifStructure ? sfThresholdFraction() : 0;
  const visibleGpoints=cache.cifStructure
    ? transformedG.filter(p=>!p.label || !Number.isFinite(p.sfNorm) || p.sfNorm>sfThreshold)
    : transformedG;

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
  const magneticIndices=[...new Set(transformedMag.map(p=>Number(p.qIndex)).filter(Number.isFinite))].sort((a,b)=>a-b);
  for(const qIndex of magneticIndices){
    const pts=transformedMag.filter(p=>p.qIndex===qIndex);
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
    const ringPts=phi.map(t=>T([selectedQ*Math.cos(t),selectedQ*Math.sin(t)]));
    traces.push({x:ringPts.map(p=>p[0]),y:ringPts.map(p=>p[1]),mode:"lines",name:`S2 = ${selectedS2.toFixed(1)}°`,showlegend:false,line:{color:"black",width:1.2,dash:"solid"},hovertemplate:`S2 = ${selectedS2.toFixed(1)}°<br>Q = ${selectedQ.toFixed(3)} Å⁻¹<extra></extra>`});
  }
  for(const ring of cache.ringData){
    const pts=ring.x.map((x,j)=>T([x,ring.y[j]]));
    traces.push({
      x:pts.map(p=>p[0]),y:pts.map(p=>p[1]),mode:"lines",showlegend:false,
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
      traces.push({x:r.map(p=>T(p)[0]),y:r.map(p=>T(p)[1]),fill:"toself",name:"Dark angle (ki side)",showlegend:!kiLegend,legendgroup:"dark-ki",mode:"lines",line:{width:0},fillcolor:"rgba(0,255,0,0.15)",hoverinfo:"skip"});
      kiLegend=true;
    }
    for(const r of (cache.darkKF[i]||[])){
      traces.push({x:r.map(p=>T(p)[0]),y:r.map(p=>T(p)[1]),fill:"toself",name:"Dark angle (kf side)",showlegend:!kfLegend,legendgroup:"dark-kf",mode:"lines",line:{width:0},fillcolor:"rgba(80,190,255,0.25)",hoverinfo:"skip"});
      kfLegend=true;
    }
    for(const r of (cache.darkFixed[i]||[])){
      traces.push({x:r.map(p=>T(p)[0]),y:r.map(p=>T(p)[1]),fill:"toself",name:"Dark angle (fixed)",showlegend:!fixedLegend,legendgroup:"dark-fixed",mode:"lines",line:{width:0},fillcolor:"rgba(0,0,255,0.15)",hoverinfo:"skip"});
      fixedLegend=true;
    }
  }

  const title=qeMapHeaderTitle(cache);

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
    uirevision:`singlePlot-${unit}`,
    title:{text:title,x:0.5,xanchor:"center",font:{size:16}},
    xaxis:{title:{text:unit==='rlu'?"U coordinate (r.l.u.)":"Qx (Å⁻¹)",font:{size:16}},tickfont:{size:14},range:keptView.x||[-Qplot,Qplot],tickmode:"auto",nticks:10,showgrid:true,gridcolor:"#c3c9cf",gridwidth:1,zeroline:true,zerolinecolor:"#777",showline:true,linecolor:"#555",linewidth:1.2,mirror:true,constrain:"domain"},
    yaxis:{title:{text:unit==='rlu'?"V coordinate (r.l.u.)":"Qy (Å⁻¹)",font:{size:16}},tickfont:{size:14},range:keptView.y||[-Qplot,Qplot],tickmode:"auto",nticks:10,showgrid:true,gridcolor:"#c3c9cf",gridwidth:1,zeroline:true,zerolinecolor:"#777",showline:true,linecolor:"#555",linewidth:1.2,mirror:true,scaleanchor:"x",scaleratio:1,constrain:"domain"},
    // UI-only spacing: reclaim a little space above the plot, while reserving
    // more room below so the x-axis title and horizontal legend do not crowd.
    margin:{l:60,r:cache.cifStructure?88:20,t:92,b:96},
    legend:{orientation:"h",x:0.5,xanchor:"center",y:-0.16,yanchor:"top"}
  },{responsive:true});
  if(plotNode) plotNode.dataset.qeUnit=unit;
  bindSingleZoomMarkerScaling(cache,Qplot);
  bindSingleZoomLabelScaling(cache,Qplot);

  const hwDisplay=$("hwValue");
  if(hwDisplay) hwDisplay.textContent=`${cache.hwList[i].toFixed(1)} meV`;
  const hwEntry=$("hwEntry");
  if(hwEntry && document.activeElement!==hwEntry) hwEntry.value=cache.hwList[i].toFixed(1);
  updateQESpurionWarning(cache,i);
  updateS2MaxDisplayForQERange(cache,i);
  renderGeometry(cache,i);
  if(!$('qeVectorMapPane')?.classList.contains('hidden')) renderQEVectorMap(cache);
}

function qeGeometryAngles(cache, senseOverride=null, uiSenseOverride=null, calcOverride=null){
  const calc=calcOverride || {h:num("geomH"),k:num("geomK"),l:num("geomL"),hw:num("geomHW")};
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
  b.config.ui_sign=uiSenseOverride ?? checkedValue("sense");
  const angles=tasMotorAngles(calc,b);
  const Ei=cache.energyMode==="Ei fixed" ? cache.Ei : cache.Ef+calc.hw;
  const Ef=cache.energyMode==="Ei fixed" ? cache.Ei-calc.hw : cache.Ef;
  return {calc,angles,Ei,Ef,ki:Math.sqrt(Ei/2.072),kf:Math.sqrt(Ef/2.072)};
}

function qeDarkBlockWarningsForHKLE(cache,hkl,hw){
  if(!cache?.addDark || !Array.isArray(hkl) || hkl.length!==3) return [];
  const energy=Number(hw);
  if(!Number.isFinite(energy) || !Array.isArray(cache.hwList) || !cache.hwList.length) return [];
  try{
    const q=hklToQ(cache.rl,hkl.map(Number));
    const p=[dot(q,cache.ex),dot(q,cache.ey)];
    if(!p.every(Number.isFinite)) return [];
    let index=0, best=Infinity;
    for(let i=0;i<cache.hwList.length;i++){
      const delta=Math.abs(Number(cache.hwList[i])-energy);
      if(delta<best){ best=delta; index=i; }
    }
    const blocked=(polygons)=>Array.isArray(polygons) && polygons.some(poly=>qePointInPolygon(p,poly));
    const warnings=[];
    if(blocked(cache.darkKI?.[index])) warnings.push('ki blocked');
    if(blocked(cache.darkKF?.[index])) warnings.push('kf blocked');
    if(blocked(cache.darkFixed?.[index])) warnings.push('fixed blocked');
    return warnings;
  }catch(_err){ return []; }
}


function geometryCalculationMode(){
  return $('geometryModeScan')?.classList.contains('active') ? 'scan' : 'single';
}

function geometryScanPoints(){
  const nRaw=Math.round(Number($('geomScanNpts')?.value));
  const n=Number.isFinite(nRaw) ? Math.max(2,nRaw) : 2;
  const start={h:num('geomScanH0'),k:num('geomScanK0'),l:num('geomScanL0'),hw:num('geomScanHW0')};
  const end={h:num('geomScanH1'),k:num('geomScanK1'),l:num('geomScanL1'),hw:num('geomScanHW1')};
  const keys=['h','k','l','hw'];
  if(keys.some(key=>!Number.isFinite(start[key]) || !Number.isFinite(end[key]))) return [];
  return Array.from({length:n},(_,i)=>{
    const f=n<=1?0:i/(n-1);
    return Object.fromEntries(keys.map(key=>[key,start[key]+(end[key]-start[key])*f]));
  });
}

function syncGeometryScanPointSlider(pointCount){
  const slider=$('geomScanPointSlider'), output=$('geomScanPointValue');
  const n=Math.max(1,Number(pointCount)||1);
  let point=Math.round(Number(slider?.value)||1);
  point=Math.max(1,Math.min(n,point));
  if(slider){ slider.min=1; slider.max=n; slider.step=1; slider.value=point; }
  if(output) output.textContent=`${point} / ${n}`;
  return point-1;
}

function geometryDisplayedMotorAngles(target,isPowder,sense,displaySense){
  const a=target.angles;
  const s2=sense==="+-+"
    ? +Math.abs(Number(a.s2))
    : (displaySense==="+-+" ? -Math.abs(Number(a.s2)) : +Math.abs(Number(a.s2)));
  return {
    m1:-Number(a.m1), m2:-Number(a.m2),
    s1:isPowder ? 0 : Number(a.s1), s2,
    a1:-Number(a.a1), a2:-Number(a.a2)
  };
}

function geometryScanStatusWarnings(target,displayedAngles){
  const warnings=[];
  const s1=Number(displayedAngles?.s1), s2=Math.abs(Number(displayedAngles?.s2));
  const s1min=num("S1min"), s1max=num("S1max"), s2min=num("S2min");
  if(Number.isFinite(s1) && Number.isFinite(s1min) && Number.isFinite(s1max) && (s1<s1min-1e-8 || s1>s1max+1e-8)) warnings.push('S1 out of range');
  let s2max=NaN;
  try{ s2max=effectiveS2MaxAtEi(currentInstrument(),target?.Ei,false); }catch(_e){}
  if(Number.isFinite(s2) && Number.isFinite(s2min) && s2<s2min-1e-8) warnings.push('S2 out of range');
  if(Number.isFinite(s2) && Number.isFinite(s2max) && s2>s2max+1e-8 && !warnings.includes('S2 out of range')) warnings.push('S2 out of range');
  return warnings;
}

function geometryScanErrorStatus(err){
  const raw=String(err?.message || err || '');
  if(/kinematically inaccessible|requested Q and energy transfer/i.test(raw)) return 'No scattering triangle';
  return userFacingTasMessage(raw);
}

function renderGeometryScanTable(cache,points,sense,displaySense,selectedIndex){
  const box=$('geometryScanTableHost');
  if(!box) return;
  if(!points.length){
    box.classList.add('error-text');
    box.textContent='Angle calculation unavailable: enter valid initial/final H, K, L, ħω values.';
    return;
  }
  box.classList.remove('error-text');
  const rows=points.map((calc,i)=>{
    try{
      const target=qeGeometryAngles(cache,null,null,calc);
      const a=geometryDisplayedMotorAngles(target,false,sense,displaySense);
      const warnings=[];
      if(target.angles?.warning) warnings.push(target.angles.warning);
      warnings.push(...geometryScanStatusWarnings(target,a));
      warnings.push(...qeDarkBlockWarningsForHKLE(cache,[calc.h,calc.k,calc.l],calc.hw));
      const f=v=>Number.isFinite(v)?formatAngle(v):'—';
      return `<tr data-geometry-scan-row="${i}"><td class="geometry-scan-point-cell">${i+1}</td><td class="geometry-scan-hkl-cell">${calc.h.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.k.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.l.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.hw.toFixed(3)}</td><td>${f(a.m1)}</td><td>${f(a.m2)}</td><td>${f(a.s1)}</td><td>${f(a.s2)}</td><td>${f(a.a1)}</td><td>${f(a.a2)}</td><td>${warnings.length?warnings.join(' / '):''}</td></tr>`;
    }catch(err){
      return `<tr data-geometry-scan-row="${i}"><td class="geometry-scan-point-cell">${i+1}</td><td class="geometry-scan-hkl-cell">${calc.h.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.k.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.l.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.hw.toFixed(3)}</td><td colspan="6">—</td><td>${geometryScanErrorStatus(err)}</td></tr>`;
    }
  }).join('');
  box.innerHTML=`<div class="geometry-scan-table-wrap"><table class="geometry-scan-table"><thead><tr><th>Point</th><th class="geometry-scan-hkl-head">H</th><th class="geometry-scan-hkl-head">K</th><th class="geometry-scan-hkl-head">L</th><th class="geometry-scan-hkl-head">ħω</th><th>M1</th><th>M2</th><th>S1</th><th>S2</th><th>A1</th><th>A2</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  box.querySelectorAll('tbody tr[data-geometry-scan-row]').forEach(row=>{
    row.addEventListener('click',()=>{
      box.querySelectorAll('tbody tr.geometry-scan-clicked-row').forEach(other=>other.classList.remove('geometry-scan-clicked-row'));
      row.classList.add('geometry-scan-clicked-row');
    });
  });
}

function currentGeometryScanOutputTab(){
  return $('geometryScanTabPlot')?.classList.contains('active') ? 'plot' : 'table';
}

function setGeometryScanOutputTab(name){
  const plot=name==='plot';
  $('geometryScanTabTable')?.classList.toggle('active',!plot);
  $('geometryScanTabPlot')?.classList.toggle('active',plot);
  $('geometryScanTabTable')?.setAttribute('aria-selected',String(!plot));
  $('geometryScanTabPlot')?.setAttribute('aria-selected',String(plot));
  $('geometryScanTablePane')?.classList.toggle('hidden',plot);
  $('geometryScanPlotPane')?.classList.toggle('hidden',!plot);
  if(plot && singleCache && checkedValue('sampleMode')==='single'){
    requestAnimationFrame(()=>renderGeometry(singleCache,Number($('hwSlider')?.value)||0));
  }
}

function moveGeometryPlotForMode(scan){
  const plot=$('geometryPlot');
  const mount=$(scan?'geometryScanPlotMount':'geometryDefaultPlotMount');
  if(plot && mount && plot.parentNode!==mount) mount.appendChild(plot);
}

function setGeometryCalculationMode(mode){
  const scan=mode==='scan';
  $('geometryModeSingle')?.classList.toggle('active',!scan);
  $('geometryModeScan')?.classList.toggle('active',scan);
  $('geometryModeSingle')?.setAttribute('aria-selected',String(!scan));
  $('geometryModeScan')?.setAttribute('aria-selected',String(scan));
  updateGeometryCalculationModeVisibility();
  if(singleCache && checkedValue('sampleMode')==='single'){
    renderGeometry(singleCache,Number($('hwSlider')?.value)||0);
  }
}

function updateGeometryCalculationModeVisibility(){
  const singleSample=checkedValue('sampleMode')==='single';
  const scan=singleSample && geometryCalculationMode()==='scan';
  $('geometryCalcModeTabs')?.classList.toggle('hidden',!singleSample);
  $('singleGeometryTarget')?.classList.toggle('hidden',!singleSample || scan);
  $('scanGeometryTarget')?.classList.toggle('hidden',!scan);
  $('powderGeometryTarget')?.classList.toggle('hidden',singleSample);
  $('geometryScanOutput')?.classList.toggle('hidden',!scan);
  $('geometryAngles')?.classList.toggle('hidden',scan);
  $('geometryDefaultPlotMount')?.classList.toggle('hidden',scan);
  moveGeometryPlotForMode(scan);
}

function renderGeometry(cache,index=0){
  const isPowder=checkedValue("sampleMode")==="powder" || !!cache?.powder;
  const i=Math.max(0,Math.min(index,Math.max(0,(cache.hwList?.length||1)-1)));
  // Powder has no crystallographic sample orientation, but the TAS scattering
  // sign still determines the displayed motor-angle branch exactly as it does
  // for Single crystal.
  const sense=checkedValue("sense");
  // +++ keeps the exact former +-+ schematic placement.  The native +-+ branch
  // also uses the canonical plus-side drawing; only -+- is mirrored.
  const displaySense=legacyTasSense(sense);
  const scanMode=!isPowder && geometryCalculationMode()==='scan';
  const scanPoints=scanMode ? geometryScanPoints() : [];
  const scanIndex=scanMode ? syncGeometryScanPointSlider(scanPoints.length) : 0;
  const scanCalc=scanMode ? (scanPoints[scanIndex] || null) : null;
  const hw=isPowder ? parseNumericValue($("powderGeomHW")?.value) || 0 : (scanCalc?.hw ?? num("geomHW"));
  if(isPowder){
    $("geometrySpurionWarning")?.classList.add("hidden");
  }else{
    $("geometrySpurionWarning")?.classList.remove("hidden");
    updateGeometrySpurionWarning(cache,hw);
  }
  const mirror=displaySense==="+-+" ? 1 : -1;

  // A Single-crystal target is h,k,l,hw. Scan mode supplies the selected
  // interpolated point without changing the established single-point inputs.
  // A Powder target is the linked S2/Q pair together with hw.
  let target=null;
  let targetError="";
  try{ target=isPowder ? powderGeometryTarget() : qeGeometryAngles(cache,null,null,scanCalc); }
  catch(err){ targetError=userFacingTasMessage(err?.message || String(err)); }

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
    // Use the exact same canonical raw +-+ motor-angle branch for Powder and
    // Single crystal. Powder's user-facing angle calculation still keeps the
    // established sign-label mapping; only the schematic bypasses that mapping
    // so the drawing mirrors exactly like the Single-crystal schematic.
    const drawTarget=isPowder ? powderGeometryTarget("+-+",true) : qeGeometryAngles(cache,"+-+",sense,scanCalc);
    const {angles,ki,kf}=drawTarget;
    source=[-L,0];
    mono=[0,0];
    thetaKi=deg2rad(angles.m2);
    sample=[mono[0]+L*Math.cos(thetaKi),mono[1]+L*Math.sin(thetaKi)];
    // Pure +-+: positive S2 is a clockwise detector-arm rotation in the
    // TAS schematic.  Keep +++ / -+- drawing behavior unchanged.
    const s2Draw=(sense==="+-+") ? -Math.abs(Number(angles.s2)) : Number(angles.s2);
    thetaKf=thetaKi+deg2rad(s2Draw);
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
  const showDarkGeometry=!isPowder && Boolean($("addDark")?.checked);
  const darkRadius=1.0;
  if(showDarkGeometry){
    const circle=linspace(0,2*Math.PI,181);
    traces.push({x:circle.map(t=>sample[0]+darkRadius*Math.cos(t)),y:circle.map(t=>sample[1]+darkRadius*Math.sin(t)),mode:"lines",line:{color:"#d9d9d9",width:1},hoverinfo:"skip",showlegend:false});
  }

  // Draw every enabled dark-angle asset independently. Reference-Q assets
  // rotate with the sample about Q; Direct-beam assets use the ki direction at
  // the Reference-Q condition; Fixed assets remain laboratory-fixed.
  let referenceBase=qAngle, deltaS1=0;
  if(target && !isPowder){
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
      referenceBase=qAngle+((sense==="+-+" || sense==="-+-") ? +crystalDelta : -crystalDelta);
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
        base=qAngle+((sense==="+-+" || sense==="-+-") ? +crystalDelta : -crystalDelta);
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
          base+=(displaySense==="+-+" ? -1 : +1)*qToKi;
          darkReferenceOffset=(displaySense==="+-+"?-1:+1)*rad2deg(qToKi);
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

  // Display-only crystallographic U/V guides are meaningful only for a
  // Single-crystal sample. Powder has no sample-orientation axes.
  let uArrowAngle=qAngle, vArrowAngle=qAngle;
  const uvVectorLen=1.5*darkRadius;
  const vectorEnd=ang=>[
    sample[0]+uvVectorLen*Math.cos(ang),
    sample[1]+uvVectorLen*Math.sin(ang)
  ];
  let uEnd=null, vEnd=null;
  const uColor="#f2b6a0", vColor="#e377c2";
  if(!isPowder){
    try{
      const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
      const {ex,ey}=makeSpiceScatteringPlaneBasis(cache.rl,U,V);
      const planePhi=hkl=>{const q=hklToQ(cache.rl,hkl),x=dot(q,ex),y=dot(q,ey);return Math.atan2(y,x);};
      const targetHKL=target ? [target.calc.h,target.calc.k,target.calc.l] : U;
      const phiT=planePhi(targetHKL), phiU=planePhi(U), phiV=planePhi(V);
      if(displaySense==="+-+"){
        const fixedRefEnergy=(cache.energyMode==="Ei fixed") ? cache.Ei : cache.Ef;
        const orientationRef=effectiveOrientationReference(cache.rl,fixedRefEnergy);
        const phiRef=planePhi(orientationRef.hkl);
        // Display-only U/V handedness.  +++ must keep the former user-facing
        // +-+ drawing exactly as validated.  The pure +-+ instrument instead
        // has clockwise-positive S1, so its crystal frame must rotate with the
        // same phiRef-phiTarget sign already used by its sample-attached Dark
        // angle.  Example: hexagonal 100 @ S1=0 -> 010 rotates U/V by 60 deg CW.
        const crystalBase=(sense==="+-+")
          ? qAngle+(phiRef-phiT)
          : qAngle-(phiRef-phiT);
        uArrowAngle=crystalBase+(phiU-phiRef);
        vArrowAngle=crystalBase+(phiV-phiRef);
      }else{
        uArrowAngle=qAngle+(phiU-phiT);
        vArrowAngle=qAngle+(phiV-phiT);
      }
    }catch(_err){}
    uEnd=vectorEnd(uArrowAngle);
    vEnd=vectorEnd(vArrowAngle);
  }

  // Component-label placement only; the TAS geometry/calculation is untouched.
  // Keep labels on the outside of the mirrored TAS drawing: Analyzer is left
  // for +-+ and right for -+-.  Give Monochromator a little more clearance
  // from the crystal in both senses.
  const monoLabel=[mono[0]+(displaySense==="+-+"?-1.28:1.28),mono[1]];
  const anaLabel=[analyzer[0]+(displaySense==="+-+"?-1.05:1.05),analyzer[1]];
  const sampleLabelRadius=1.55;
  const sampleLabel=[
    sample[0]-sampleLabelRadius*Math.cos(qAngle),
    sample[1]-sampleLabelRadius*Math.sin(qAngle)
  ];
  const detLabel=[detector[0],detector[1]-0.58];
  const kiMid=pointAlong(kiArrow.tail,kiArrow.head,.5),kfMid=pointAlong(kfArrow.tail,kfArrow.head,.5),qMid=pointAlong(sample,qEnd,.5);

  const annotations=[];
  if(!isPowder && uEnd && vEnd){
    annotations.push(
      {x:uEnd[0],y:uEnd[1],ax:sample[0],ay:sample[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.4,arrowcolor:uColor},
      {x:vEnd[0],y:vEnd[1],ax:sample[0],ay:sample[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.4,arrowcolor:vColor},
      {x:uEnd[0]+0.16*Math.cos(uArrowAngle),y:uEnd[1]+0.16*Math.sin(uArrowAngle),text:"U",showarrow:false,font:{color:uColor,size:14}},
      {x:vEnd[0]+0.16*Math.cos(vArrowAngle),y:vEnd[1]+0.16*Math.sin(vArrowAngle),text:"V",showarrow:false,font:{color:vColor,size:14}}
    );
  }
  annotations.push(
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
  );

  // Auto-fit the full TAS drawing to the geometry card.
  const fitPoints=[source,mono,sample,analyzer,detector,kiArrow.tail,kiArrow.head,kfArrow.head,qEnd,monoLabel,anaLabel,sampleLabel,detLabel];
  if(!isPowder && uEnd && vEnd) fitPoints.push(uEnd,vEnd);
  // Reserve the same orientation-guide envelope for both sample modes. Powder
  // hides U/V, but retaining this fit radius keeps the TAS drawing scale and
  // monochromator anchor consistent with the Single-crystal view.
  const radial=Math.max(darkRadius,uvVectorLen,qVectorLen,kiVectorLen,kfVectorLen);
  fitPoints.push(
    [sample[0]-radial,sample[1]],[sample[0]+radial,sample[1]],
    [sample[0],sample[1]-radial],[sample[0],sample[1]+radial]
  );
  // Display layout only.
  // Keep +-+ at its established left-side anchor.  The mirrored -+- drawing was
  // effectively pushed to ~90% of the card width (0.85 anchor + 5% viewport
  // shift), which could clip labels.  Bring it back to a safer ~80% position.
  const monoFracX=displaySense==="+-+" ? 0.23 : 0.80;
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
    if(scanMode){
      renderGeometryScanTable(cache,scanPoints,sense,displaySense,scanIndex);
    }else if(target){
      const a=target.angles;
      const shown=geometryDisplayedMotorAngles(target,isPowder,sense,displaySense);
      angleBox.classList.remove("error-text");
      const qValue=isPowder
        ? target.q
        : norm(hklToQ(cache.rl,[target.calc.h,target.calc.k,target.calc.l]));
      const energyLine=`Ei=${target.Ei.toFixed(3)} meV, Ef=${target.Ef.toFixed(3)} meV, Q=${qValue.toFixed(4)} Å⁻¹`;
      const angleLine=`M1=${formatAngle(shown.m1)}°, M2=${formatAngle(shown.m2)}°, S1=${formatAngle(shown.s1)}°, S2=${formatAngle(shown.s2)}°, A1=${formatAngle(shown.a1)}°, A2=${formatAngle(shown.a2)}°`+
        (!isPowder && a.warning?` &nbsp; | &nbsp; ${a.warning}`:"");
      const darkWarnings=!isPowder
        ? qeDarkBlockWarningsForHKLE(cache,[target.calc.h,target.calc.k,target.calc.l],target.calc.hw)
        : [];
      const darkWarningLine=darkWarnings.length
        ? `<div class="geometry-result-line warning-text">Warning: ${darkWarnings.join(' / ')}</div>`
        : '';
      angleBox.innerHTML=`<div class="geometry-result-line geometry-energy-line">${energyLine}</div><div class="geometry-result-line geometry-angle-line">${angleLine}</div>${darkWarningLine}`;
    }else{
      angleBox.classList.add("error-text"); angleBox.textContent=`Angle calculation unavailable: ${targetError}`;
    }
  }

  const geometryPlot=$('geometryPlot');
  const geometryPlotVisible=geometryPlot && !geometryPlot.closest('.hidden');
  if(geometryPlotVisible){
    Plotly.react("geometryPlot",traces,{
      xaxis:{range:[xMin,xMax],showgrid:false,zeroline:false,showticklabels:false,fixedrange:true,constrain:"domain"},
      yaxis:{range:[yMin,yMax],showgrid:false,zeroline:false,showticklabels:false,scaleanchor:"x",scaleratio:1,fixedrange:true,constrain:"domain"},
      annotations,margin:{l:10,r:10,t:12,b:10},showlegend:false
    },{responsive:true,displayModeBar:false});
  }
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
        legendrank:10+bg.index,
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

  return {
    inst,lc,energyMode,
    Ei:energyMode==="Ei fixed" ? E : null,
    Ef:energyMode==="Ef fixed" ? E : null,
    hwList:[0],
    powder:true
  };
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
      const uiSense=b.config.ui_sign ?? checkedValue("sense");
      const orientationRef=effectiveOrientationReference(b.rl,fixedE,uiSense);
      const c2Sign=(uiSense==="+-+") ? -1 : ((b.config.sign_config==='+-+') ? +1 : -1);
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


function ensureNuclearLabelControl(){
  if($("displayNuclearLabels")) return;
  const plot=$("singlePlot");
  const sliderRow=$("hwSlider")?.closest(".energy-slider-row");
  if(!plot || !sliderRow) return;
  const row=document.createElement("div");
  row.className="nuclear-label-control";
  row.innerHTML='<label class="checkbox-label"><input id="displayNuclearLabels" type="checkbox" checked><span>Display labels of nuclear Bragg peaks</span></label>';
  const toolbar=document.querySelector('.qe-map-toolbar');
  if(toolbar) row.insertBefore(toolbar,row.firstChild);
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
    assertImplementedUiSense();
    if(checkedValue("sampleMode")==="single"){
      singleCache=calculateSingleCrystal();
      $("hwSlider").min=0;
      $("hwSlider").max=Math.max(0,singleCache.regions.length-1);
      $("hwSlider").step=1;
      const idx=Math.min(Number($("hwSlider").value)||0,singleCache.regions.length-1);
      $("hwSlider").value=idx;
      renderSingle(singleCache,idx);
    } else {
      powderCache=calculatePowder();
      renderGeometry(powderCache,0);
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
$('qeMapTabConstant')?.addEventListener('click',()=>setQEMapTab('constant'));
$('qeMapTabVector')?.addEventListener('click',()=>setQEMapTab('vector'));
$('qeMapUnit')?.addEventListener('change',()=>{
  try{localStorage.setItem('tas-qe-map-unit-v1',$('qeMapUnit').value);}catch(_e){}
  if(singleCache){
    renderSingle(singleCache,Number($('hwSlider')?.value)||0);
  }
});
for(const id of ['qeVecH0','qeVecK0','qeVecL0','qeVecH1','qeVecK1','qeVecL1']){
  $(id)?.addEventListener('input',()=>{if(singleCache && !$('qeVectorMapPane')?.classList.contains('hidden')) renderQEVectorMap(singleCache);});
}

$('geometryModeSingle')?.addEventListener('click',()=>setGeometryCalculationMode('single'));
$('geometryModeScan')?.addEventListener('click',()=>setGeometryCalculationMode('scan'));
$('geometryScanTabTable')?.addEventListener('click',()=>setGeometryScanOutputTab('table'));
$('geometryScanTabPlot')?.addEventListener('click',()=>setGeometryScanOutputTab('plot'));
$('geomScanPointSlider')?.addEventListener('input',()=>{
  if(singleCache && checkedValue('sampleMode')==='single') renderGeometry(singleCache,Number($('hwSlider')?.value)||0);
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
  if(el.closest?.('.time-estimate-pane')) return;
  if([
    "instrument",
    "seSelect","seSelect2","seSelect3",
    ...BACKGROUND_SLOTS.map(slot=>slot.id),
    "hwSlider",
    "geomScanPointSlider"
  ].includes(el.id)) return;

  el.addEventListener("input",scheduleRecalc);
  el.addEventListener("change",scheduleRecalc);
});



// ==================== Time estimate ====================
let timeScanRowCounter=0;
let timeScanSelectionAnchor=null;
let timeScanDragState=null;
let timeLoopPairCounter=0;
const TIME_ESTIMATE_STORAGE_KEY='tas-simulator-time-estimate-v1';
let restoringTimeEstimate=false;

function setGeometryCardTab(name){
  const time=name==='time';
  $('geometryTabAngles')?.classList.toggle('active',!time);
  $('geometryTabTime')?.classList.toggle('active',time);
  $('geometryTabAngles')?.setAttribute('aria-selected',String(!time));
  $('geometryTabTime')?.setAttribute('aria-selected',String(time));
  $('geometryAnglesPane')?.classList.toggle('hidden',time);
  $('geometryTimePane')?.classList.toggle('hidden',!time);
  $('singleMain')?.querySelector('.chart-grid')?.classList.toggle('time-estimate-active',time);
  saveTimeEstimateState();
  if(time && $('timeScanRows')?.children.length){
    requestAnimationFrame(()=>validateAllTimeScanRows({showMessage:true}));
  }
  // Both tabs share the same card width. Resize Plotly after switching panes
  // so it follows any responsive layout change without changing column widths.
  requestAnimationFrame(()=>{
    const powder=checkedValue('sampleMode')==='powder';
    safeResizePlot($(powder?'powderPlot':'singlePlot'));
    if(!time && (powder ? powderCache : singleCache)){
      safeResizePlot($('geometryPlot'));
    }
    if(time){
      updateTimeScanScrollState();
    }
  });
}

function currentGeometryCardTab(){
  return $('geometryTabTime')?.classList.contains('active') ? 'time' : 'angles';
}

function timeEstimateStoredState(){
  const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')]
    .map(timeScanRowValues).filter(Boolean);
  const fields={};
  for(const prefix of ['Start','End']){
    const ids=timeEstimateDatePartIds(prefix);
    fields[prefix.toLowerCase()]={
      date:$(ids.date)?.value||'',
      hour:$(ids.hour)?.value||'',
      minute:$(ids.minute)?.value||''
    };
  }
  return {version:5,tab:currentGeometryCardTab(),rows,fields,settings:{
    mcuSecondsPerUnit:String($('timeMcuSecondsPerUnit')?.value||'1'),
    movementPercent:String($('timeMovementPercent')?.value||'1')
  }};
}

function saveTimeEstimateState(){
  if(restoringTimeEstimate) return;
  try{ localStorage.setItem(TIME_ESTIMATE_STORAGE_KEY,JSON.stringify(timeEstimateStoredState())); }
  catch(_e){ /* localStorage can be unavailable in restricted browser contexts. */ }
}

function restoreTimeEstimateState(){
  let saved;
  try{ saved=JSON.parse(localStorage.getItem(TIME_ESTIMATE_STORAGE_KEY)||'null'); }
  catch(_e){ return false; }
  if(!saved || ![1,2,3,4,5].includes(saved.version) || !Array.isArray(saved.rows)) return false;
  restoringTimeEstimate=true;
  try{
    const host=$('timeScanRows');
    if(host) host.replaceChildren();
    timeScanRowCounter=0;
    timeLoopPairCounter=0;
    for(const values of saved.rows) addTimeScanRow(values||{},{suppressAutoPair:true});
    ensureTimeLoopPairIds();
    if(!saved.rows.length) addTimeScanRow({variable:'s1'});
    for(const prefix of ['Start','End']){
      const ids=timeEstimateDatePartIds(prefix);
      const values=saved.fields?.[prefix.toLowerCase()]||{};
      if($(ids.date)) $(ids.date).value=String(values.date||'');
      if($(ids.hour)) $(ids.hour).value=String(values.hour||'');
      if($(ids.minute)) $(ids.minute).value=String(values.minute||'');
    }
    if($('timeMcuSecondsPerUnit')) $('timeMcuSecondsPerUnit').value=String(saved.settings?.mcuSecondsPerUnit||'1');
    if($('timeMovementPercent')) $('timeMovementPercent').value=String(saved.settings?.movementPercent??'1');
    setGeometryCardTab(saved.tab==='time'?'time':'angles');
    updateTimeScanScrollState();
    updateTimeFixHeaderState();
    return true;
  }finally{ restoringTimeEstimate=false; }
}

function setTimeScanRowWarning(row,warning){
  if(!row) return;
  row.classList.toggle('time-scan-warning',!!warning);
  const index=row.querySelector('[data-time-index]');
  if(index) index.setAttribute('aria-invalid',warning?'true':'false');
}

function clearTimeScanRowWarnings(){
  document.querySelectorAll('#timeScanRows .time-scan-row').forEach(row=>{
    setTimeScanRowWarning(row,false);
    row.classList.remove('time-s2-limit-warning');
    delete row.dataset.timeS2Warning;
  });
}

function setTimeScanS2LimitWarning(row,warning,message=''){
  if(!row) return;
  row.classList.toggle('time-s2-limit-warning',!!warning);
  if(warning && message) row.dataset.timeS2Warning=message;
  else delete row.dataset.timeS2Warning;
}

function timeHklValueAt(parsed,index){
  if(parsed.fixed) return parsed.value;
  const direction=parsed.final>=parsed.initial ? 1 : -1;
  return parsed.initial + direction*parsed.step*index;
}

function hklInCurrentScatteringPlane(hkl){
  try{
    const {rl}=buildResolutionLattice();
    const U=[num('Uh'),num('Uk'),num('Ul')], V=[num('Vh'),num('Vk'),num('Vl')];
    const qU=hklToQ(rl,U), qV=hklToQ(rl,V), q=hklToQ(rl,hkl);
    const normal=cross(qU,qV), nn=norm(normal), qn=norm(q);
    if(!(nn>1e-12)) return {ok:false,error:'Current U and V do not define a valid scattering plane.'};
    if(qn<=1e-12) return {ok:true};
    const relative=Math.abs(dot(normal,q))/(nn*qn);
    return {ok:relative<=1e-8,relative};
  }catch(err){
    return {ok:false,error:userFacingTasMessage(err?.message||String(err))};
  }
}

function validateHkleScanPlane(parsedByKey,points){
  const last=Math.max(0,points-1);
  for(const i of [...new Set([0,last])]){
    const hkl=['h','k','l'].map(key=>timeHklValueAt(parsedByKey[key],i));
    const result=hklInCurrentScatteringPlane(hkl);
    if(!result.ok) return {ok:false,hkl,error:result.error};
  }
  return {ok:true};
}

function timeCommandMeta(command){
  const c=String(command||'s1');
  if(c==='qe') return {kind:'scan',specs:[{key:'q',label:'Q'},{key:'hw',label:'ħω'}]};
  if(c==='hkle') return {kind:'scan',specs:[{key:'h',label:'H'},{key:'k',label:'K'},{key:'l',label:'L'},{key:'hw',label:'ħω'}]};
  if(c==='br') return {kind:'drive',specs:[{key:'hkl',label:'HKL'}]};
  if(c==='s1') return {kind:'scan',specs:[{key:'s1',label:'S1'}]};
  if(c==='s2') return {kind:'scan',specs:[{key:'s2',label:'S2'}]};
  if(c==='rels1') return {kind:'scan',specs:[{key:'s1',label:'rel S1'}]};
  if(c==='rels2') return {kind:'scan',specs:[{key:'s2',label:'rel S2'}]};
  if(c==='th2th') return {kind:'scan',specs:[{key:'th2th',label:'th2th'}]};
  if(c==='temp') return {kind:'drive',specs:[{key:'target',label:'Target'}]};
  if(c==='field') return {kind:'drive',specs:[{key:'target',label:'Target'}]};
  if(c==='wait') return {kind:'wait',specs:[]};
  if(c==='loop') return {kind:'loop',specs:[{key:'loop',label:'Loop'}]};
  if(c==='endloop') return {kind:'endloop',specs:[]};
  return {kind:'scan',specs:[{key:'s1',label:'S1'}]};
}

function timeRangeSpec(command){
  return timeCommandMeta(command).specs;
}

function timeCommandIsScan(command){ return timeCommandMeta(command).kind==='scan'; }
function timeCommandIsDrive(command){ return timeCommandMeta(command).kind==='drive'; }
function timeCommandIsWait(command){ return timeCommandMeta(command).kind==='wait'; }
function timeCommandIsLoop(command){ return timeCommandMeta(command).kind==='loop'; }
function timeCommandIsEndLoop(command){ return timeCommandMeta(command).kind==='endloop'; }

function setTimeInputInvalid(input,invalid){
  if(!input) return;
  input.classList.toggle('time-invalid-number',!!invalid);
  input.setAttribute('aria-invalid',invalid?'true':'false');
}

function timeRangeInputHtml(spec,value='',command='s1'){
  const meta=timeCommandMeta(command);
  const kind=meta.kind;
  let placeholder='target value or loopN';
  if(meta.target==='br') placeholder='H K L (e.g. 1 0 0)';
  else if(kind==='scantitle') placeholder='e.g. T=loop1';
  else if(kind==='scan') placeholder='fixed, loopN, or initial final step';
  else if(kind==='loop') placeholder='initial final step';
  return `<label class="time-range-field"><span class="time-range-label">${spec.label}</span><input type="text" inputmode="text" data-time-range-key="${spec.key}" value="${String(value??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}" placeholder="${placeholder}"></label>`;
}

function updateTimeCommandTimeCell(row){
  if(!row) return;
  const command=row.querySelector('[data-time-variable]')?.value || 's1';
  const kind=timeCommandMeta(command).kind;
  const timeInput=row.querySelector('[data-time-mcu]');
  const fix=row.querySelector('[data-time-fix]');
  const detailInputs=[...row.querySelectorAll('[data-time-range-key]')];
  const parsedDetails=detailInputs.map(input=>parseTimeDetail(input.value,command,row));
  const allDetailsValid=parsedDetails.length>0 && parsedDetails.every(parsed=>parsed.ok);
  const allDetailsFixed=allDetailsValid && parsedDetails.every(parsed=>parsed.fixed);
  const structural=(kind==='loop' || kind==='endloop');
  const automaticZero=structural || kind==='scantitle' || (kind==='drive') || (kind==='scan' && allDetailsFixed);

  if(timeInput){
    if(automaticZero){
      timeInput.value='0';
      timeInput.readOnly=true;
      timeInput.classList.add('time-readonly');
      setTimeInputInvalid(timeInput,false);
      timeInput.title='Detail is fixed, so MCU is automatically 0.';
    }else{
      timeInput.readOnly=false;
      timeInput.classList.remove('time-readonly');
      timeInput.title=kind==='wait' ? 'Wait duration (seconds)' : (kind==='count' ? 'Count preset in MCU' : 'MCU per scan point (whole number)');
    }
  }

  if(fix){
    const forced=(kind!=='scan') || automaticZero;
    if(forced){
      if(row.dataset.timeFixBeforeForced===undefined) row.dataset.timeFixBeforeForced=fix.checked?'1':'0';
      fix.checked=true;
      fix.disabled=true;
    }else{
      fix.disabled=false;
      if(row.dataset.timeFixBeforeForced!==undefined){
        fix.checked=row.dataset.timeFixBeforeForced==='1';
        delete row.dataset.timeFixBeforeForced;
      }
    }
    if(kind==='wait') fix.title='Wait time is excluded from Calc MCU.';
    else if(kind==='scantitle') fix.title='scantitle is excluded from Calc MCU.';
    else if(structural) fix.title='Loop structure uses MCU = 0 and is excluded from Calc MCU.';
    else if(automaticZero) fix.title='Fixed Detail automatically uses MCU = 0 and is excluded from Calc MCU.';
    else if(kind==='drive') fix.title='Drive command time is fixed and excluded from Calc MCU.';
    else fix.title='Keep this scan MCU fixed during Calc MCU.';
  }
}

function updateTimeScanRowFields(row,values={}){
  if(!row) return;
  const command=row.querySelector('[data-time-variable]')?.value || 's1';
  const host=row.querySelector('[data-time-range-host]');
  if(!host) return;
  const previous={};
  for(const input of host.querySelectorAll('[data-time-range-key]')) previous[input.dataset.timeRangeKey]=input.value;
  const spec=timeRangeSpec(command);
  host.style.setProperty('--time-range-cols',String(spec.length));
  host.innerHTML=spec.map(item=>timeRangeInputHtml(item,values[item.key] ?? previous[item.key] ?? '',command)).join('');
  host.querySelectorAll('input').forEach(input=>{
    input.addEventListener('input',()=>{
      delete input.dataset.timeLoopRefBroken;
      delete input.dataset.timeLoopRefPair;
      const parsed=validateTimeRangeInput(input);
      saveTimeEstimateState();
      if(parsed.ok) clearTimeEstimateMessage();
      else setTimeEstimateMessage(parsed.error,true);
    });
    input.addEventListener('change',()=>{
      const parsed=validateTimeRangeInput(input);
      if(parsed.ok) applyRangeToSelectedTimeScans(row,input);
      updateTimeCommandTimeCell(row);
      saveTimeEstimateState();
      validateAllTimeScanRows({showMessage:true});
    });
  });
  updateTimeCommandTimeCell(row);
  updateTimeLoopIndentation();
}

function timeScanRows(){
  return [...document.querySelectorAll('#timeScanRows .time-scan-row')];
}

function selectedTimeScanRows(){
  return timeScanRows().filter(row=>row.classList.contains('time-scan-selected'));
}

function analyzeTimeLoopStructure(){
  const rows=timeScanRows();
  const stack=[];
  const info=new Map();
  const pairs=[];
  const unmatchedEnd=[];
  for(const row of rows){
    const command=row.querySelector('[data-time-variable]')?.value || 's1';
    if(command==='loop'){
      const level=stack.length+1;
      const entry={row,level,parentLoops:stack.map(x=>x.row)};
      info.set(row,{kind:'loop',level,depth:level-1,parentLoops:entry.parentLoops,pairRow:null});
      stack.push(entry);
      continue;
    }
    if(command==='endloop'){
      const opened=stack.pop();
      if(opened){
        const loopInfo=info.get(opened.row);
        loopInfo.pairRow=row;
        info.set(row,{kind:'endloop',level:opened.level,depth:opened.level-1,parentLoops:stack.map(x=>x.row),pairRow:opened.row});
        pairs.push({loopRow:opened.row,endRow:row,level:opened.level});
      }else{
        info.set(row,{kind:'endloop',level:0,depth:0,parentLoops:[],pairRow:null});
        unmatchedEnd.push(row);
      }
      continue;
    }
    info.set(row,{kind:'command',level:0,depth:stack.length,parentLoops:stack.map(x=>x.row),pairRow:null});
  }
  return {rows,info,pairs,unmatchedLoops:stack.map(x=>x.row),unmatchedEnd};
}

function ensureTimeLoopPairIds(){
  const structure=analyzeTimeLoopStructure();
  for(const {loopRow,endRow} of structure.pairs){
    let pair=loopRow.dataset.timeLoopPair || endRow.dataset.timeLoopPair || '';
    if(!pair) pair=`lp${++timeLoopPairCounter}`;
    loopRow.dataset.timeLoopPair=pair;
    endRow.dataset.timeLoopPair=pair;
  }
  return structure;
}

function matchingTimeLoopRow(row){
  if(!row) return null;
  const pair=row.dataset.timeLoopPair;
  if(pair){
    return timeScanRows().find(candidate=>candidate!==row && candidate.dataset.timeLoopPair===pair) || null;
  }
  const structure=ensureTimeLoopPairIds();
  return structure.info.get(row)?.pairRow || null;
}

function timeLoopLevelForRow(row){
  return analyzeTimeLoopStructure().info.get(row)?.level || 0;
}

function updateTimeLoopCommandLabels(){
  const structure=ensureTimeLoopPairIds();
  for(const row of structure.rows){
    const select=row.querySelector('[data-time-variable]');
    if(!select) continue;
    const rowInfo=structure.info.get(row);
    const loopOption=[...select.options].find(option=>option.value==='loop');
    const endOption=[...select.options].find(option=>option.value==='endloop');
    const proposedLevel=(select.value==='loop' && rowInfo?.level) ? rowInfo.level : Math.max(1,(rowInfo?.depth||0)+1);
    if(loopOption) loopOption.textContent=`loop${proposedLevel}`;
    if(endOption){
      endOption.textContent=(select.value==='endloop' && rowInfo?.level) ? `endloop${rowInfo.level}` : 'endloop';
      endOption.disabled=select.value!=='endloop';
      endOption.hidden=select.value!=='endloop';
    }
    select.disabled=select.value==='endloop';
    select.title=select.value==='endloop' ? 'This endloop is paired automatically with its loop command.' : '';
  }
  return structure;
}

function updateTimeLoopIndentation(){
  const structure=updateTimeLoopCommandLabels();
  for(const row of structure.rows){
    const rowInfo=structure.info.get(row);
    const depth=Math.max(0,rowInfo?.depth||0);
    row.style.setProperty('--time-loop-depth',String(depth));
    row.dataset.timeLoopDepth=String(depth);
    row.dataset.timeLoopLevel=String(rowInfo?.level||0);
    const commandCell=row.querySelector('.time-command-cell');
    if(commandCell) commandCell.style.paddingLeft=`${5+depth*14}px`;
  }
}

function parseTimeLoopReferenceToken(raw,row){
  const token=String(raw??'').trim();
  const match=/^loop([1-9]\d*)$/i.exec(token);
  if(!match) return null;
  const level=Number(match[1]);
  const rowInfo=ensureTimeLoopPairIds().info.get(row);
  const enclosing=rowInfo?.parentLoops||[];
  const loopRow=enclosing[level-1] || null;
  if(!loopRow) return {ok:false,error:`${token} is not available at this command.`,loopRef:level};
  return {ok:true,fixed:true,count:1,value:null,symbolic:true,loopRef:level,loopRow};
}

function normalizeBoundTimeLoopReferences(){
  const structure=ensureTimeLoopPairIds();
  for(const input of document.querySelectorAll('#timeScanRows [data-time-range-key]')){
    const commandRow=input.closest('.time-scan-row');
    if(input.dataset.timeLoopTextPairs){
      let refs=[];
      try{ refs=JSON.parse(input.dataset.timeLoopTextPairs)||[]; }catch(_e){ refs=[]; }
      let occurrence=0,broken=false;
      const commandInfo=structure.info.get(commandRow);
      input.value=String(input.value||'').replace(/\bloop([1-9]\d*)\b/gi,token=>{
        const ref=refs[occurrence++];
        if(!ref){ broken=true; return token; }
        const loopRow=structure.rows.find(row=>row.dataset.timeLoopPair===ref.pair && row.querySelector('[data-time-variable]')?.value==='loop');
        const loopInfo=loopRow ? structure.info.get(loopRow) : null;
        const stillEnclosing=!!(loopRow && commandInfo?.parentLoops?.includes(loopRow));
        if(stillEnclosing && loopInfo?.level) return `loop${loopInfo.level}`;
        broken=true; return token;
      });
      if(occurrence!==refs.length) broken=true;
      if(broken) input.dataset.timeLoopRefBroken='1';
      else delete input.dataset.timeLoopRefBroken;
      continue;
    }
    if(input.dataset.timeLoopRefPairs){
      let refs=[];
      try{ refs=JSON.parse(input.dataset.timeLoopRefPairs)||[]; }catch(_e){ refs=[]; }
      const tokens=String(input.value||'').trim().split(/\s+/).filter(Boolean);
      let broken=false;
      for(const ref of refs){
        const loopRow=structure.rows.find(row=>row.dataset.timeLoopPair===ref.pair && row.querySelector('[data-time-variable]')?.value==='loop');
        const commandInfo=structure.info.get(commandRow);
        const loopInfo=loopRow ? structure.info.get(loopRow) : null;
        const stillEnclosing=!!(loopRow && commandInfo?.parentLoops?.includes(loopRow));
        if(stillEnclosing && loopInfo?.level && Number.isInteger(ref.tokenIndex) && ref.tokenIndex>=0 && ref.tokenIndex<tokens.length){
          tokens[ref.tokenIndex]=`loop${loopInfo.level}`;
        }else broken=true;
      }
      if(tokens.length) input.value=tokens.join(' ');
      if(broken) input.dataset.timeLoopRefBroken='1';
      else delete input.dataset.timeLoopRefBroken;
      continue;
    }
    const pair=input.dataset.timeLoopRefPair;
    if(!pair) continue;
    const loopRow=structure.rows.find(row=>row.dataset.timeLoopPair===pair && row.querySelector('[data-time-variable]')?.value==='loop');
    const commandInfo=structure.info.get(commandRow);
    const loopInfo=loopRow ? structure.info.get(loopRow) : null;
    const stillEnclosing=!!(loopRow && commandInfo?.parentLoops?.includes(loopRow));
    if(stillEnclosing && loopInfo?.level){
      input.value=`loop${loopInfo.level}`;
      delete input.dataset.timeLoopRefBroken;
    }else{
      input.dataset.timeLoopRefBroken='1';
    }
  }
}

function applyRangeToSelectedTimeScans(sourceRow,sourceInput){
  if(!sourceRow?.classList.contains('time-scan-selected') || !sourceInput) return;
  const selected=selectedTimeScanRows();
  if(selected.length<2) return;
  const variable=sourceRow.querySelector('[data-time-variable]')?.value || '';
  const key=sourceInput.dataset.timeRangeKey;
  if(!key) return;
  const value=sourceInput.value;
  for(const row of selected){
    if((row.querySelector('[data-time-variable]')?.value || '')!==variable) continue;
    const input=row.querySelector(`[data-time-range-key="${key}"]`);
    if(!input || input===sourceInput) continue;
    input.value=value;
    validateTimeRangeInput(input);
    updateTimeCommandTimeCell(row);
  }
}

function applyMcuToSelectedTimeScans(sourceRow,value){
  if(!sourceRow?.classList.contains('time-scan-selected')) return;
  const selected=selectedTimeScanRows();
  if(selected.length<2) return;
  for(const row of selected){
    const input=row.querySelector('[data-time-mcu]');
    if(!input || input.readOnly) continue;
    input.value=value;
    setTimeInputInvalid(input,false);
  }
}

function updateTimeFixHeaderState(){
  const header=$('timeFixAll');
  const selected=selectedTimeScanRows();
  if(header){
    const base=selected.length ? selected : timeScanRows();
    const targets=base.filter(row=>!row.querySelector('[data-time-fix]')?.disabled);
    const states=targets.map(row=>!!row.querySelector('[data-time-fix]')?.checked);
    header.disabled=!targets.length;
    header.checked=states.length>0 && states.every(Boolean);
    header.indeterminate=states.some(Boolean) && !states.every(Boolean);
    header.title=selected.length ? `Apply Fix to selected scan commands` : 'Apply Fix to all scan commands';
  }
  const remove=$('timeRemoveScan');
  if(remove){
    remove.disabled=selected.length===0;
    remove.title=selected.length ? `Remove ${selected.length} selected command${selected.length===1?'':'s'}` : 'Select one or more indices to remove';
  }
}

function clearTimeScanSelection(){
  for(const row of timeScanRows()) row.classList.remove('time-scan-selected');
  timeScanSelectionAnchor=null;
  updateTimeFixHeaderState();
}

function selectTimeScanIndex(row,event){
  const rows=timeScanRows();
  const index=rows.indexOf(row);
  if(index<0) return;
  const anchorIndex=timeScanSelectionAnchor ? rows.indexOf(timeScanSelectionAnchor) : -1;
  if(event.shiftKey && anchorIndex>=0){
    for(const r of rows) r.classList.remove('time-scan-selected');
    const a=Math.min(anchorIndex,index), b=Math.max(anchorIndex,index);
    for(let i=a;i<=b;i++) rows[i].classList.add('time-scan-selected');
  }else if(event.ctrlKey || event.metaKey){
    row.classList.toggle('time-scan-selected');
    timeScanSelectionAnchor=row;
  }else{
    for(const r of rows) r.classList.remove('time-scan-selected');
    row.classList.add('time-scan-selected');
    timeScanSelectionAnchor=row;
  }
  updateTimeFixHeaderState();
}

function clearTimeScanDragMarkers(){
  for(const row of timeScanRows()) row.classList.remove('time-drag-before','time-drag-after','time-drag-source');
  document.querySelectorAll('#timeScanRows .time-loop-empty-dropzone, #timeScanRows .time-edge-dropzone').forEach(zone=>zone.classList.remove('time-drop-active'));
}

function startTimeScanDrag(row,event){
  if(!row || !event?.dataTransfer) return;
  ensureTimeLoopPairIds();
  if(!row.classList.contains('time-scan-selected')){
    for(const r of timeScanRows()) r.classList.remove('time-scan-selected');
    row.classList.add('time-scan-selected');
    timeScanSelectionAnchor=row;
    updateTimeFixHeaderState();
  }
  let rows=selectedTimeScanRows();
  if(!rows.length) return;

  const command=row.querySelector('[data-time-variable]')?.value || '';
  // Normal index dragging always reorders a complete loop block.  This keeps
  // nested loops freely movable as units (loop1 may contain loop2, and loop2
  // can still be moved before/after other commands without tearing its pair
  // apart).  Alt-drag retains the older boundary-resize gesture for users who
  // explicitly want to slide only loopN/endloopN.
  const boundaryDrag=rows.length===1 && (command==='loop' || command==='endloop') && !!event.altKey;
  if(boundaryDrag){
    rows=[row];
    timeScanDragState={
      rows,
      target:null,
      mode:null,
      boundary:true,
      boundaryType:command==='loop'?'start':'end',
      pairRow:matchingTimeLoopRow(row)
    };
  }else{
    rows=expandTimeRowsToLoopBlocks(rows);
    timeScanDragState={rows,target:null,after:false,boundary:false};
  }
  rows.forEach(r=>r.classList.add('time-drag-source'));
  document.querySelector('#geometryTimePane .time-scan-table-wrap')?.classList.add('time-dragging');
  refreshEmptyTimeLoopDropzones();
  event.dataTransfer.effectAllowed='move';
  event.dataTransfer.setData('text/plain',rows.map(r=>r.dataset.timeScanId||'').join(','));
}

function updateTimeScanDragTarget(event){
  if(!timeScanDragState) return;

  const edgeZone=event.target.closest?.('.time-edge-dropzone');
  if(edgeZone){
    event.preventDefault();
    clearTimeScanDragMarkers();
    timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
    edgeZone.classList.add('time-drop-active');
    timeScanDragState.target=edgeZone;
    timeScanDragState.mode=edgeZone.dataset.timeEdge==='start'?'edge-start':'edge-end';
    if(event.dataTransfer) event.dataTransfer.dropEffect='move';
    return;
  }

  // A loop/endloop boundary drag is different from an ordinary command drag:
  // it slides just that boundary so commands can be included/excluded without
  // first creating a row inside the loop.
  if(timeScanDragState.boundary){
    const target=event.target.closest?.('.time-scan-row');
    if(!target || timeScanDragState.rows.includes(target)) return;
    event.preventDefault();
    const indexCell=target.querySelector('[data-time-index]');
    const rect=(indexCell||target).getBoundingClientRect();
    const mode=event.clientY>rect.top+rect.height/2 ? 'after' : 'before';
    clearTimeScanDragMarkers();
    timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
    target.classList.add(mode==='after'?'time-drag-after':'time-drag-before');
    timeScanDragState.target=target;
    timeScanDragState.mode=mode;
    if(event.dataTransfer) event.dataTransfer.dropEffect='move';
    return;
  }

  const emptyZone=event.target.closest?.('.time-loop-empty-dropzone');
  if(emptyZone){
    event.preventDefault();
    clearTimeScanDragMarkers();
    timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
    emptyZone.classList.add('time-drop-active');
    timeScanDragState.target=emptyZone;
    timeScanDragState.mode='empty-loop';
    if(event.dataTransfer) event.dataTransfer.dropEffect='move';
    return;
  }

  const target=event.target.closest?.('.time-scan-row');
  if(!target || timeScanDragState.rows.includes(target)) return;
  event.preventDefault();

  const command=target.querySelector('[data-time-variable]')?.value || '';
  let mode='before';
  if(command==='loop'){
    // Dropping on a loop boundary always means “put this inside the loop”.
    mode='inside-start';
  }else if(command==='endloop'){
    // Dropping on endloop means insert immediately before it (still inside).
    mode='inside-end';
  }else{
    const indexCell=target.querySelector('[data-time-index]');
    const rect=(indexCell||target).getBoundingClientRect();
    mode=event.clientY>rect.top+rect.height/2 ? 'after' : 'before';
  }

  clearTimeScanDragMarkers();
  timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
  target.classList.add((mode==='after' || mode==='inside-start')?'time-drag-after':'time-drag-before');
  timeScanDragState.target=target;
  timeScanDragState.mode=mode;
  if(event.dataTransfer) event.dataTransfer.dropEffect='move';
}

function timeLoopPairOrderIsValid(rows){
  const stack=[];
  for(const row of rows){
    const command=row.querySelector('[data-time-variable]')?.value || '';
    if(command==='loop'){
      const pair=row.dataset.timeLoopPair || '';
      if(!pair) return false;
      stack.push(pair);
    }else if(command==='endloop'){
      const pair=row.dataset.timeLoopPair || '';
      if(!pair || !stack.length || stack[stack.length-1]!==pair) return false;
      stack.pop();
    }
  }
  return stack.length===0;
}

function finishTimeLoopBoundaryDrop(event){
  const state=timeScanDragState;
  if(!state?.boundary) return false;
  event.preventDefault();
  const boundaryRow=state.rows?.[0] || null;
  const target=state.target;
  const mode=state.mode || 'before';
  if(!boundaryRow || !target || boundaryRow===target) return true;

  const all=timeScanRows();
  const remaining=all.filter(row=>row!==boundaryRow);
  let insertIndex;
  if(mode==='edge-start') insertIndex=0;
  else if(mode==='edge-end') insertIndex=remaining.length;
  else{
    const targetIndex=remaining.indexOf(target);
    if(targetIndex<0) return true;
    insertIndex=targetIndex+(mode==='after'?1:0);
  }
  const candidate=remaining.slice();
  candidate.splice(insertIndex,0,boundaryRow);

  if(!timeLoopPairOrderIsValid(candidate)){
    setTimeEstimateMessage('Loop boundary cannot cross its paired boundary or break nested-loop structure.',true);
    return true;
  }

  const host=$('timeScanRows');
  let reference=null;
  if(insertIndex<candidate.length-1) reference=candidate[insertIndex+1];
  host.insertBefore(boundaryRow,reference);
  selectOnlyTimeScanRow(boundaryRow);
  ensureTimeLoopPairIds();
  renumberTimeScanRows();
  normalizeBoundTimeLoopReferences();
  refreshEmptyTimeLoopDropzones();
  saveTimeEstimateState();
  validateAllTimeScanRows({showMessage:true});
  return true;
}

function finishTimeScanDrop(event){
  if(!timeScanDragState) return;
  if(timeScanDragState.boundary){
    finishTimeLoopBoundaryDrop(event);
    clearTimeScanDragMarkers();
    document.querySelector('#geometryTimePane .time-scan-table-wrap')?.classList.remove('time-dragging');
    timeScanDragState=null;
    refreshEmptyTimeLoopDropzones();
    return;
  }
  event.preventDefault();
  const {rows,target}=timeScanDragState;
  const mode=timeScanDragState.mode || (timeScanDragState.after?'after':'before');
  if(target && !rows.includes(target)){
    const host=$('timeScanRows');
    let reference=target;

    if(mode==='edge-start'){
      reference=timeScanRows().find(row=>!rows.includes(row)) || null;
    }else if(mode==='edge-end'){
      reference=null;
    }else if(mode==='empty-loop'){
      const pair=target.dataset.timeLoopPair || '';
      reference=timeScanRows().find(row=>row.dataset.timeLoopPair===pair && row.querySelector('[data-time-variable]')?.value==='endloop') || null;
    }else if(mode==='after' || mode==='inside-start'){
      reference=target.nextSibling;
      // The immediate next sibling can itself be one of the dragged rows.
      // Skip dragged rows so the reference remains attached after they move.
      while(reference && rows.includes(reference)) reference=reference.nextSibling;
    }else if(mode==='inside-end' || mode==='before'){
      reference=target;
    }

    const fragment=document.createDocumentFragment();
    rows.forEach(row=>fragment.appendChild(row));
    host.insertBefore(fragment,reference);

    timeScanSelectionAnchor=rows[0]||null;
    ensureTimeLoopPairIds();
    renumberTimeScanRows();
    normalizeBoundTimeLoopReferences();
    refreshEmptyTimeLoopDropzones();
    saveTimeEstimateState();
    validateAllTimeScanRows({showMessage:true});
  }
  clearTimeScanDragMarkers();
  document.querySelector('#geometryTimePane .time-scan-table-wrap')?.classList.remove('time-dragging');
  timeScanDragState=null;
  refreshEmptyTimeLoopDropzones();
}

function cancelTimeScanDrag(){
  clearTimeScanDragMarkers();
  document.querySelector('#geometryTimePane .time-scan-table-wrap')?.classList.remove('time-dragging');
  timeScanDragState=null;
  refreshEmptyTimeLoopDropzones();
}

function applyTimeFixHeader(){
  const header=$('timeFixAll');
  if(!header) return;
  const selected=selectedTimeScanRows();
  const targets=selected.length ? selected : timeScanRows();
  for(const row of targets){
    const input=row.querySelector('[data-time-fix]');
    if(input && !input.disabled) input.checked=header.checked;
  }
  updateTimeFixHeaderState();
  saveTimeEstimateState();
}

function refreshEmptyTimeLoopDropzones(){
  const host=$('timeScanRows');
  if(!host) return;
  host.querySelectorAll('.time-loop-empty-dropzone,.time-edge-dropzone').forEach(zone=>zone.remove());

  const startZone=document.createElement('div');
  startZone.className='time-edge-dropzone'; startZone.dataset.timeEdge='start';
  startZone.title='Drop here to move selected command(s) before Index 1';
  host.insertBefore(startZone,host.firstChild);

  const structure=ensureTimeLoopPairIds();
  const rows=structure.rows;
  for(const loopRow of rows){
    if(loopRow.querySelector('[data-time-variable]')?.value!=='loop') continue;
    const endRow=matchingTimeLoopRow(loopRow);
    if(!endRow) continue;
    const startIndex=rows.indexOf(loopRow), endIndex=rows.indexOf(endRow);
    if(startIndex<0 || endIndex!==startIndex+1) continue; // only truly empty loops

    const zone=document.createElement('div');
    zone.className='time-loop-empty-dropzone';
    zone.dataset.timeLoopPair=loopRow.dataset.timeLoopPair||'';
    const level=Math.max(1,structure.info.get(loopRow)?.level||1);
    zone.dataset.timeLoopDepth=String(level);
    zone.style.setProperty('--time-empty-loop-depth',String(level-1));
    zone.title='Drop a command here to place it inside this loop';
    host.insertBefore(zone,endRow);
  }
  const endZone=document.createElement('div');
  endZone.className='time-edge-dropzone'; endZone.dataset.timeEdge='end';
  endZone.title='Drop here to move selected command(s) after the last Index';
  host.appendChild(endZone);
}

function updateTimeScanScrollState(){
  const wrap=document.querySelector('#geometryTimePane .time-scan-table-wrap');
  if(!wrap) return;
  // Keep the table geometry deterministic: show up to 10 scan rows, then scroll.
  // Do not derive this height from the Q-E plot or message/footer content.
  wrap.style.maxHeight='';
  wrap.classList.toggle('time-scan-scroll',timeScanRows().length>10);
}

function renumberTimeScanRows(){
  ensureTimeLoopPairIds();
  timeScanRows().forEach((row,i)=>{
    const cell=row.querySelector('[data-time-index]');
    if(cell) cell.textContent=String(i+1);
  });
  updateTimeLoopIndentation();
  normalizeBoundTimeLoopReferences();
  refreshEmptyTimeLoopDropzones();
  updateTimeScanScrollState();
  updateTimeFixHeaderState();
}

function formatTimeMcuValue(value){
  const n=parseNumericValue(value);
  return Number.isFinite(n) ? String(Math.floor(Math.max(0,n))) : String(value??'');
}

function addTimeScanRow(values={},options={}){
  const host=$('timeScanRows');
  if(!host) return null;
  const row=document.createElement('div');
  row.className='time-scan-row';
  row.dataset.timeScanId=String(++timeScanRowCounter);
  row.innerHTML=`
    <div class="time-scan-cell time-scan-index" data-time-index></div>
    <div class="time-scan-cell time-command-cell"><select data-time-variable aria-label="Command">
      <option value="s1">s1</option><option value="s2">s2</option><option value="rels1">rel s1</option><option value="rels2">rel s2</option><option value="th2th">th2th</option><option value="qe">QE</option><option value="hkle">HKLE</option><option value="br">br</option><option value="temp">temp</option><option value="field">field</option><option value="wait">wait</option><option value="loop">loop</option><option value="endloop">endloop</option>
    </select></div>
    <div class="time-scan-cell"><div class="time-range-inputs" data-time-range-host></div></div>
    <div class="time-scan-cell"><span class="time-mcu-entry"><input type="text" inputmode="numeric" data-time-mcu value="${String(values.mcu??values.time??((values.command??values.variable)==='wait' ? (values.ranges?.wait??values.details?.wait??'') : '')).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}" placeholder="0"></span></div>
    <div class="time-scan-cell time-fix-cell"><input type="checkbox" data-time-fix aria-label="Fix time for this command"></div>`;
  const before=options?.before;
  if(before && before.parentElement===host) host.insertBefore(row,before);
  else host.appendChild(row);
  const command=row.querySelector('[data-time-variable]');
  let requested=values.command ?? values.variable ?? 's1';
  let restoredRanges=values.ranges||values.details||{};
  // v40: br uses one compact HKL Detail field. Migrate both the pre-v39
  // target form and the v39 three-field H/K/L form without changing values.
  if(requested==='br'){
    if(restoredRanges.hkl===undefined){
      if(restoredRanges.h!==undefined || restoredRanges.k!==undefined || restoredRanges.l!==undefined){
        restoredRanges={hkl:[restoredRanges.h??'',restoredRanges.k??'',restoredRanges.l??''].join(' ').trim()};
      }else if(restoredRanges.target!==undefined){
        restoredRanges={hkl:String(restoredRanges.target??'').trim()};
      }
    }
  }
  const allowed=['s1','s2','rels1','rels2','th2th','qe','hkle','br','temp','field','wait','loop','endloop'];
  command.value=allowed.includes(requested)?requested:'s1';
  const fix=row.querySelector('[data-time-fix]');
  if(fix) fix.checked=!!values.fixed;
  const initialTime=row.querySelector('[data-time-mcu]');
  if(initialTime && String(initialTime.value).trim()!=='' && Number.isFinite(parseNumericValue(initialTime.value))) initialTime.value=formatTimeMcuValue(initialTime.value);
  updateTimeScanRowFields(row,restoredRanges);
  row.dataset.timeCommand=command.value;
  if(command.value==='loop' && !options?.suppressAutoPair){
    const endRow=addTimeScanRow({command:'endloop'},{before:row.nextElementSibling,suppressAutoPair:true});
    const pair=`lp${++timeLoopPairCounter}`;
    row.dataset.timeLoopPair=pair;
    if(endRow) endRow.dataset.timeLoopPair=pair;
  }
  if(command.value==='endloop') command.disabled=true;
  command.addEventListener('change',()=>{
    const previous=row.dataset.timeCommand || 's1';
    const next=command.value;
    const previousPair=previous==='loop' ? matchingTimeLoopRow(row) : null;
    if(previous==='loop' && next!=='loop' && previousPair){
      previousPair.remove();
      delete row.dataset.timeLoopPair;
    }
    row.dataset.timeCommand=next;
    updateTimeScanRowFields(row);
    if(previous!=='loop' && next==='loop'){
      const endRow=addTimeScanRow({command:'endloop'},{before:row.nextElementSibling,suppressAutoPair:true});
      const pair=`lp${++timeLoopPairCounter}`;
      row.dataset.timeLoopPair=pair;
      if(endRow) endRow.dataset.timeLoopPair=pair;
      // A newly-created loop immediately becomes the active insertion context.
      // The very first + Add scan therefore goes inside this loop, even while empty.
      selectOnlyTimeScanRow(row);
    }
    renumberTimeScanRows();
    clearTimeEstimateMessage();
    updateTimeFixHeaderState();
    saveTimeEstimateState();
    validateAllTimeScanRows({showMessage:true});
  });
  const timeInput=row.querySelector('[data-time-mcu]');
  timeInput.addEventListener('input',()=>{
    if(timeInput.readOnly) return;
    const parsed=validateTimeMcuInput(timeInput);
    saveTimeEstimateState();
    if(parsed.ok) clearTimeEstimateMessage();
    else setTimeEstimateMessage('MCU must be a non-negative whole number (wait uses seconds).',true);
  });
  timeInput.addEventListener('change',()=>{
    if(timeInput.readOnly) return;
    const parsed=validateTimeMcuInput(timeInput);
    if(parsed.ok){
      timeInput.value=formatTimeMcuValue(parsed.value);
      applyMcuToSelectedTimeScans(row,timeInput.value);
    }
    saveTimeEstimateState();
    validateAllTimeScanRows({showMessage:true});
  });
  fix?.addEventListener('change',()=>{ updateTimeFixHeaderState(); saveTimeEstimateState(); });
  const indexCell=row.querySelector('[data-time-index]');
  if(indexCell){
    indexCell.draggable=true;
    indexCell.title='Click to select; drag to reorder. Loop/endloop moves the complete loop block; Alt-drag a loop boundary to resize its scope.';
    indexCell.addEventListener('click',event=>{ event.stopPropagation(); selectTimeScanIndex(row,event); });
    indexCell.addEventListener('dragstart',event=>startTimeScanDrag(row,event));
    indexCell.addEventListener('dragend',cancelTimeScanDrag);
  }
  renumberTimeScanRows();
  saveTimeEstimateState();
  return row;
}

function timeScanRowValues(row){
  if(!row) return null;
  const command=row.querySelector('[data-time-variable]')?.value || 's1';
  const ranges={};
  row.querySelectorAll('[data-time-range-key]').forEach(input=>{ ranges[input.dataset.timeRangeKey]=input.value; });
  return {
    command,
    ranges,
    mcu:row.querySelector('[data-time-mcu]')?.value ?? '',
    fixed:!!row.querySelector('[data-time-fix]')?.checked
  };
}

function timeLoopBlockRows(row){
  if(!row) return [];
  const rows=timeScanRows();
  const command=row.querySelector('[data-time-variable]')?.value || '';
  let loopRow=row, endRow=null;
  if(command==='loop') endRow=matchingTimeLoopRow(row);
  else if(command==='endloop'){ loopRow=matchingTimeLoopRow(row); endRow=row; }
  else return [row];
  if(!loopRow || !endRow) return [row];
  const a=rows.indexOf(loopRow), b=rows.indexOf(endRow);
  if(a<0 || b<a) return [row];
  return rows.slice(a,b+1);
}

function expandTimeRowsToLoopBlocks(rows){
  const all=timeScanRows();
  const set=new Set();
  for(const row of rows){
    for(const member of timeLoopBlockRows(row)) set.add(member);
  }
  return all.filter(row=>set.has(row));
}

function timeScanInsertionReferenceAfterSelection(){
  const selected=selectedTimeScanRows();
  if(!selected.length) return null;
  // selectedTimeScanRows() follows document order, so the final item is the
  // lowest selected index even when the selection is non-contiguous.
  const last=selected[selected.length-1];
  const command=last.querySelector('[data-time-variable]')?.value || '';
  // Selecting a loop command means “insert inside this loop”, immediately
  // before its automatically paired endloop.
  if(command==='loop'){
    const endRow=matchingTimeLoopRow(last);
    if(endRow) return endRow;
  }
  // Selecting an endloop is also treated as an insertion point inside that
  // loop. This makes it possible to grow a newly-created nested loop simply by
  // selecting either boundary and pressing + Add scan.
  if(command==='endloop') return last;
  return last.nextElementSibling;
}

function selectOnlyTimeScanRow(row){
  if(!row) return;
  for(const r of timeScanRows()) r.classList.remove('time-scan-selected');
  row.classList.add('time-scan-selected');
  timeScanSelectionAnchor=row;
  updateTimeFixHeaderState();
}

function addTimeScanAfterSelection(){
  const before=timeScanInsertionReferenceAfterSelection();
  const row=addTimeScanRow({}, {before});
  // Continue sequence editing from the row that was just inserted. This is
  // especially important for nested loops: if this row is changed to loop,
  // the next + Add scan goes between that loop and its paired endloop instead
  // of using an older outer-loop selection.
  if(row) selectOnlyTimeScanRow(row);
  clearTimeEstimateMessage();
  saveTimeEstimateState();
}

function copySelectedOrLastTimeScanRows(){
  const rows=timeScanRows();
  if(!rows.length){ setTimeEstimateMessage('There is no scan to copy.',true); return; }

  const selected=selectedTimeScanRows();
  let sources;
  if(selected.length){
    sources=expandTimeRowsToLoopBlocks(selected);
  }else{
    const last=rows[rows.length-1];
    sources=(last.querySelector('[data-time-variable]')?.value==='endloop') ? timeLoopBlockRows(last) : [last];
  }
  const copies=sources.map(row=>timeScanRowValues(row)).filter(Boolean);
  const before=selected.length ? sources[sources.length-1]?.nextElementSibling || null : null;
  for(const values of copies) addTimeScanRow(values,{before,suppressAutoPair:true});
  ensureTimeLoopPairIds();
  renumberTimeScanRows();
  clearTimeEstimateMessage();
  saveTimeEstimateState();
}

function removeSelectedTimeScanRows(){
  const selected=selectedTimeScanRows();
  if(!selected.length) return;
  ensureTimeLoopPairIds();
  const toRemove=new Set(selected);
  for(const row of selected){
    const command=row.querySelector('[data-time-variable]')?.value || '';
    if(command==='loop' || command==='endloop'){
      const pair=matchingTimeLoopRow(row);
      if(pair) toRemove.add(pair);
    }
  }
  for(const row of toRemove){
    if(timeScanSelectionAnchor===row) timeScanSelectionAnchor=null;
    row.remove();
  }
  clearTimeScanSelection();
  ensureTimeLoopPairIds();
  renumberTimeScanRows();
  clearTimeEstimateMessage();
  saveTimeEstimateState();
}

function parseTimeMathExpression(raw,row=null,{allowLoopReference=true}={}){
  const text=String(raw??'').trim();
  if(!text) return {ok:false,error:'Enter a numeric expression.'};
  let pos=0;
  const refs=[];
  const skip=()=>{ while(/\s/.test(text[pos]||'')) pos++; };
  const parsePrimary=()=>{
    skip();
    if(text[pos]==='('){
      pos++;
      const node=parseAddSub();
      skip();
      if(text[pos]!==')') throw new Error('Missing closing parenthesis.');
      pos++;
      return node;
    }
    const rest=text.slice(pos);
    const loop=/^loop([1-9]\d*)\b/i.exec(rest);
    if(loop){
      if(!allowLoopReference || !row) throw new Error(`${loop[0]} is not allowed here.`);
      const ref=parseTimeLoopReferenceToken(loop[0],row);
      if(!ref?.ok) throw new Error(ref?.error||`${loop[0]} is not available at this command.`);
      pos+=loop[0].length;
      refs.push({pair:ref.loopRow?.dataset?.timeLoopPair||'',level:ref.loopRef});
      return {type:'loop',level:ref.loopRef};
    }
    const num=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if(!num) throw new Error(`Unexpected token near "${rest.slice(0,12)}".`);
    pos+=num[0].length;
    return {type:'number',value:Number(num[0])};
  };
  const parseUnary=()=>{
    skip();
    if(text[pos]==='+' || text[pos]==='-'){
      const op=text[pos++];
      return {type:'unary',op,node:parseUnary()};
    }
    return parsePrimary();
  };
  const parseMulDiv=()=>{
    let node=parseUnary();
    while(true){
      skip();
      const op=text[pos];
      if(op!=='*' && op!=='/') break;
      pos++;
      node={type:'binary',op,left:node,right:parseUnary()};
    }
    return node;
  };
  const parseAddSub=()=>{
    let node=parseMulDiv();
    while(true){
      skip();
      const op=text[pos];
      if(op!=='+' && op!=='-') break;
      pos++;
      node={type:'binary',op,left:node,right:parseMulDiv()};
    }
    return node;
  };
  const evaluate=(node,context={})=>{
    if(node.type==='number') return node.value;
    if(node.type==='loop') return Number(context?.[node.level]);
    if(node.type==='unary'){
      const v=evaluate(node.node,context);
      return node.op==='-' ? -v : v;
    }
    const a=evaluate(node.left,context), b=evaluate(node.right,context);
    if(node.op==='+') return a+b;
    if(node.op==='-') return a-b;
    if(node.op==='*') return a*b;
    if(node.op==='/') return b===0 ? NaN : a/b;
    return NaN;
  };
  try{
    const ast=parseAddSub();
    skip();
    if(pos!==text.length) throw new Error(`Unexpected token near "${text.slice(pos,pos+12)}".`);
    const constant=refs.length===0 ? evaluate(ast,{}) : NaN;
    if(refs.length===0 && !Number.isFinite(constant)) throw new Error('Expression does not evaluate to a finite number.');
    return {ok:true,ast,refs,value:constant,evaluate:(context)=>evaluate(ast,context)};
  }catch(err){
    return {ok:false,error:err?.message||String(err)};
  }
}

function parseTimeRange(raw,row=null,{allowLoopReference=true}={}){
  const text=String(raw??'').trim();
  if(!text) return {ok:false,error:'Enter one fixed value or initial final step.'};
  if(text.includes(',')) return {ok:false,error:'Commas are not allowed. Separate Detail values with spaces.'};

  // A complete arithmetic expression is a fixed value. This allows SPICE forms
  // such as 4/6+(loop1-1)*1/6 while preserving the existing three-value scan
  // syntax (initial final step).
  const whole=parseTimeMathExpression(text,row,{allowLoopReference});
  if(whole.ok){
    return {
      ok:true,fixed:true,count:1,value:whole.refs.length?null:whole.value,
      expression:whole,expressionText:text,symbolic:whole.refs.length>0,
      textRefs:whole.refs
    };
  }

  const parts=text.split(/\s+/).filter(Boolean);
  if(parts.length!==3) return {ok:false,error:'Use one arithmetic expression or three space-separated values: initial final step.'};
  const expressions=parts.map(part=>parseTimeMathExpression(part,row,{allowLoopReference:false}));
  const invalid=expressions.find(x=>!x.ok);
  if(invalid) return {ok:false,error:`Every scan range value must be numeric arithmetic without loop references. ${invalid.error||''}`.trim()};
  const [initial,final,enteredStep]=expressions.map(x=>x.value);
  const step=Math.abs(enteredStep);
  if(!(step>0)) return {ok:false,error:'Step must be non-zero.'};
  const distance=Math.abs(final-initial);
  const count=distance<1e-12 ? 1 : Math.floor(distance/step+1e-10)+1;
  if(!(count>=1) || !Number.isFinite(count)) return {ok:false,error:'Could not determine the number of scan points.'};
  return {ok:true,fixed:false,count,initial,final,step};
}

function parseBrHklDetail(raw,row=null){
  const text=String(raw??'').trim();
  if(!text) return {ok:false,error:'Enter H K L as three space-separated values.'};
  if(text.includes(',')) return {ok:false,error:'Commas are not allowed. Enter H K L with spaces.'};
  const parts=text.split(/\s+/).filter(Boolean);
  if(parts.length!==3) return {ok:false,error:'br requires exactly three space-separated values: H K L.'};
  const components=[], textRefs=[];
  for(const token of parts){
    const expr=parseTimeMathExpression(token,row,{allowLoopReference:true});
    if(!expr.ok) return {ok:false,error:`Each br HKL value must be a numeric expression. ${expr.error||''}`.trim()};
    components.push({
      ok:true,fixed:true,count:1,value:expr.refs.length?null:expr.value,token,
      expression:expr,symbolic:expr.refs.length>0,textRefs:expr.refs
    });
    textRefs.push(...expr.refs);
  }
  return {ok:true,fixed:true,count:1,tuple:components,textRefs};
}

function parseTimeDetail(raw,command,row=null){
  if(command==='br') return parseBrHklDetail(raw,row);
  const kind=timeCommandMeta(command).kind;
  if(kind==='scan') return parseTimeRange(raw,row,{allowLoopReference:true});
  if(kind==='loop'){
    const parsed=parseTimeRange(raw,row,{allowLoopReference:false});
    if(!parsed.ok) return parsed;
    if(parsed.fixed) return {ok:false,error:'loop requires three space-separated values: initial final step.'};
    return parsed;
  }
  if(kind==='endloop') return {ok:true,fixed:true,count:1,value:null};
  const text=String(raw??'').trim();
  // drive/driverel/count-style single-value fields use the same arithmetic
  // expression parser as scan fixed values.  This intentionally accepts
  // expressions such as loop1-1, (loop2+1)/6, or 4/6 while preserving the
  // binding to the enclosing loop pair when rows are reordered.
  const expression=parseTimeMathExpression(text,row,{allowLoopReference:true});
  if(!expression.ok){
    return {ok:false,error:`Enter one numeric expression${row?' using loopN if needed':''}. ${expression.error||''}`.trim()};
  }
  return {
    ok:true,fixed:true,count:1,value:expression.refs.length?null:expression.value,
    expression,expressionText:text,symbolic:expression.refs.length>0,
    textRefs:expression.refs
  };
}

function validateTimeRangeInput(input){
  const row=input?.closest?.('.time-scan-row') || null;
  const command=row?.querySelector('[data-time-variable]')?.value || 's1';
  if(input?.dataset.timeLoopRefBroken==='1'){
    const broken={ok:false,error:'The referenced loop is no longer an enclosing loop. Re-enter loop1, loop2, ... for the new nesting.'};
    setTimeInputInvalid(input,true);
    return broken;
  }
  const parsed=parseTimeDetail(input?.value,command,row);
  if(input){
    if(parsed.ok && Array.isArray(parsed.textRefs) && parsed.textRefs.length){
      input.dataset.timeLoopTextPairs=JSON.stringify(parsed.textRefs.map(ref=>({pair:ref.pair,level:ref.level})));
      delete input.dataset.timeLoopRefPair;
      delete input.dataset.timeLoopRefPairs;
    }else if(timeCommandMeta(command).target==='br' && parsed.ok && Array.isArray(parsed.tuple)){
      const refs=parsed.tuple.map((item,tokenIndex)=>item.symbolic && item.loopRow?.dataset.timeLoopPair ? {tokenIndex,pair:item.loopRow.dataset.timeLoopPair} : null).filter(Boolean);
      if(refs.length) input.dataset.timeLoopRefPairs=JSON.stringify(refs);
      else delete input.dataset.timeLoopRefPairs;
      delete input.dataset.timeLoopRefPair;
    }else if(parsed.ok && parsed.symbolic && parsed.loopRow?.dataset.timeLoopPair){
      input.dataset.timeLoopRefPair=parsed.loopRow.dataset.timeLoopPair;
      delete input.dataset.timeLoopRefPairs;
    }else if(!parsed.symbolic){
      delete input.dataset.timeLoopRefPair;
      delete input.dataset.timeLoopRefPairs;
      delete input.dataset.timeLoopTextPairs;
    }
  }
  setTimeInputInvalid(input,!parsed.ok);
  return parsed;
}

function validateTimeMcuInput(input){
  const raw=String(input?.value??'').trim();
  const value=Number(raw);
  const ok=raw!=='' && /^\d+$/.test(raw) && Number.isSafeInteger(value) && value>=0;
  setTimeInputInvalid(input,!ok);
  return {ok,value};
}

function clearTimeEstimateMessage(){
  const box=$('timeEstimateMessage');
  if(!box) return;
  box.textContent='';
  box.classList.remove('error-text','warning-text');
  if(currentGeometryCardTab()==='time') requestAnimationFrame(updateTimeScanScrollState);
}

function setTimeEstimateMessage(message,error=false,warning=false){
  const box=$('timeEstimateMessage');
  if(!box) return;
  box.textContent=message;
  box.classList.toggle('error-text',!!error);
  box.classList.toggle('warning-text',!error && !!warning);
  if(currentGeometryCardTab()==='time') requestAnimationFrame(updateTimeScanScrollState);
}

function readTimeScanRow(row,index){
  setTimeScanRowWarning(row,false);
  const command=row.querySelector('[data-time-variable]')?.value || 's1';
  const meta=timeCommandMeta(command);
  const rangeInputs=[...row.querySelectorAll('[data-time-range-key]')];
  const parsed=rangeInputs.map(input=>({input,key:input.dataset.timeRangeKey,parsed:validateTimeRangeInput(input)}));
  const timeInput=row.querySelector('[data-time-mcu]');
  const invalidRange=parsed.find(x=>!x.parsed.ok);
  if(invalidRange){
    setTimeScanRowWarning(row,true);
    return {ok:false,error:`Command ${index}: ${invalidRange.parsed.error}`};
  }

  let timeSeconds=0;
  const time=validateTimeMcuInput(timeInput);
  if(!time.ok){
    setTimeScanRowWarning(row,true);
    return {ok:false,error:`Command ${index}: ${meta.kind==='wait'?'wait time (s)':'MCU'} must be a non-negative whole number.`};
  }
  timeSeconds=time.value;

  const movingCounts=(meta.kind==='scan' || meta.kind==='loop') ? parsed.map(x=>x.parsed.count).filter(n=>n>1) : [];
  const unique=[...new Set(movingCounts)];
  if(unique.length>1){
    for(const x of parsed) if(x.parsed.count>1) setTimeInputInvalid(x.input,true);
    setTimeScanRowWarning(row,true);
    return {ok:false,error:`Command ${index}: ranged Detail values do not contain the same number of scan points.`};
  }
  const points=meta.kind==='scan' ? (unique[0]||1) : ((meta.kind==='loop' || meta.kind==='endloop') ? 0 : 1);
  const loopIterations=meta.kind==='loop' ? (parsed[0]?.parsed?.count || 1) : 1;
  if(command==='hkle' && !parsed.some(x=>x.parsed.symbolic)){
    const parsedByKey=Object.fromEntries(parsed.map(x=>[x.key,x.parsed]));
    const plane=validateHkleScanPlane(parsedByKey,points);
    if(!plane.ok){
      setTimeScanRowWarning(row,true);
      const where=plane.hkl ? ` (${plane.hkl.map(v=>Number(v.toPrecision(6))).join(', ')})` : '';
      const detail=plane.error ? ` ${plane.error}` : '';
      return {ok:false,error:`Command ${index}: HKL scan is outside the current U-V scattering plane${where}.${detail}`};
    }
  }
  const allDetailsFixed=meta.kind==='scan' && parsed.length>0 && parsed.every(x=>x.parsed.fixed);
  const forcedFixed=meta.kind!=='scan' || allDetailsFixed;
  return {
    ok:true,
    command,
    kind:meta.kind,
    points,
    loopIterations,
    loopLevel:Number(row.dataset.timeLoopLevel||0),
    mcuSeconds:timeSeconds,
    seconds:meta.kind==='wait' ? timeSeconds : points*timeSeconds,
    fixed:forcedFixed || !!row.querySelector('[data-time-fix]')?.checked
  };
}

function timeRangeValues(parsed){
  if(!parsed?.ok) return [];
  if(parsed.fixed) return [parsed.value];
  const values=[];
  const direction=parsed.final>=parsed.initial ? 1 : -1;
  for(let i=0;i<parsed.count;i++) values.push(parsed.initial+direction*parsed.step*i);
  return values;
}

function timeLoopContextsForRow(row,structure,maxContexts=50000){
  const parentLoops=structure.info.get(row)?.parentLoops||[];
  let contexts=[{}];
  for(const loopRow of parentLoops){
    const level=structure.info.get(loopRow)?.level||0;
    const input=loopRow.querySelector('[data-time-range-key="loop"]');
    const parsed=parseTimeDetail(input?.value,'loop',loopRow);
    if(!parsed.ok) return {ok:false,contexts:[]};
    const values=timeRangeValues(parsed);
    const next=[];
    for(const context of contexts){
      for(const value of values){
        next.push({...context,[level]:value});
        if(next.length>maxContexts) return {ok:false,contexts:[],tooMany:true};
      }
    }
    contexts=next;
  }
  return {ok:true,contexts};
}

function resolveTimeFixedValue(parsed,context){
  if(!parsed?.ok) return NaN;
  if(parsed.expression?.ok){
    const value=parsed.expression.evaluate(context||{});
    return Number.isFinite(value) ? value : NaN;
  }
  if(parsed.symbolic) return Number(context?.[parsed.loopRef]);
  return Number(parsed.value);
}

function timeDetailValueAt(parsed,index,context){
  if(parsed?.fixed) return resolveTimeFixedValue(parsed,context);
  return timeHklValueAt(parsed,index);
}

function timeEnergyForTransfer(hw){
  const transfer=Number(hw);
  const fixed=num('energy');
  const mode=$('energyMode')?.value || 'Ef fixed';
  if(!(fixed>0) || !Number.isFinite(transfer)) return null;
  const Ei=mode==='Ei fixed' ? fixed : fixed+transfer;
  const Ef=mode==='Ef fixed' ? fixed : fixed-transfer;
  if(!(Ei>0) || !(Ef>0)) return null;
  return {Ei,Ef};
}

function timeElasticIncidentEnergy(){
  const E=num('energy');
  return E>0 ? E : NaN;
}

function timeS2MagnitudeFromQ(q,hw){
  const energy=timeEnergyForTransfer(hw);
  if(!energy || !(Number(q)>=0)) return null;
  const ki=Math.sqrt(energy.Ei/2.072), kf=Math.sqrt(energy.Ef/2.072);
  const cosS2=(ki*ki+kf*kf-Number(q)*Number(q))/(2*ki*kf);
  if(cosS2<-1-1e-10 || cosS2>1+1e-10) return null;
  return {s2:Math.abs(rad2deg(Math.acos(clamp(cosS2,-1,1)))),Ei:energy.Ei};
}

function timeS2LimitAtEi(Ei){
  try{
    const inst=currentInstrument();
    const s2max=effectiveS2MaxAtEi(inst,Ei,false);
    return Number.isFinite(s2max) ? s2max : null;
  }catch(_e){ return null; }
}

function timeSignedS2FromMagnitude(s2){
  const mag=Math.abs(Number(s2));
  if(!Number.isFinite(mag)) return NaN;
  return legacyTasSense(checkedValue('sense'))==='+-+' ? -mag : mag;
}

function timePreviousBrS2(row,index,context,structure){
  const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')];
  const currentIndex=Math.max(0,Number(index)-1);
  for(let i=currentIndex-1;i>=0;i--){
    const candidate=rows[i];
    if(!candidate) continue;
    const command=candidate.querySelector('[data-time-variable]')?.value || 's1';
    if(command!=='br') continue;
    const input=candidate.querySelector('[data-time-range-key="hkl"]');
    const parsed=parseTimeDetail(input?.value,'br',candidate);
    if(!parsed.ok) continue;
    let rl;
    try{ rl=buildResolutionLattice().rl; }catch(_e){ return null; }
    const resolveIn=(ctx)=>{
      const tuple=parsed.tuple||[];
      const hkl=tuple.map(part=>resolveTimeFixedValue(part,ctx));
      if(hkl.length!==3 || hkl.some(v=>!Number.isFinite(v))) return null;
      const q=norm(hklToQ(rl,hkl));
      const calc=timeS2MagnitudeFromQ(q,0);
      if(!calc) return null;
      return {s2:timeSignedS2FromMagnitude(calc.s2),Ei:calc.Ei,hkl};
    };
    const direct=resolveIn(context);
    if(direct) return direct;
    const candidateContexts=timeLoopContextsForRow(candidate,structure);
    if(candidateContexts.ok && candidateContexts.contexts.length){
      for(let j=candidateContexts.contexts.length-1;j>=0;j--){
        const fallback=resolveIn(candidateContexts.contexts[j]);
        if(fallback) return fallback;
      }
    }
  }
  return null;
}

function timeRowS2LimitWarning(row,result,index,structure){
  const command=result.command;
  if(!['s2','rels2','th2th','qe','hkle','br'].includes(command)) return null;
  const contextResult=timeLoopContextsForRow(row,structure);
  if(!contextResult.ok) return contextResult.tooMany ? `Command ${index}: S2 limit check skipped because the enclosing loops expand beyond 50,000 combinations.` : null;

  const inputs=[...row.querySelectorAll('[data-time-range-key]')];
  const parsedByKey={};
  for(const input of inputs){
    const key=input.dataset.timeRangeKey;
    const parsed=parseTimeDetail(input.value,command,row);
    if(!parsed.ok) return null;
    parsedByKey[key]=parsed;
  }
  const points=Math.max(1,result.points||1);
  let worst=null;
  let rl=null;
  if(command==='hkle' || command==='br'){
    try{ rl=buildResolutionLattice().rl; }catch(_e){ return null; }
  }

  const consider=(s2,Ei,detail)=>{
    if(!Number.isFinite(s2)) return;
    const incident=Number.isFinite(Ei) ? Ei : timeElasticIncidentEnergy();
    const limit=timeS2LimitAtEi(incident);
    if(!Number.isFinite(limit)) return;
    const excess=Math.abs(s2)-limit;
    if(excess>1e-8 && (!worst || excess>worst.excess)) worst={s2:Math.abs(s2),limit,Ei:incident,excess,detail};
  };

  for(const context of contextResult.contexts){
    if(command==='br'){
      const tuple=parsedByKey.hkl?.tuple||[];
      const hkl=tuple.map(part=>resolveTimeFixedValue(part,context));
      if(hkl.length!==3 || hkl.some(v=>!Number.isFinite(v))) continue;
      const q=norm(hklToQ(rl,hkl));
      const calc=timeS2MagnitudeFromQ(q,0);
      if(calc) consider(calc.s2,calc.Ei,`HKL=(${hkl.map(v=>Number(v.toPrecision(6))).join(', ')})`);
      continue;
    }
    for(let point=0;point<points;point++){
      if(command==='s2' || command==='th2th'){
        const key=command==='s2'?'s2':'th2th';
        const value=timeDetailValueAt(parsedByKey[key],point,context);
        consider(Math.abs(value),timeElasticIncidentEnergy(),`${key}=${Number(value.toPrecision?.(6)??value)}`);
      }else if(command==='rels2'){
        const rel=timeDetailValueAt(parsedByKey.s2,point,context);
        const base=timePreviousBrS2(row,index,context,structure);
        if(!base || !Number.isFinite(rel)) continue;
        const finalS2=base.s2+rel;
        consider(finalS2,base.Ei,`previous br S2=${base.s2.toFixed(2)}°, rel S2=${Number(rel.toPrecision?.(6)??rel)}`);
      }else if(command==='qe'){
        const q=timeDetailValueAt(parsedByKey.q,point,context);
        const hw=timeDetailValueAt(parsedByKey.hw,point,context);
        const calc=timeS2MagnitudeFromQ(q,hw);
        if(calc) consider(calc.s2,calc.Ei,`Q=${Number(q.toPrecision(6))}, ħω=${Number(hw.toPrecision(6))}`);
      }else if(command==='hkle'){
        const hkl=['h','k','l'].map(key=>timeDetailValueAt(parsedByKey[key],point,context));
        const hw=timeDetailValueAt(parsedByKey.hw,point,context);
        if(hkl.some(v=>!Number.isFinite(v)) || !Number.isFinite(hw)) continue;
        const q=norm(hklToQ(rl,hkl));
        const calc=timeS2MagnitudeFromQ(q,hw);
        if(calc) consider(calc.s2,calc.Ei,`HKL=(${hkl.map(v=>Number(v.toPrecision(6))).join(', ')}), ħω=${Number(hw.toPrecision(6))}`);
      }
    }
  }
  if(!worst) return null;
  return `Command ${index}: S2=${worst.s2.toFixed(2)}° exceeds the instrument max ${worst.limit.toFixed(2)}° at Ei=${worst.Ei.toFixed(2)} meV (${worst.detail}).`;
}

function validateAllTimeScanRows({showMessage=false}={}){
  const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')];
  const results=[],errors=[],warnings=[];
  for(const row of rows) setTimeScanS2LimitWarning(row,false);
  const loopStack=[];
  for(let i=0;i<rows.length;i++){
    const result=readTimeScanRow(rows[i],i+1);
    results.push(result);
    if(!result.ok){ errors.push(result.error); continue; }
    if(result.kind==='loop') loopStack.push(i);
    else if(result.kind==='endloop'){
      if(!loopStack.length){
        setTimeScanRowWarning(rows[i],true);
        errors.push(`Command ${i+1}: endloop has no matching loop.`);
      }else loopStack.pop();
    }
  }
  for(const i of loopStack){
    setTimeScanRowWarning(rows[i],true);
    errors.push(`Command ${i+1}: loop has no matching endloop.`);
  }
  updateTimeLoopIndentation();
  if(!errors.length){
    const structure=ensureTimeLoopPairIds();
    let darkCache=null;
    if(checkedValue('sampleMode')==='single' && $('addDark')?.checked){
      try{ darkCache=singleCache || calculateSingleCrystal(); }catch(_e){ darkCache=null; }
    }
    for(let i=0;i<rows.length;i++){
      const result=results[i];
      if(!result?.ok || result.kind==='loop' || result.kind==='endloop') continue;
      const rowWarnings=timeRowMotionWarnings(rows[i],result,i+1,structure,darkCache);
      if(rowWarnings.length){
        warnings.push(...rowWarnings);
        setTimeScanS2LimitWarning(rows[i],true,rowWarnings.join(' / '));
      }
    }
  }
  if(showMessage){
    if(errors.length) setTimeEstimateMessage(errors.join(' / '),true);
    else if(warnings.length) setTimeEstimateMessage(`Warning: ${warnings.join(' / ')}`,false,true);
    else clearTimeEstimateMessage();
  }
  return {ok:errors.length===0,rows,results,errors,warnings};
}

function pad2(v){ return String(v).padStart(2,'0'); }
function ceilDateToMinute(date){
  const d=new Date(date.getTime());
  if(d.getSeconds()!==0 || d.getMilliseconds()!==0) d.setMinutes(d.getMinutes()+1);
  d.setSeconds(0,0);
  return d;
}
function timeEstimateDatePartIds(prefix){
  return {
    date:`timeEstimate${prefix}Date`,
    hour:`timeEstimate${prefix}Hour`,
    minute:`timeEstimate${prefix}Minute`
  };
}
function writeTimeEstimateDate(prefix,date){
  const ids=timeEstimateDatePartIds(prefix);
  const dateInput=$(ids.date), hourInput=$(ids.hour), minuteInput=$(ids.minute);
  if(dateInput) dateInput.value=`${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}`;
  if(hourInput) hourInput.value=pad2(date.getHours());
  if(minuteInput) minuteInput.value=pad2(date.getMinutes());
  for(const input of [dateInput,hourInput,minuteInput]) setTimeInputInvalid(input,false);
  saveTimeEstimateState();
}
function normalizeTimeDigits(input,max){
  if(!input) return;
  let value=String(input.value||'').replace(/\D/g,'').slice(0,2);
  input.value=value;
  if(value==='') return;
  const n=Number(value);
  if(Number.isInteger(n) && n>=0 && n<=max) setTimeInputInvalid(input,false);
}
function readTimeEstimateDate(prefix,label){
  const ids=timeEstimateDatePartIds(prefix);
  const dateInput=$(ids.date), hourInput=$(ids.hour), minuteInput=$(ids.minute);
  const dateText=String(dateInput?.value||'').trim();
  const hourText=String(hourInput?.value||'').trim();
  const minuteText=String(minuteInput?.value||'').trim();
  const dateMatch=/^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  const hour=Number(hourText), minute=Number(minuteText);
  const dateOk=!!dateMatch;
  const hourOk=/^\d{1,2}$/.test(hourText) && Number.isInteger(hour) && hour>=0 && hour<=23;
  const minuteOk=/^\d{1,2}$/.test(minuteText) && Number.isInteger(minute) && minute>=0 && minute<=59;
  setTimeInputInvalid(dateInput,!dateOk);
  setTimeInputInvalid(hourInput,!hourOk);
  setTimeInputInvalid(minuteInput,!minuteOk);
  if(!dateOk || !hourOk || !minuteOk) return {ok:false,error:`Enter a valid ${label} (24-hour HH:MM).`};
  const year=Number(dateMatch[1]), month=Number(dateMatch[2]), day=Number(dateMatch[3]);
  const date=new Date(year,month-1,day,hour,minute,0,0);
  const exact=date.getFullYear()===year && date.getMonth()===month-1 && date.getDate()===day && date.getHours()===hour && date.getMinutes()===minute;
  if(!exact){
    setTimeInputInvalid(dateInput,true);
    return {ok:false,error:`Enter a valid ${label}.`};
  }
  return {ok:true,date,dateInput,hourInput,minuteInput};
}
function setTimeEstimateStartToNow(){
  writeTimeEstimateDate('Start',ceilDateToMinute(new Date()));
  clearTimeEstimateMessage();
}
function formatEstimatedDuration(seconds){
  const s=Math.max(0,Math.ceil(seconds));
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  const parts=[];
  if(h) parts.push(`${h} h`);
  if(m || h) parts.push(`${m} min`);
  parts.push(`${sec} s`);
  return parts.join(' ');
}

function calculateTimeEstimate(){
  clearTimeEstimateMessage();
  const scanData=readAllTimeScans();
  if(!scanData.ok){ setTimeEstimateMessage(scanData.error,true); return; }
  const startResult=readTimeEstimateDate('Start','scan start time');
  if(!startResult.ok){ setTimeEstimateMessage(startResult.error,true); return; }
  const endExact=new Date(startResult.date.getTime()+scanData.totalSeconds*1000);
  const endDisplay=ceilDateToMinute(endExact);
  writeTimeEstimateDate('End',endDisplay);
  saveTimeEstimateState();
  setTimeEstimateMessage(`Estimated duration: ${formatEstimatedDuration(scanData.totalSeconds)} / ${scanData.totalPoints} execution step${scanData.totalPoints===1?'':'s'} in ${scanData.rows.length} command${scanData.rows.length===1?'':'s'}.`);
}

function readAllTimeScans(){
  const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')];
  if(!rows.length) return {ok:false,error:'Add at least one command.'};
  const validation=validateAllTimeScanRows();
  if(!validation.ok) return {ok:false,error:validation.errors.join(' / ')};

  const scans=[];
  const stack=[];
  let multiplier=1,totalSeconds=0,totalPoints=0;

  for(let i=0;i<rows.length;i++){
    const result=validation.results[i];
    if(result.kind==='loop'){
      const iterations=result.loopIterations||1;
      stack.push({rowIndex:i+1,iterations,previousMultiplier:multiplier});
      multiplier*=iterations;
      if(!Number.isFinite(multiplier) || multiplier>Number.MAX_SAFE_INTEGER){
        setTimeScanRowWarning(rows[i],true);
        return {ok:false,error:`Command ${i+1}: loop nesting produces too many repetitions.`};
      }
      continue;
    }
    if(result.kind==='endloop'){
      const opened=stack.pop();
      if(!opened){
        setTimeScanRowWarning(rows[i],true);
        return {ok:false,error:`Command ${i+1}: endloop has no matching loop.`};
      }
      multiplier=opened.previousMultiplier;
      continue;
    }

    const effectiveSeconds=result.seconds*multiplier;
    const effectivePoints=result.points*multiplier;
    scans.push({row:rows[i],...result,loopMultiplier:multiplier,effectiveSeconds,effectivePoints});
    totalSeconds+=effectiveSeconds;
    totalPoints+=effectivePoints;
  }

  if(stack.length){
    const opened=stack[stack.length-1];
    setTimeScanRowWarning(rows[opened.rowIndex-1],true);
    return {ok:false,error:`Command ${opened.rowIndex}: loop has no matching endloop.`};
  }
  return {ok:true,rows,scans,totalSeconds,totalPoints};
}

function validTimeEstimateDateInput(prefix,label){
  return readTimeEstimateDate(prefix,label);
}

function formatScaledMcu(value){
  if(!Number.isFinite(value)) return '';
  // Calc MCU must never round upward past the available time.  Display the
  // rescaled scan time as an integer number of seconds by truncating downward.
  return String(Math.floor(Math.max(0,value)));
}

function calculateTimeEstimateMcu(){
  clearTimeEstimateMessage();
  const scanData=readAllTimeScans();
  if(!scanData.ok){ setTimeEstimateMessage(scanData.error,true); return; }
  const startResult=validTimeEstimateDateInput('Start','scan start time');
  if(!startResult.ok){ setTimeEstimateMessage(startResult.error,true); return; }
  const endResult=validTimeEstimateDateInput('End','scan finish time');
  if(!endResult.ok){ setTimeEstimateMessage(endResult.error,true); return; }
  const targetSeconds=(endResult.date.getTime()-startResult.date.getTime())/1000;
  if(!(targetSeconds>0)){
    for(const input of [endResult.dateInput,endResult.hourInput,endResult.minuteInput]) setTimeInputInvalid(input,true);
    setTimeEstimateMessage('Scan finish must be later than scan start.',true);
    return;
  }

  const fixedScans=scanData.scans.filter(scan=>scan.fixed);
  const adjustableScans=scanData.scans.filter(scan=>!scan.fixed);
  const fixedSeconds=fixedScans.reduce((sum,scan)=>sum+scan.effectiveSeconds,0);
  const adjustableSeconds=adjustableScans.reduce((sum,scan)=>sum+scan.effectiveSeconds,0);
  const remainingSeconds=targetSeconds-fixedSeconds;
  const eps=1e-9;

  if(remainingSeconds < -eps){
    setTimeEstimateMessage(`Fixed commands already require ${formatEstimatedDuration(fixedSeconds)}, which exceeds the available ${formatEstimatedDuration(targetSeconds)}.`,true);
    return;
  }
  if(!adjustableScans.length){
    const difference=Math.abs(targetSeconds-fixedSeconds);
    if(difference<=0.01) setTimeEstimateMessage('All adjustable scan times are fixed. The current times already match the requested finish time.');
    else setTimeEstimateMessage('There are no unfixed scan times available to adjust.',true);
    return;
  }
  if(!(adjustableSeconds>0)){
    if(remainingSeconds<=eps){
      for(const scan of adjustableScans){
        const input=scan.row.querySelector('[data-time-mcu]');
        if(input) input.value='0';
      }
      saveTimeEstimateState();
      setTimeEstimateMessage('Unfixed scan t (s) values set to 0; fixed commands use the full available time.');
      return;
    }
    setTimeEstimateMessage('At least one unfixed scan t (s) value must be greater than zero to use the entered times as relative weights.',true);
    return;
  }

  const scale=Math.max(0,remainingSeconds)/adjustableSeconds;
  for(const scan of adjustableScans){
    const input=scan.row.querySelector('[data-time-mcu]');
    if(!input) continue;
    input.value=formatScaledMcu(scan.mcuSeconds*scale);
    setTimeInputInvalid(input,false);
  }
  // Fixed rows remain untouched. Every unfixed MCU is multiplied by the same
  // scale factor, preserving the relative weighting among adjustable scans.
  saveTimeEstimateState();
  const updated=readAllTimeScans();
  const actual=updated.ok?updated.totalSeconds:targetSeconds;
  setTimeEstimateMessage(`Unfixed scan t (s) values scaled by ×${Number(scale.toPrecision(6))}; ${fixedScans.length} fixed command${fixedScans.length===1?'':'s'} unchanged. Target duration: ${formatEstimatedDuration(targetSeconds)}; calculated duration: ${formatEstimatedDuration(actual)}.`);
}

function initializeTimeEstimateUI(){
  $('geometryTabAngles')?.addEventListener('click',()=>setGeometryCardTab('angles'));
  $('geometryTabTime')?.addEventListener('click',()=>setGeometryCardTab('time'));
  $('timeAddScan')?.addEventListener('click',event=>{ event.stopPropagation(); addTimeScanAfterSelection(); });
  $('timeCopyScan')?.addEventListener('click',event=>{ event.stopPropagation(); copySelectedOrLastTimeScanRows(); });
  $('timeRemoveScan')?.addEventListener('click',event=>{ event.stopPropagation(); removeSelectedTimeScanRows(); });
  $('timeEstimateCalc')?.addEventListener('click',calculateTimeEstimate);
  $('timeEstimateCalcMcu')?.addEventListener('click',calculateTimeEstimateMcu);
  $('timeEstimateNow')?.addEventListener('click',setTimeEstimateStartToNow);
  for(const id of ['timeMcuSecondsPerUnit','timeMovementPercent']){
    $(id)?.addEventListener('input',()=>{ saveTimeEstimateState(); clearTimeEstimateMessage(); });
    $(id)?.addEventListener('change',()=>{
      saveTimeEstimateState();
      const settings=v57ReadTimeSettings();
      if(!settings.ok) setTimeEstimateMessage(settings.error,true);
      else validateAllTimeScanRows({showMessage:true});
    });
  }
  window.addEventListener('resize',()=>{if(currentGeometryCardTab()==='time'){updateTimeScanScrollState();}});
  $('timeFixAll')?.addEventListener('click',event=>event.stopPropagation());
  $('timeFixAll')?.addEventListener('change',applyTimeFixHeader);
  const scanWrap=document.querySelector('#geometryTimePane .time-scan-table-wrap');
  scanWrap?.addEventListener('dragover',updateTimeScanDragTarget);
  scanWrap?.addEventListener('drop',finishTimeScanDrop);
  scanWrap?.addEventListener('dragleave',event=>{
    if(!timeScanDragState) return;
    if(event.relatedTarget && scanWrap.contains(event.relatedTarget)) return;
    clearTimeScanDragMarkers();
    timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
    timeScanDragState.target=null;
  });
  document.addEventListener('click',event=>{
    if(!selectedTimeScanRows().length) return;
    if(event.target.closest?.('.time-scan-table-wrap')) return;
    clearTimeScanSelection();
  });
  for(const id of ['a','b','c','alpha','beta','gamma','Uh','Uk','Ul','Vh','Vk','Vl','instrument','energy','energyMode','S2maxUser','S2maxEffective']){
    $(id)?.addEventListener('change',()=>{
      const scriptActive=$('tabScript')?.classList.contains('active');
      if(currentGeometryCardTab()==='time' || scriptActive) validateAllTimeScanRows({showMessage:true});
    });
  }
  for(const prefix of ['Start','End']){
    const ids=timeEstimateDatePartIds(prefix);
    $(ids.date)?.addEventListener('input',()=>{ setTimeInputInvalid($(ids.date),false); clearTimeEstimateMessage(); saveTimeEstimateState(); });
    $(ids.hour)?.addEventListener('input',()=>{ normalizeTimeDigits($(ids.hour),23); clearTimeEstimateMessage(); saveTimeEstimateState(); });
    $(ids.minute)?.addEventListener('input',()=>{ normalizeTimeDigits($(ids.minute),59); clearTimeEstimateMessage(); saveTimeEstimateState(); });
    $(ids.hour)?.addEventListener('blur',()=>{ const input=$(ids.hour); if(input?.value!=='') input.value=pad2(Number(input.value)); readTimeEstimateDate(prefix,`${prefix.toLowerCase()} time`); saveTimeEstimateState(); });
    $(ids.minute)?.addEventListener('blur',()=>{ const input=$(ids.minute); if(input?.value!=='') input.value=pad2(Number(input.value)); readTimeEstimateDate(prefix,`${prefix.toLowerCase()} time`); saveTimeEstimateState(); });
    $(ids.date)?.addEventListener('change',()=>{ readTimeEstimateDate(prefix,`${prefix.toLowerCase()} time`); saveTimeEstimateState(); });
  }
  const restored=restoreTimeEstimateState();
  if(!restored){
    if(!$('timeScanRows')?.children.length) addTimeScanRow({variable:'s1'});
    if(!$('timeEstimateStartDate')?.value) setTimeEstimateStartToNow();
    setGeometryCardTab('angles');
    saveTimeEstimateState();
  }
}


// ==================== SPICE macro script ====================
let timeEstimateHomeParent=null;
let timeEstimateHomeNextSibling=null;
const SPICE_SCRIPT_STORAGE_KEY='tas-simulator-spice-script-v1';
const SPICE_LOOP_VARS=['i','j','k','l','m','n','p','q','r','s','t','u','v','w','x','y','z'];

function mountTimeEstimateForScript(active){
  const pane=$('geometryTimePane');
  if(!pane) return;
  const infoRow=pane.querySelector('.time-info-row');
  const commandActions=document.querySelector('.script-command-actions');
  const asetToggle=$('scriptAsetToggle');
  if(!timeEstimateHomeParent){
    timeEstimateHomeParent=pane.parentElement;
    timeEstimateHomeNextSibling=pane.nextSibling;
  }
  if(active){
    const mount=$('scriptTimeMount');
    if(mount && pane.parentElement!==mount) mount.appendChild(pane);
    if(infoRow && commandActions && asetToggle && infoRow.parentElement!==commandActions){
      infoRow.classList.add('time-info-row-inline');
      commandActions.insertBefore(infoRow,asetToggle);
    }
    pane.classList.remove('hidden');
    requestAnimationFrame(()=>{
      updateTimeScanScrollState();
      validateAllTimeScanRows({showMessage:true});
    });
  }else{
    if(infoRow && infoRow.parentElement!==pane){
      infoRow.classList.remove('time-info-row-inline');
      pane.insertBefore(infoRow,pane.firstChild);
    }
    if(timeEstimateHomeParent && pane.parentElement!==timeEstimateHomeParent){
      if(timeEstimateHomeNextSibling && timeEstimateHomeNextSibling.parentNode===timeEstimateHomeParent){
        timeEstimateHomeParent.insertBefore(pane,timeEstimateHomeNextSibling);
      }else timeEstimateHomeParent.appendChild(pane);
    }
    pane.classList.toggle('hidden',currentGeometryCardTab()!=='time');
  }
}

function scriptMessage(message,error=false,warning=false){
  const box=$('scriptMessage');
  if(!box) return;
  box.textContent=message||'';
  box.classList.toggle('error-text',!!error);
  box.classList.toggle('warning-text',!error && !!warning);
}

function spiceLoopVar(level){
  const index=Math.max(0,Number(level||1)-1);
  return SPICE_LOOP_VARS[index] || `v${level}`;
}

function spiceDetailToken(token,row=null){
  const text=String(token??'').trim();
  // Time estimate expressions may contain loop references inside arithmetic,
  // e.g. 4/6+(loop1-1)*1/6.  SPICE expects the active loop variable form
  // (%i, %j, ...), so translate every embedded loopN reference, not only a
  // token that consists solely of loopN.
  return text.replace(/\bloop([1-9]\d*)\b/gi,(match,levelText)=>{
    const level=Number(levelText);
    if(row){
      const ref=parseTimeLoopReferenceToken(`loop${level}`,row);
      if(!ref?.ok) throw new Error(ref?.error||`${match} is not available at this command.`);
      return `%${spiceLoopVar(ref.loopRef)}`;
    }
    return `%${spiceLoopVar(level)}`;
  });
}

function spiceDetailTokens(value,row=null){
  return String(value??'').trim().split(/\s+/).filter(Boolean).map(token=>spiceDetailToken(token,row));
}

function spiceNameForDetailKey(key){
  return key==='hw' ? 'e' : key;
}

function generateSpiceMacroFromTimeEstimate(){
  const validation=validateAllTimeScanRows({showMessage:true});
  if(!validation.ok) throw new Error(validation.errors.join(' / '));
  const structure=ensureTimeLoopPairIds();
  const lines=[];
  const pushLine=(info,text)=>{
    const depth=Math.max(0,Number(info?.depth)||0);
    lines.push(`${' '.repeat(depth)}${text}`);
  };
  for(const row of structure.rows){
    const command=row.querySelector('[data-time-variable]')?.value || 's1';
    const meta=timeCommandMeta(command);
    const info=structure.info.get(row);
    if(meta.kind==='loop'){
      const input=row.querySelector('[data-time-range-key="loop"]');
      const values=spiceDetailTokens(input?.value);
      if(values.length!==3) throw new Error(`loop${info?.level||1} requires initial final step.`);
      pushLine(info,`loop ${spiceLoopVar(info?.level||1)}=${values.join(',')}`);
      continue;
    }
    if(meta.kind==='endloop'){
      pushLine(info,'endloop');
      continue;
    }
    if(meta.kind==='wait'){
      const t=row.querySelector('[data-time-mcu]')?.value || '0';
      pushLine(info,`wait ${t}`);
      continue;
    }
    const inputs=[...row.querySelectorAll('[data-time-range-key]')];
    const details=inputs.map(input=>({key:input.dataset.timeRangeKey,tokens:spiceDetailTokens(input.value)}));
    const ranged=details.some(item=>item.tokens.length===3);
    const t=row.querySelector('[data-time-mcu]')?.value || '0';

    if(meta.kind==='drive'){
      if(command==='br'){
        const hkl=details[0]?.tokens||[];
        if(hkl.length!==3) throw new Error('br requires H K L.');
        pushLine(info,`br ${hkl.join(' ')}`);
        continue;
      }
      const token=details[0]?.tokens?.[0];
      if(token===undefined) throw new Error(`${command} requires a target value.`);
      pushLine(info,`drive ${command} ${token}`);
      continue;
    }

    if(!ranged){
      if(command==='rels1' || command==='rels2'){
        const axis=command==='rels1'?'s1':'s2';
        pushLine(info,`drel ${axis} ${details[0].tokens[0]}`);
      }else if(command==='qe'){
        const byKey=Object.fromEntries(details.map(x=>[x.key,x.tokens[0]]));
        pushLine(info,`drive q ${byKey.q} e ${byKey.hw}`);
      }else if(command==='hkle'){
        const byKey=Object.fromEntries(details.map(x=>[x.key,x.tokens[0]]));
        pushLine(info,`drive h ${byKey.h} k ${byKey.k} l ${byKey.l} e ${byKey.hw}`);
      }else{
        const name=command==='th2th'?'th2th':command;
        pushLine(info,`drive ${name} ${details[0].tokens[0]}`);
      }
      continue;
    }

    if(command==='th2th'){
      // SPICE th2th is its own scan-style command; it is not prefixed by `scan`.
      pushLine(info,`th2th ${details[0].tokens.join(' ')}`);
      continue;
    }
    const scanCommand=(command==='rels1'||command==='rels2')?'scanrel':'scan';
    const pieces=[scanCommand];
    if(command==='rels1'||command==='rels2'){
      pieces.push(command==='rels1'?'s1':'s2',...details[0].tokens);
    }else{
      for(const detail of details) pieces.push(spiceNameForDetailKey(detail.key),...detail.tokens);
    }
    pieces.push('preset','mcu',String(t));
    pushLine(info,pieces.join(' '));
  }
  return lines.join('\n');
}

function spiceTokenToTime(token,loopStack){
  const text=String(token??'').trim();
  return text.replace(/%([A-Za-z][A-Za-z0-9_]*)\b/g,(_match,name)=>{
    const index=loopStack.indexOf(name);
    if(index<0) throw new Error(`Loop variable %${name} is not active here.`);
    return `loop${index+1}`;
  });
}

function parseSpiceVariableGroups(tokens,loopStack){
  const names=new Set(['s1','s2','th2th','q','e','h','k','l']);
  const groups=[];
  let i=0;
  while(i<tokens.length){
    const name=String(tokens[i]||'').toLowerCase();
    if(!names.has(name)) throw new Error(`Unknown scan variable: ${tokens[i]||''}`);
    i++;
    const values=[];
    while(i<tokens.length && !names.has(String(tokens[i]).toLowerCase())) values.push(spiceTokenToTime(tokens[i++],loopStack));
    if(values.length!==1 && values.length!==3) throw new Error(`${name} must have one value or initial final step.`);
    groups.push({name,values});
  }
  return groups;
}

function parseSpiceMacroToRows(text){
  const rows=[];
  const loopStack=[];
  const lines=String(text??'').split(/\r?\n/);
  for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
    const raw=lines[lineIndex].trim();
    if(!raw || raw.startsWith('#') || raw.startsWith(';')) continue;
    const lower=raw.toLowerCase();
    let match;
    if((match=/^loop\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^,]+),([^,]+),([^,]+)\s*$/i.exec(raw))){
      const variable=match[1];
      if(loopStack.includes(variable)) throw new Error(`Line ${lineIndex+1}: loop variable ${variable} is already active.`);
      loopStack.push(variable);
      rows.push({command:'loop',ranges:{loop:`${match[2].trim()} ${match[3].trim()} ${match[4].trim()}`},mcu:'0',fixed:true});
      continue;
    }
    if(/^endloop\s*$/i.test(raw)){
      if(!loopStack.length) throw new Error(`Line ${lineIndex+1}: endloop has no matching loop.`);
      loopStack.pop();
      rows.push({command:'endloop',ranges:{},mcu:'0',fixed:true});
      continue;
    }
    if((match=/^wait\s+(\d+)\s*$/i.exec(raw))){
      rows.push({command:'wait',ranges:{},mcu:match[1],fixed:true});
      continue;
    }
    if((match=/^br\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i.exec(raw))){
      rows.push({command:'br',ranges:{hkl:[match[1],match[2],match[3]].map(v=>spiceTokenToTime(v,loopStack)).join(' ')},mcu:'0',fixed:true});
      continue;
    }
    if((match=/^th2th\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i.exec(raw))){
      // The compact th2th syntax does not carry a counting preset. Use 1 s/point on import.
      rows.push({command:'th2th',ranges:{th2th:[match[1],match[2],match[3]].map(v=>spiceTokenToTime(v,loopStack)).join(' ')},mcu:'1',fixed:false});
      continue;
    }
    const parts=raw.split(/\s+/);
    const op=parts[0].toLowerCase();
    if(op==='drive' || op==='drel'){
      const rest=parts.slice(1);
      if(op==='drel'){
        if(rest.length!==2 || !['s1','s2'].includes(rest[0].toLowerCase())) throw new Error(`Line ${lineIndex+1}: unsupported drel command.`);
        const axis=rest[0].toLowerCase();
        rows.push({command:axis==='s1'?'rels1':'rels2',ranges:{[axis]:spiceTokenToTime(rest[1],loopStack)},mcu:'0',fixed:true});
        continue;
      }
      if(rest.length===2 && ['s1','s2','th2th','temp','field'].includes(rest[0].toLowerCase())){
        const name=rest[0].toLowerCase();
        const key=(name==='temp'||name==='field')?'target':name;
        rows.push({command:name,ranges:{[key]:spiceTokenToTime(rest[1],loopStack)},mcu:'0',fixed:true});
        continue;
      }
      const groups=parseSpiceVariableGroups(rest,loopStack);
      const byName=Object.fromEntries(groups.map(g=>[g.name,g.values.join(' ')]));
      const names=groups.map(g=>g.name);
      if(names.length===2 && names.includes('q') && names.includes('e')){
        rows.push({command:'qe',ranges:{q:byName.q,hw:byName.e},mcu:'0',fixed:true});
        continue;
      }
      if(['h','k','l','e'].every(n=>names.includes(n))){
        rows.push({command:'hkle',ranges:{h:byName.h,k:byName.k,l:byName.l,hw:byName.e},mcu:'0',fixed:true});
        continue;
      }
      throw new Error(`Line ${lineIndex+1}: unsupported drive command.`);
    }
    if(op==='scan' || op==='scanrel'){
      const presetIndex=parts.findIndex((token,index)=>index>0 && token.toLowerCase()==='preset');
      if(presetIndex<0 || String(parts[presetIndex+1]||'').toLowerCase()!=='mcu' || !/^\d+$/.test(String(parts[presetIndex+2]||'')) || presetIndex+3!==parts.length){
        throw new Error(`Line ${lineIndex+1}: scan must end with preset mcu <seconds>.`);
      }
      const t=parts[presetIndex+2];
      const groups=parseSpiceVariableGroups(parts.slice(1,presetIndex),loopStack);
      const byName=Object.fromEntries(groups.map(g=>[g.name,g.values.join(' ')]));
      const names=groups.map(g=>g.name);
      if(op==='scanrel'){
        if(groups.length!==1 || !['s1','s2'].includes(groups[0].name)) throw new Error(`Line ${lineIndex+1}: scanrel supports s1 or s2.`);
        const axis=groups[0].name;
        rows.push({command:axis==='s1'?'rels1':'rels2',ranges:{[axis]:byName[axis]},mcu:t,fixed:false});
        continue;
      }
      if(groups.length===1 && ['s1','s2','th2th'].includes(groups[0].name)){
        const name=groups[0].name;
        rows.push({command:name,ranges:{[name]:byName[name]},mcu:t,fixed:false});
        continue;
      }
      if(names.length===2 && names.includes('q') && names.includes('e')){
        rows.push({command:'qe',ranges:{q:byName.q,hw:byName.e},mcu:t,fixed:false});
        continue;
      }
      if(['h','k','l','e'].every(n=>names.includes(n))){
        rows.push({command:'hkle',ranges:{h:byName.h,k:byName.k,l:byName.l,hw:byName.e},mcu:t,fixed:false});
        continue;
      }
      throw new Error(`Line ${lineIndex+1}: unsupported scan command.`);
    }
    throw new Error(`Line ${lineIndex+1}: unsupported SPICE command.`);
  }
  if(loopStack.length) throw new Error('SPICE macro ends before all loops are closed.');
  if(!rows.length) throw new Error('No supported SPICE commands were found.');
  return rows;
}

function replaceTimeEstimateRows(rows){
  const host=$('timeScanRows');
  if(!host) return;
  host.replaceChildren();
  timeScanRowCounter=0;
  timeLoopPairCounter=0;
  for(const values of rows) addTimeScanRow(values,{suppressAutoPair:true});
  ensureTimeLoopPairIds();
  renumberTimeScanRows();
  clearTimeScanSelection();
  saveTimeEstimateState();
  validateAllTimeScanRows({showMessage:true});
}

async function copySpiceScript(){
  const text=$('scriptSpiceText')?.value||'';
  if(!text.trim()){ scriptMessage('There is no SPICE macro to copy.',true); return; }
  try{
    await navigator.clipboard.writeText(text);
    scriptMessage('SPICE macro copied to the clipboard.');
  }catch(_err){
    const area=$('scriptSpiceText');
    area?.focus(); area?.select();
    const ok=document.execCommand?.('copy');
    scriptMessage(ok?'SPICE macro copied to the clipboard.':'Clipboard copy was blocked by the browser.',!ok);
  }
}

function initializeScriptUI(){
  const area=$('scriptSpiceText');
  try{ if(area) area.value=localStorage.getItem(SPICE_SCRIPT_STORAGE_KEY)||''; }catch(_e){}
  area?.addEventListener('input',()=>{ try{localStorage.setItem(SPICE_SCRIPT_STORAGE_KEY,area.value);}catch(_e){} scriptMessage(''); });
  $('scriptToSpice')?.addEventListener('click',()=>{
    try{
      const text=generateSpiceMacroFromTimeEstimate();
      area.value=text;
      try{localStorage.setItem(SPICE_SCRIPT_STORAGE_KEY,text);}catch(_e){}
      scriptMessage('Converted Time estimate commands to SPICE.');
    }catch(err){ scriptMessage(err?.message||String(err),true); }
  });
  $('scriptToCommands')?.addEventListener('click',()=>{
    try{
      const rows=parseSpiceMacroToRows(area?.value||'');
      replaceTimeEstimateRows(rows);
      scriptMessage(`Converted ${rows.length} SPICE command rows to Time estimate commands.`);
    }catch(err){ scriptMessage(err?.message||String(err),true); }
  });
  $('scriptCopySpice')?.addEventListener('click',copySpiceScript);
}


// ==================== v42 Script command model / ASET ====================
const V42_TIME_OPERATIONS=['drive','driverel','scan','scanrel','scantitle'];
const V42_MOTOR_TARGETS=['ei','ef','e','s1','s2','hkle','br','qe','th2th'];
const V42_ASET_STORAGE_KEY='tas-simulator-spice-aset-v4';
const V51_ASET_COLLAPSED_STORAGE_KEY='tas-simulator-script-aset-collapsed-v1';
const V42_ASET_DEFAULTS={
  temperature:'drive vti <value>, drive sample <value>',
  field:'drive field <value>, drive ramp 1',
  field0:'drive zero 1'
};
let v42SpiceLineMap=[];
let v42SpiceErrorLines=new Set();
let v42SpiceWarningLines=new Set();
let v42LastSpiceValidation=null;
let v42SpiceAutoLinked=false;
let v42SpiceMutationObserver=null;

function v42EscapeHtml(value){
  return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function v42EscapeAttr(value){
  return v42EscapeHtml(value).replace(/"/g,'&quot;');
}
function v42InternalCommand(operation,target){
  const op=String(operation||'drive').toLowerCase();
  if(op==='scantitle' || op==='count' || op==='wait' || op==='loop' || op==='endloop') return op;
  const raw=String(target||'').trim();
  const t=v49CanonicalMotorTarget(raw);
  const allowed=v42AllTargets();
  return `${op}:${allowed.includes(t)?t:'s1'}`;
}
function v42CommandParts(command){
  const raw=String(command||'drive:s1').trim();
  const lower=raw.toLowerCase();
  if(lower==='scantitle' || lower==='count' || lower==='wait' || lower==='loop' || lower==='endloop') return {op:lower,target:''};
  const colon=raw.indexOf(':');
  if(colon>0){
    const op=raw.slice(0,colon).toLowerCase(), target=v49CanonicalMotorTarget(raw.slice(colon+1));
    if(['drive','driverel','scan','scanrel'].includes(op) && v42AllTargets().includes(target)) return {op,target};
  }
  return {op:'drive',target:'s1'};
}
function v42DetailsLookRanged(ranges){
  return Object.values(ranges||{}).some(value=>String(value??'').trim().split(/\s+/).filter(Boolean).length===3);
}
function v42NormalizeStoredRow(values={}){
  let ranges={...(values.ranges||values.details||{})};
  const requestedRaw=String(values.command??values.variable??'s1').trim();
  const requested=requestedRaw.toLowerCase();
  if(/^(drive|driverel|scan|scanrel):/i.test(requestedRaw)){
    const parts=v42CommandParts(requestedRaw);
    if(parts.op==='drive' && parts.target==='br' && ranges.hkl===undefined){
      const compact=[ranges.h,ranges.k,ranges.l].filter(value=>value!==undefined).join(' ').trim();
      if(compact) ranges={hkl:compact};
    }
    return {operation:values.operation||parts.op,target:values.target||parts.target,ranges,migrationWarning:values.migrationWarning||''};
  }
  if(requested==='scantitle' || requested==='count' || requested==='wait' || requested==='loop' || requested==='endloop') return {operation:requested,target:'',ranges};
  const ranged=v42DetailsLookRanged(ranges);
  if(requested==='s1' || requested==='s2') return {operation:ranged?'scan':'drive',target:requested,ranges};
  if(requested==='rels1' || requested==='rels2') return {operation:ranged?'scanrel':'driverel',target:requested.endsWith('1')?'s1':'s2',ranges};
  if(requested==='hkle') return {operation:ranged?'scan':'drive',target:'hkle',ranges};
  if(requested==='temp') return {operation:'drive',target:'temperature',ranges:{target:ranges.target??ranges.temperature??''}};
  if(requested==='field') return {operation:'drive',target:'field',ranges:{target:ranges.target??ranges.field??''}};
  if(requested==='br'){
    let compact=String(ranges.hkl??ranges.target??'').trim();
    if(!compact) compact=[ranges.h,ranges.k,ranges.l].filter(value=>value!==undefined).join(' ').trim();
    return {operation:'drive',target:'br',ranges:{hkl:compact}};
  }
  if(requested==='th2th') return {operation:ranged?'scan':'drive',target:'s2',ranges:{s2:ranges.th2th??ranges.s2??''},migrationWarning:'Legacy th2th was migrated to S2. Verify the intended motor before running.'};
  if(requested==='qe') return {operation:ranged?'scan':'drive',target:'e',ranges:{hw:ranges.hw??ranges.e??''},migrationWarning:'Legacy QE cannot be represented by the new target list because Q is not a selectable target. Recreate this command as HKLE before use.'};
  return {operation:'drive',target:'s1',ranges};
}
function v42SetInternalSelect(select,value){
  if(!select) return;
  select.innerHTML=`<option value="${v42EscapeAttr(value)}">${v42EscapeHtml(value)}</option><option value="loop">loop</option><option value="endloop">endloop</option><option value="wait">wait</option>`;
  select.value=value;
}
function v42OperationOptions(selected){
  const operations=['drive','driverel','scan','scanrel','scantitle','count','wait','loop'];
  const options=operations.map(op=>`<option value="${op}"${selected===op?' selected':''}>${op}</option>`).join('');
  const end=`<option value="endloop"${selected==='endloop'?' selected':' hidden disabled'}>endloop</option>`;
  return options+end;
}
function v42NormalizeTemplateSyntax(template){
  // v50: ASET templates use only <value> and <range>. Scan/scanrel timing is
  // supplied automatically from the Time estimate row's MCU. Migrate the
  // former count preset mcu <time> helper out of saved templates.
  return String(template??'')
    .replace(/count\s+preset\s+mcu\s*(?:<time>|\btime\b)/gi,'')
    .replace(/(?<!<)\b(value|range)\b(?!>)/gi,'<$1>');
}
function v42TemplateCommands(template){
  return v42NormalizeTemplateSyntax(template).split(/[,;\n]+/).map(x=>x.trim()).filter(Boolean);
}
function v42TemplatePlaceholders(template){
  const commands=v42TemplateCommands(template), out=[];
  let occurrence=0;
  for(const command of commands){
    const re=/<(value|range)>/gi; let m;
    while((m=re.exec(command))){
      const type=m[1].toLowerCase();
      const before=command.slice(0,m.index).trim();
      const words=before.match(/[A-Za-z][A-Za-z0-9_]*/g)||[];
      let label=words.length?words[words.length-1]:type;
      if(['drive','driverel','scan','scanrel','preset','mcu','count'].includes(label.toLowerCase())) label=type;
      out.push({type,label,key:`aset_${type}_${++occurrence}`});
    }
  }
  return out;
}
function v42TemplateUsesValue(template){ return v42TemplatePlaceholders(template).some(x=>x.type==='value'); }

function v42StoredAsetEntries(){
  try{
    const saved=JSON.parse(localStorage.getItem(V42_ASET_STORAGE_KEY)||'null');
    if(Array.isArray(saved?.entries)) return saved.entries;
  }catch(_e){}
  // Migrate the editable-template v3 list as a complete list.
  try{
    const old=JSON.parse(localStorage.getItem('tas-simulator-spice-aset-v3')||'null');
    if(Array.isArray(old?.entries) && old.entries.length) return old.entries;
  }catch(_e){}
  // Migrate v2 device-list ASETs into command templates.
  try{
    const old=JSON.parse(localStorage.getItem('tas-simulator-spice-aset-v2')||'null');
    if(Array.isArray(old?.entries)) return old.entries.map(item=>({
      key:item?.key,
      template:Array.isArray(item?.devices)?item.devices.map(d=>`drive ${d} <value>`).join(', '):''
    }));
  }catch(_e){}
  try{
    const old=JSON.parse(localStorage.getItem('tas-simulator-spice-aset-v1')||'null');
    if(old && typeof old==='object') return Object.entries(old).map(([key,devices])=>({
      key,template:Array.isArray(devices)?devices.map(d=>`drive ${d} <value>`).join(', '):''
    }));
  }catch(_e){}
  return [];
}
function v42AsetRowKey(row){
  return String(row?.querySelector?.('[data-aset-target]')?.value??row?.dataset?.asetKey??'').trim();
}
function v49CanonicalMotorTarget(value){
  const raw=String(value??'').trim();
  const lower=raw.toLowerCase();
  return V42_MOTOR_TARGETS.includes(lower)?lower:raw;
}

function v42AsetKeys(){
  const keys=new Set();
  for(const row of document.querySelectorAll('#scriptAsetList [data-aset-row]')){
    const key=v42AsetRowKey(row);
    if(/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && !V42_MOTOR_TARGETS.includes(key.toLowerCase())) keys.add(key);
  }
  if(!keys.size){
    for(const item of v42StoredAsetEntries()){
      const key=String(item?.key||'').trim();
      if(/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && !V42_MOTOR_TARGETS.includes(key.toLowerCase())) keys.add(key);
    }
  }
  if(!keys.size) for(const key of Object.keys(V42_ASET_DEFAULTS)) keys.add(key);
  return [...keys];
}
function v42AllTargets(){ return [...V42_MOTOR_TARGETS,...v42AsetKeys()]; }
function v42TargetsForOperation(operation){
  const op=String(operation||'drive').toLowerCase();
  if(['scantitle','count','wait','loop','endloop'].includes(op)) return [];
  const scanOnly=new Set(['qe','th2th']);
  return v42AllTargets().filter(t=>{
    // QE and th2th are dedicated scan targets. br is a positioning-only command.
    if(scanOnly.has(t)) return op==='scan';
    if(t==='br') return op==='drive';
    // Relative HKLE is not a supported SPICE operation, so do not offer it.
    if(t==='hkle' && (op==='driverel' || op==='scanrel')) return false;
    return true;
  });
}
function v42TargetOptions(selected,operation='drive'){
  const labels={ei:'Ei',ef:'Ef',e:'E',s1:'S1',s2:'S2',hkle:'HKLE',br:'br',qe:'QE',th2th:'th2th'};
  const targets=v42TargetsForOperation(operation);
  return `<option value="">—</option>`+targets.map(t=>`<option value="${v42EscapeAttr(t)}"${selected===t?' selected':''}>${v42EscapeHtml(labels[t]||t)}</option>`).join('');
}
function v42AsetTemplate(key){
  const target=String(key||'').trim();
  const row=[...document.querySelectorAll('#scriptAsetList [data-aset-row]')].find(r=>v42AsetRowKey(r)===target);
  const input=row?.querySelector('[data-aset-template]');
  if(input) return v42NormalizeTemplateSyntax(String(input.value||'').trim());
  const stored=v42StoredAsetEntries().find(item=>String(item?.key||'').trim()===target);
  if(stored?.template!==undefined) return v42NormalizeTemplateSyntax(String(stored.template||'').trim());
  const defaultKey=Object.prototype.hasOwnProperty.call(V42_ASET_DEFAULTS,target)?target:null;
  return v42NormalizeTemplateSyntax(String(defaultKey?V42_ASET_DEFAULTS[defaultKey]:'').trim());
}
function v42AsetEntries(){
  return [...document.querySelectorAll('#scriptAsetList [data-aset-row]')].map(row=>({
    key:v42AsetRowKey(row),
    template:v42NormalizeTemplateSyntax(String(row.querySelector('[data-aset-template]')?.value||'').trim())
  })).filter(item=>/^[A-Za-z][A-Za-z0-9_]*$/.test(item.key) && !V42_MOTOR_TARGETS.includes(item.key.toLowerCase()));
}
function v42RenumberAsetRows(){
  [...document.querySelectorAll('#scriptAsetList [data-aset-row]')].forEach((row,i)=>{
    const cell=row.querySelector('[data-aset-index]'); if(cell) cell.textContent=String(i+1);
  });
}
function v42RefreshTargetSelects(){
  document.querySelectorAll('#timeScanRows [data-time-target]').forEach(select=>{
    const row=select.closest('.time-scan-row');
    const operation=row?.querySelector('[data-time-operation]')?.value||'drive';
    const previous=select.value;
    const allowed=v42TargetsForOperation(operation);
    select.innerHTML=v42TargetOptions(previous,operation);
    if(allowed.includes(previous)) select.value=previous;
    else if(!select.disabled){ select.value=allowed.includes('s1')?'s1':(allowed[0]||''); }
    else select.value='';
  });
}
function v42CreateAsetRow(key='',template='',{removable=true}={}){
  const host=$('scriptAsetList'); if(!host) return null;
  const row=document.createElement('div');
  row.className='script-aset-item'; row.dataset.asetRow='1';
  row.innerHTML=`<span class="script-aset-index" data-aset-index></span>`+
    `<input type="text" data-aset-target value="${v42EscapeAttr(String(key||''))}" placeholder="target" spellcheck="false" aria-label="ASET target">`+
    `<textarea data-aset-template rows="2" placeholder="drive device <value>\nscan device <range>" spellcheck="false" aria-label="ASET SPICE template">${v42EscapeHtml(String(template||''))}</textarea>`+
    `${removable?'<button type="button" class="script-aset-remove" title="Remove ASET" aria-label="Remove ASET">×</button>':'<span></span>'}`;
  host.appendChild(row); v42RenumberAsetRows(); return row;
}
function v42SaveAset(){
  const payload={entries:v42AsetEntries()};
  try{ localStorage.setItem(V42_ASET_STORAGE_KEY,JSON.stringify(payload)); }catch(_e){}
}
function v42LoadAset(){
  const host=$('scriptAsetList'); if(!host) return;
  const entries=v42StoredAsetEntries();
  host.replaceChildren();
  if(entries.length){
    entries.forEach((item,index)=>{
      const key=String(item?.key||'').trim();
      if(!key || V42_MOTOR_TARGETS.includes(key.toLowerCase())) return;
      v42CreateAsetRow(key,v42NormalizeTemplateSyntax(String(item?.template||'')),{removable:true});
    });
  }else{
    for(const [key,template] of Object.entries(V42_ASET_DEFAULTS)) v42CreateAsetRow(key,template,{removable:true});
  }
  v42RenumberAsetRows();
}
function v42PromptAddAset(){
  const row=v42CreateAsetRow('','',{removable:true});
  row?.querySelector('[data-aset-target]')?.focus();
  scriptMessage('Added an empty ASET row. Enter Target and SPICE template directly in the list.');
}
function v42ValidateAsetRows(){
  const seen=new Set(); let ok=true, message='';
  for(const row of document.querySelectorAll('#scriptAsetList [data-aset-row]')){
    const key=v42AsetRowKey(row), target=row.querySelector('[data-aset-target]'), template=row.querySelector('[data-aset-template]');
    const validKey=/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && !V42_MOTOR_TARGETS.includes(key.toLowerCase()) && !seen.has(key);
    target?.classList.toggle('invalid',!validKey);
    if(validKey) seen.add(key); else if(!message) message=key?`ASET Target "${key}" is invalid or duplicated.`:'Enter an ASET Target name.';
    const validTemplate=v42TemplateCommands(template?.value).length>0;
    template?.classList.toggle('invalid',!validTemplate);
    if(!validTemplate && !message) message=`ASET ${key||'?'} needs at least one SPICE template command.`;
    ok=ok&&validKey&&validTemplate;
  }
  return {ok,message};
}

// Composite command metadata. Control rows remain standalone; motion rows are operation:target.
timeCommandMeta = function(command){
  const {op,target}=v42CommandParts(command);
  if(op==='scantitle') return {kind:'scantitle',op,target:'',specs:[{key:'title',label:'Title'}]};
  if(op==='count') return {kind:'count',op,target:'',specs:[]};
  if(op==='wait') return {kind:'wait',op,target:'',specs:[]};
  if(op==='loop') return {kind:'loop',op,target:'',specs:[{key:'loop',label:'Loop'}]};
  if(op==='endloop') return {kind:'endloop',op,target:'',specs:[]};
  const kind=(op==='scan' || op==='scanrel') ? 'scan' : 'drive';
  if(target==='qe') return {kind,op,target,specs:[{key:'q',label:'Q'},{key:'hw',label:'E'}]};
  if(target==='th2th') return {kind,op,target,specs:[{key:'th2th',label:'th2th'}]};
  if(target==='hkle') return {kind,op,target,specs:[{key:'h',label:'H'},{key:'k',label:'K'},{key:'l',label:'L'},{key:'hw',label:'E'}]};
  if(target==='br') return {kind:'drive',op:'drive',target,specs:[{key:'hkl',label:'HKL'}]};
  if(v42AsetKeys().includes(target)){
    const placeholders=v42TemplatePlaceholders(v42AsetTemplate(target));
    const specs=placeholders.map(p=>({key:p.key,label:p.label,placeholderType:p.type}));
    return {kind,op,target,aset:true,specs,placeholders};
  }
  const key=(target==='e')?'hw':target;
  const label={ei:'Ei',ef:'Ef',e:'E',s1:'S1',s2:'S2'}[target]||target;
  return {kind,op,target,specs:[{key,label:(op==='driverel'||op==='scanrel')?`rel ${label}`:label}]};
};

function v56ParseScantitleDetail(raw,row=null){
  const text=String(raw??'').trim();
  if(!text) return {ok:false,error:'Enter a scan title.'};
  const refs=[];
  const re=/\bloop([1-9]\d*)\b/gi;
  let match;
  while((match=re.exec(text))){
    if(!row) continue;
    const ref=parseTimeLoopReferenceToken(match[0],row);
    if(!ref?.ok) return ref || {ok:false,error:`${match[0]} is not available at this command.`};
    refs.push({pair:ref.loopRow?.dataset?.timeLoopPair||'',level:ref.loopRef});
  }
  return {ok:true,fixed:true,count:1,value:text,textRefs:refs};
}

parseTimeDetail = function(raw,command,row=null){
  const meta=timeCommandMeta(command);
  if(meta.kind==='scantitle') return v56ParseScantitleDetail(raw,row);
  if(meta.target==='br') return parseBrHklDetail(raw,row);
  if(meta.kind==='loop'){
    const parsed=parseTimeRange(raw,row,{allowLoopReference:false});
    if(!parsed.ok) return parsed;
    if(parsed.fixed) return {ok:false,error:'loop requires three space-separated values: initial final step.'};
    return parsed;
  }
  if(meta.kind==='endloop' || meta.kind==='wait' || meta.kind==='count') return {ok:true,fixed:true,count:1,value:null};
  if(meta.kind==='scan') return parseTimeRange(raw,row,{allowLoopReference:true});
  const text=String(raw??'').trim();
  const expr=parseTimeMathExpression(text,row,{allowLoopReference:true});
  if(!expr.ok) return {ok:false,error:`Enter one numeric expression${row?' using loopN if needed':''}. ${expr.error||''}`.trim()};
  return {
    ok:true,fixed:true,count:1,value:expr.refs.length?null:expr.value,
    expression:expr,expressionText:text,symbolic:expr.refs.length>0,textRefs:expr.refs
  };
};

updateTimeLoopCommandLabels = function(){
  const structure=ensureTimeLoopPairIds();
  for(const row of structure.rows){
    const internal=row.querySelector('[data-time-variable]');
    const opSelect=row.querySelector('[data-time-operation]');
    if(!internal || !opSelect) continue;
    const rowInfo=structure.info.get(row);
    const loopOption=[...opSelect.options].find(option=>option.value==='loop');
    const endOption=[...opSelect.options].find(option=>option.value==='endloop');
    const proposedLevel=(internal.value==='loop' && rowInfo?.level) ? rowInfo.level : Math.max(1,(rowInfo?.depth||0)+1);
    if(loopOption) loopOption.textContent=`loop${proposedLevel}`;
    if(endOption){
      endOption.textContent=(internal.value==='endloop' && rowInfo?.level) ? `endloop${rowInfo.level}` : 'endloop';
      endOption.disabled=internal.value!=='endloop';
      endOption.hidden=internal.value!=='endloop';
    }
    opSelect.disabled=internal.value==='endloop';
    opSelect.title=internal.value==='endloop' ? 'This endloop is paired automatically with its loop command.' : '';
  }
  return structure;
};

addTimeScanRow = function(values={},options={}){
  const host=$('timeScanRows');
  if(!host) return null;
  const normalized=v42NormalizeStoredRow(values);
  const row=document.createElement('div');
  row.className='time-scan-row';
  row.dataset.timeScanId=String(++timeScanRowCounter);
  const initialMcu=String(values.mcu??values.time??((normalized.operation==='wait'||normalized.operation==='count')?(values.ranges?.wait??values.details?.wait??values.mcu??values.time??'') : '')).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  row.innerHTML=`
    <div class="time-scan-cell time-scan-index" data-time-index></div>
    <div class="time-scan-cell time-command-cell">
      <select data-time-operation aria-label="Command">${v42OperationOptions(normalized.operation)}</select>
      <select data-time-variable class="time-internal-command" aria-hidden="true" tabindex="-1"></select>
    </div>
    <div class="time-scan-cell time-target-cell"><select data-time-target aria-label="Target">${v42TargetOptions(normalized.target,normalized.operation)}</select></div>
    <div class="time-scan-cell"><div class="time-range-inputs" data-time-range-host></div></div>
    <div class="time-scan-cell"><span class="time-mcu-entry"><input type="text" inputmode="numeric" data-time-mcu value="${initialMcu}" placeholder="0"></span></div>
    <div class="time-scan-cell time-fix-cell"><input type="checkbox" data-time-fix aria-label="Fix time for this command"></div>`;
  const before=options?.before;
  if(before && before.parentElement===host) host.insertBefore(row,before); else host.appendChild(row);
  const opSelect=row.querySelector('[data-time-operation]');
  const targetSelect=row.querySelector('[data-time-target]');
  const internal=row.querySelector('[data-time-variable]');
  const fix=row.querySelector('[data-time-fix]');
  if(fix) fix.checked=!!values.fixed;
  if(normalized.migrationWarning) row.dataset.timeMigrationWarning=normalized.migrationWarning;

  const syncControlState=()=>{
    const structural=['scantitle','count','wait','loop','endloop'].includes(opSelect.value);
    const previousTarget=targetSelect.value;
    const allowedTargets=v42TargetsForOperation(opSelect.value);
    targetSelect.innerHTML=v42TargetOptions(previousTarget,opSelect.value);
    targetSelect.disabled=structural;
    if(structural) targetSelect.value='';
    else if(allowedTargets.includes(previousTarget)) targetSelect.value=previousTarget;
    else targetSelect.value=allowedTargets.includes('s1')?'s1':(allowedTargets[0]||'');
    const value=v42InternalCommand(opSelect.value,targetSelect.value);
    v42SetInternalSelect(internal,value);
    return value;
  };
  const initialInternal=syncControlState();
  row.dataset.timeCommand=initialInternal;
  const initialTime=row.querySelector('[data-time-mcu]');
  if(initialTime && String(initialTime.value).trim()!=='' && Number.isFinite(parseNumericValue(initialTime.value))) initialTime.value=formatTimeMcuValue(initialTime.value);
  updateTimeScanRowFields(row,normalized.ranges);

  if(initialInternal==='loop' && !options?.suppressAutoPair){
    const endRow=addTimeScanRow({command:'endloop'},{before:row.nextElementSibling,suppressAutoPair:true});
    const pair=`lp${++timeLoopPairCounter}`;
    row.dataset.timeLoopPair=pair;
    if(endRow) endRow.dataset.timeLoopPair=pair;
  }

  const handleSelectionChange=()=>{
    const previous=row.dataset.timeCommand || 'drive:s1';
    const previousPair=previous==='loop' ? matchingTimeLoopRow(row) : null;
    const next=syncControlState();
    if(previous==='loop' && next!=='loop' && previousPair){ previousPair.remove(); delete row.dataset.timeLoopPair; }
    row.dataset.timeCommand=next;
    delete row.dataset.timeMigrationWarning;
    updateTimeScanRowFields(row);
    if(previous!=='loop' && next==='loop'){
      const endRow=addTimeScanRow({command:'endloop'},{before:row.nextElementSibling,suppressAutoPair:true});
      const pair=`lp${++timeLoopPairCounter}`;
      row.dataset.timeLoopPair=pair;
      if(endRow) endRow.dataset.timeLoopPair=pair;
      selectOnlyTimeScanRow(row);
    }
    renumberTimeScanRows();
    clearTimeEstimateMessage();
    updateTimeFixHeaderState();
    saveTimeEstimateState();
    validateAllTimeScanRows({showMessage:true});
  };
  opSelect.addEventListener('change',handleSelectionChange);
  targetSelect.addEventListener('change',handleSelectionChange);

  const timeInput=row.querySelector('[data-time-mcu]');
  timeInput.addEventListener('input',()=>{
    if(timeInput.readOnly) return;
    const parsed=validateTimeMcuInput(timeInput);
    saveTimeEstimateState();
    if(parsed.ok) clearTimeEstimateMessage(); else setTimeEstimateMessage('MCU must be a non-negative whole number (wait uses seconds).',true);
  });
  timeInput.addEventListener('change',()=>{
    if(timeInput.readOnly) return;
    const parsed=validateTimeMcuInput(timeInput);
    if(parsed.ok){ timeInput.value=formatTimeMcuValue(parsed.value); applyMcuToSelectedTimeScans(row,timeInput.value); }
    saveTimeEstimateState();
    validateAllTimeScanRows({showMessage:true});
  });
  fix?.addEventListener('change',()=>{ updateTimeFixHeaderState(); saveTimeEstimateState(); });
  const indexCell=row.querySelector('[data-time-index]');
  if(indexCell){
    indexCell.draggable=true;
    indexCell.title='Click to select; drag to reorder. Loop/endloop moves the complete loop block; Alt-drag a loop boundary to resize its scope.';
    indexCell.addEventListener('click',event=>{ event.stopPropagation(); selectTimeScanIndex(row,event); });
    indexCell.addEventListener('dragstart',event=>startTimeScanDrag(row,event));
    indexCell.addEventListener('dragend',cancelTimeScanDrag);
  }
  renumberTimeScanRows();
  saveTimeEstimateState();
  return row;
};

timeScanRowValues = function(row){
  if(!row) return null;
  const command=row.querySelector('[data-time-variable]')?.value || 'drive:s1';
  const {op,target}=v42CommandParts(command);
  const ranges={};
  row.querySelectorAll('[data-time-range-key]').forEach(input=>{ ranges[input.dataset.timeRangeKey]=input.value; });
  return {command,operation:op,target,ranges,mcu:row.querySelector('[data-time-mcu]')?.value??'',fixed:!!row.querySelector('[data-time-fix]')?.checked};
};

readTimeScanRow = function(row,index){
  setTimeScanRowWarning(row,false);
  if(row.dataset.timeMigrationWarning){
    setTimeScanRowWarning(row,true);
    return {ok:false,error:`Command ${index}: ${row.dataset.timeMigrationWarning}`};
  }
  const command=row.querySelector('[data-time-variable]')?.value || 'drive:s1';
  const meta=timeCommandMeta(command);
  const rangeInputs=[...row.querySelectorAll('[data-time-range-key]')];
  const parsed=rangeInputs.map(input=>({input,key:input.dataset.timeRangeKey,parsed:validateTimeRangeInput(input)}));
  const invalidRange=parsed.find(x=>!x.parsed.ok);
  if(invalidRange){ setTimeScanRowWarning(row,true); return {ok:false,error:`Command ${index}: ${invalidRange.parsed.error}`}; }
  const timeInput=row.querySelector('[data-time-mcu]');
  const time=validateTimeMcuInput(timeInput);
  if(!time.ok){ setTimeScanRowWarning(row,true); return {ok:false,error:`Command ${index}: ${meta.kind==='wait'?'wait time (s)':'MCU'} must be a non-negative whole number.`}; }

  if((meta.target==='qe'||meta.target==='th2th') && meta.op!=='scan'){
    setTimeScanRowWarning(row,true);
    return {ok:false,error:`Command ${index}: ${meta.target==='qe'?'QE':'th2th'} is available with scan only.`};
  }
  if((meta.op==='driverel'||meta.op==='scanrel') && meta.target==='hkle'){
    setTimeScanRowWarning(row,true);
    return {ok:false,error:`Command ${index}: relative HKLE is not supported; use absolute drive/scan HKLE.`};
  }

  const movingCounts=meta.kind==='scan' ? parsed.map(x=>x.parsed.count).filter(n=>n>1) : [];
  const unique=[...new Set(movingCounts)];
  if(unique.length>1){
    for(const x of parsed) if(x.parsed.count>1) setTimeInputInvalid(x.input,true);
    setTimeScanRowWarning(row,true);
    return {ok:false,error:`Command ${index}: ranged Detail values do not contain the same number of scan points.`};
  }
  if(meta.kind==='scan' && unique.length===0){
    for(const x of parsed) setTimeInputInvalid(x.input,true);
    setTimeScanRowWarning(row,true);
    return {ok:false,error:`Command ${index}: ${meta.op} requires initial final step in at least one Detail field.`};
  }
  const points=meta.kind==='scan' ? unique[0] : ((meta.kind==='loop'||meta.kind==='endloop')?0:1);
  const loopIterations=meta.kind==='loop' ? (parsed[0]?.parsed?.count||1) : 1;
  if(meta.target==='hkle' && (meta.op==='drive'||meta.op==='scan') && !parsed.some(x=>x.parsed.symbolic)){
    const parsedByKey=Object.fromEntries(parsed.map(x=>[x.key,x.parsed]));
    const plane=validateHkleScanPlane(parsedByKey,Math.max(1,points));
    if(!plane.ok){
      setTimeScanRowWarning(row,true);
      const where=plane.hkl?` (${plane.hkl.map(v=>Number(v.toPrecision(6))).join(', ')})`:'';
      const detail=plane.error?` ${plane.error}`:'';
      return {ok:false,error:`Command ${index}: HKLE is outside the current U-V scattering plane${where}.${detail}`};
    }
  }
  const secondsPerMcu=v57TimeMcuSecondsPerUnit();
  const baseSeconds=meta.kind==='wait' ? time.value
    : (meta.kind==='count' ? time.value*secondsPerMcu
    : (meta.kind==='scan' ? points*time.value*secondsPerMcu : 0));
  return {
    ok:true,command,operation:meta.op,target:meta.target,kind:meta.kind,points,loopIterations,
    loopLevel:Number(row.dataset.timeLoopLevel||0),mcuValue:time.value,mcuSeconds:time.value,
    seconds:baseSeconds,
    fixed:meta.kind!=='scan' || !!row.querySelector('[data-time-fix]')?.checked
  };
};

// Script-only S2 state tracking.  This does not change any TAS/Q-E geometry
// calculation; it only reconstructs the motor position reached by preceding
// Script commands so relative scans can be validated at their actual positions.
function timeFinalPointIndex(parsedByKey){
  let count=1;
  for(const parsed of Object.values(parsedByKey||{})){
    if(parsed?.ok && Number.isFinite(parsed.count)) count=Math.max(count,Number(parsed.count));
  }
  return Math.max(0,count-1);
}

function timeResolveCandidateS2State(candidate,rowIndex,context,structure,visiting=new Set()){
  if(!candidate || visiting.has(rowIndex)) return null;
  visiting.add(rowIndex);
  try{
    const command=candidate.querySelector('[data-time-variable]')?.value||'';
    const meta=timeCommandMeta(command);
    if(!['s2','th2th','qe','hkle','br'].includes(meta.target)) return null;

    const parsedByKey={};
    for(const input of candidate.querySelectorAll('[data-time-range-key]')){
      const parsed=parseTimeDetail(input.value,command,candidate);
      if(!parsed.ok) return null;
      parsedByKey[input.dataset.timeRangeKey]=parsed;
    }
    const finalPoint=timeFinalPointIndex(parsedByKey);

    const resolveWithContext=(ctx)=>{
      if(meta.target==='s2'){
        const parsed=parsedByKey.s2;
        const value=timeDetailValueAt(parsed,finalPoint,ctx);
        if(!Number.isFinite(value)) return null;
        if(meta.op==='driverel' || meta.op==='scanrel'){
          const base=timeS2StateBeforeIndex(rowIndex,ctx,structure,visiting);
          return base ? {...base,s2:base.s2+value,source:command} : null;
        }
        return {s2:value,Ei:timeElasticIncidentEnergy(),source:command};
      }

      if(meta.target==='th2th'){
        const value=timeDetailValueAt(parsedByKey.th2th,finalPoint,ctx);
        if(!Number.isFinite(value)) return null;
        const base=timeS2StateBeforeIndex(rowIndex,ctx,structure,visiting);
        return base ? {...base,s2:base.s2+value,source:command} : null;
      }

      if(meta.target==='qe'){
        const q=timeDetailValueAt(parsedByKey.q,finalPoint,ctx);
        const hw=timeDetailValueAt(parsedByKey.hw,finalPoint,ctx);
        if(!Number.isFinite(q)||!Number.isFinite(hw)) return null;
        const calc=timeS2MagnitudeFromQ(q,hw);
        return calc ? {s2:timeSignedS2FromMagnitude(calc.s2),Ei:calc.Ei,q,hw,source:command} : null;
      }

      let rl; try{ rl=buildResolutionLattice().rl; }catch(_e){ return null; }
      const hkl=meta.target==='br'
        ? (parsedByKey.hkl?.tuple||[]).map(item=>resolveTimeFixedValue(item,ctx))
        : ['h','k','l'].map(key=>timeDetailValueAt(parsedByKey[key],finalPoint,ctx));
      const hw=meta.target==='br'?0:timeDetailValueAt(parsedByKey.hw,finalPoint,ctx);
      if(hkl.length!==3 || hkl.some(v=>!Number.isFinite(v)) || !Number.isFinite(hw)) return null;
      const q=norm(hklToQ(rl,hkl));
      const calc=timeS2MagnitudeFromQ(q,hw);
      return calc ? {s2:timeSignedS2FromMagnitude(calc.s2),Ei:calc.Ei,hkl,hw,source:command} : null;
    };

    const direct=resolveWithContext(context);
    if(direct) return direct;
    const contexts=timeLoopContextsForRow(candidate,structure);
    if(contexts.ok){
      for(let j=contexts.contexts.length-1;j>=0;j--){
        const fallback=resolveWithContext(contexts.contexts[j]);
        if(fallback) return fallback;
      }
    }
    return null;
  }finally{
    visiting.delete(rowIndex);
  }
}

function timeS2StateBeforeIndex(currentIndex,context,structure,visiting=new Set()){
  const rows=timeScanRows();
  for(let i=Math.max(0,Number(currentIndex))-1;i>=0;i--){
    const state=timeResolveCandidateS2State(rows[i],i,context,structure,visiting);
    if(state) return state;
  }
  return null;
}

function timePreviousS2Position(row,index,context,structure){
  return timeS2StateBeforeIndex(Math.max(0,Number(index)-1),context,structure,new Set());
}

// Keep the historical helper name for existing rel-S2 warning code.
timePreviousBrS2 = timePreviousS2Position;

function timeReachabilityFromQ(q,hw){
  const energy=timeEnergyForTransfer(hw);
  if(!energy) return {ok:false,reason:'the selected energy transfer makes Ei or Ef non-positive'};
  const Q=Number(q);
  if(!(Q>=0)) return {ok:false,reason:'Q is not a valid non-negative value'};
  const ki=Math.sqrt(energy.Ei/2.072), kf=Math.sqrt(energy.Ef/2.072);
  const denom=2*ki*kf;
  const cosS2=(ki*ki+kf*kf-Q*Q)/denom;
  if(cosS2<-1-1e-10 || cosS2>1+1e-10){
    return {ok:false,reason:'the scattering triangle cannot be formed at this Q and energy',Ei:energy.Ei,Ef:energy.Ef};
  }
  const s2=Math.abs(rad2deg(Math.acos(clamp(cosS2,-1,1))));
  return {ok:true,s2,Ei:energy.Ei,Ef:energy.Ef};
}

function timeS2RangeWarning(s2,Ei,detail,index){
  if(!Number.isFinite(s2)) return null;
  const value=Math.abs(Number(s2));
  const min=Math.abs(Number(num('S2min')));
  const max=timeS2LimitAtEi(Ei);
  if(Number.isFinite(min) && value<min-1e-8){
    return `Command ${index}: S2=${value.toFixed(2)}° is below the instrument min ${min.toFixed(2)}° (${detail}).`;
  }
  if(Number.isFinite(max) && value>max+1e-8){
    return `Command ${index}: S2=${value.toFixed(2)}° exceeds the instrument max ${max.toFixed(2)}° at Ei=${Number(Ei).toFixed(2)} meV (${detail}).`;
  }
  return null;
}

function timeDarkWarningForHKLE(cache,hkl,hw,index,detail){
  if(!cache?.addDark) return null;
  const blocks=qeDarkBlockWarningsForHKLE(cache,hkl,hw);
  return blocks.length ? `Command ${index}: Dark angle ${blocks.join(' / ')} (${detail}).` : null;
}

function timeRowMotionWarnings(row,result,index,structure,darkCache=null){
  const meta=timeCommandMeta(result.command);
  if(!['s2','th2th','qe','hkle','br'].includes(meta.target)) return [];
  const contextResult=timeLoopContextsForRow(row,structure);
  if(!contextResult.ok){
    return contextResult.tooMany
      ? [`Command ${index}: reachability check skipped because enclosing loops expand beyond 50,000 combinations.`]
      : [];
  }
  const parsedByKey={};
  for(const input of row.querySelectorAll('[data-time-range-key]')){
    const parsed=parseTimeDetail(input.value,result.command,row);
    if(!parsed.ok) return [];
    parsedByKey[input.dataset.timeRangeKey]=parsed;
  }
  let rl=null;
  if(meta.target==='hkle'||meta.target==='br'){
    try{ rl=buildResolutionLattice().rl; }catch(_e){ return []; }
  }
  const points=Math.max(1,result.points||1), warnings=[];
  const add=message=>{ if(message && !warnings.includes(message)) warnings.push(message); };
  for(const context of contextResult.contexts){
    for(let point=0;point<points;point++){
      if(meta.target==='s2' || meta.target==='th2th'){
        const key=meta.target==='th2th'?'th2th':'s2';
        const value=timeDetailValueAt(parsedByKey[key],point,context);
        if(!Number.isFinite(value)) continue;
        if(meta.target==='th2th'){
          // SPICE th2th is a relative scan: evaluate every requested offset
          // from the S2 position reached by the preceding Script commands.
          const base=timePreviousS2Position(row,index,context,structure);
          if(!base){
            add(`Command ${index}: th2th reachability check requires a preceding position-defining command (for example br, drive/scan HKLE, or S2).`);
            continue;
          }
          const finalS2=base.s2+value;
          add(timeS2RangeWarning(finalS2,base.Ei,`base S2=${base.s2.toFixed(2)}°, th2th offset=${Number(value.toPrecision?.(6)??value)}`,index));
        }else if(meta.op==='driverel'||meta.op==='scanrel'){
          const base=timePreviousS2Position(row,index,context,structure);
          if(!base) continue;
          const finalS2=base.s2+value;
          add(timeS2RangeWarning(finalS2,base.Ei,`previous S2=${base.s2.toFixed(2)}°, rel S2=${Number(value.toPrecision?.(6)??value)}`,index));
        }else{
          const Ei=timeElasticIncidentEnergy();
          add(timeS2RangeWarning(value,Ei,`${key}=${Number(value.toPrecision?.(6)??value)}`,index));
        }
        continue;
      }

      if(meta.target==='qe'){
        const q=timeDetailValueAt(parsedByKey.q,point,context);
        const hw=timeDetailValueAt(parsedByKey.hw,point,context);
        if(!Number.isFinite(q)||!Number.isFinite(hw)) continue;
        const detail=`Q=${Number(q.toPrecision(6))}, E=${Number(hw.toPrecision(6))}`;
        const reach=timeReachabilityFromQ(q,hw);
        if(!reach.ok){ add(`Command ${index}: inaccessible point — ${reach.reason} (${detail}).`); continue; }
        add(timeS2RangeWarning(reach.s2,reach.Ei,detail,index));
        continue;
      }

      const hkl=meta.target==='br'
        ? (parsedByKey.hkl?.tuple||[]).map(item=>resolveTimeFixedValue(item,context))
        : ['h','k','l'].map(key=>timeDetailValueAt(parsedByKey[key],point,context));
      const hw=meta.target==='br'?0:timeDetailValueAt(parsedByKey.hw,point,context);
      if(hkl.length!==3 || hkl.some(v=>!Number.isFinite(v)) || !Number.isFinite(hw)) continue;
      const detail=`HKLE=(${hkl.map(v=>Number(v.toPrecision(6))).join(', ')}, ${Number(hw.toPrecision(6))})`;
      const plane=hklInCurrentScatteringPlane(hkl);
      if(!plane.ok){
        add(`Command ${index}: inaccessible point — HKL is outside the current U-V scattering plane (${detail}).`);
        continue;
      }
      const q=norm(hklToQ(rl,hkl));
      const reach=timeReachabilityFromQ(q,hw);
      if(!reach.ok){ add(`Command ${index}: inaccessible point — ${reach.reason} (${detail}).`); continue; }
      add(timeS2RangeWarning(reach.s2,reach.Ei,detail,index));
      add(timeDarkWarningForHKLE(darkCache,hkl,hw,index,detail));
    }
  }
  return warnings;
}

timeRowS2LimitWarning = function(row,result,index,structure){
  return timeRowMotionWarnings(row,result,index,structure,null)[0] || null;
};

function v42DetailItems(row){
  return [...row.querySelectorAll('[data-time-range-key]')].map(input=>({key:input.dataset.timeRangeKey,tokens:spiceDetailTokens(input.value,row)}));
}
function v42TemplateLinesForTarget(target,valueToken=''){
  const template=v42AsetTemplate(target);
  const commands=v42TemplateCommands(template);
  if(!commands.length) throw new Error(`${target} ASET has no SPICE template.`);
  const usesValue=v42TemplateUsesValue(template);
  if(usesValue && valueToken==='') throw new Error(`${target} ASET requires a Detail value because its template contains value.`);
  return commands.map(command=>usesValue?command.replace(/\bvalue\b/gi,valueToken):command);
}
function v42SpiceLinesForRow(row,info,result){
  const meta=timeCommandMeta(result.command);
  if(meta.kind==='loop'){
    const values=spiceDetailTokens(row.querySelector('[data-time-range-key="loop"]')?.value);
    return [`loop ${spiceLoopVar(info?.level||1)}=${values.join(',')}`];
  }
  if(meta.kind==='endloop') return ['endloop'];
  if(meta.kind==='scantitle'){
    const raw=String(row.querySelector('[data-time-range-key="title"]')?.value||'').trim();
    const unquoted=raw.length>=2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1,-1).trim() : raw;
    const title=unquoted.replace(/\bloop([1-9]\d*)\b/gi,token=>{
      const ref=parseTimeLoopReferenceToken(token,row);
      if(!ref?.ok) throw new Error(ref?.error||`${token} is not available at this command.`);
      return `%${spiceLoopVar(ref.loopRef)}`;
    });
    const escaped=title.replace(/"/g,'\\"');
    return [`scantitle "${escaped}"`];
  }
  if(meta.kind==='count') return [`count preset mcu ${row.querySelector('[data-time-mcu]')?.value||'0'}`];
  if(meta.kind==='wait') return [`wait ${row.querySelector('[data-time-mcu]')?.value||'0'}`];
  const details=v42DetailItems(row);
  const byKey=Object.fromEntries(details.map(item=>[item.key,item.tokens]));
  const t=row.querySelector('[data-time-mcu]')?.value||'0';
  const target=meta.target, op=meta.op;

  if(meta.aset){
    const template=v42AsetTemplate(target);
    const commands=v42TemplateCommands(template);
    if(!commands.length) throw new Error(`${target} ASET has no SPICE template.`);
    const inputs=[...row.querySelectorAll('[data-time-range-key]')];
    const values=inputs.map(input=>String(input.value||'').trim());
    let valueIndex=0;
    return commands.map(command=>{
      let expanded=command.replace(/<(value|range)>/gi,(_m,type)=>{
        const kind=String(type).toLowerCase();
        const raw=values[valueIndex++]??'';
        if(!raw) throw new Error(`${target} ASET requires a ${kind} entry.`);
        return spiceDetailTokens(raw,row).join(' ');
      });
      // Every ASET scan/scanrel consumes the row MCU automatically. This
      // keeps the template focused on motion syntax while Time estimate owns
      // counting time, e.g. "scan sgu <range>" -> "... preset mcu 300".
      if(/^scan(?:rel)?\b/i.test(expanded) && !/\bpreset\s+mcu\b/i.test(expanded)){
        expanded=`${expanded} preset mcu ${t}`;
      }
      return expanded;
    });
  }
  if(op==='drive'){
    if(target==='hkle') return [`drive h ${byKey.h[0]} k ${byKey.k[0]} l ${byKey.l[0]} e ${byKey.hw[0]}`];
    if(target==='br') return [`br ${byKey.hkl.join(' ')}`];
    const token=details[0]?.tokens?.[0];
    if(target==='ei'||target==='ef') return [`${target} ${token}`];
    return [`drive ${target} ${token}`];
  }
  if(op==='driverel'){
    const token=details[0]?.tokens?.[0];
    return [`driverel ${target} ${token}`];
  }
  if(op==='scan'){
    if(target==='th2th') return [`th2th ${details[0].tokens.join(' ')}`];
    const pieces=['scan'];
    if(target==='hkle'){
      for(const [key,name] of [['h','h'],['k','k'],['l','l'],['hw','e']]) pieces.push(name,...byKey[key]);
    }else if(target==='qe'){
      pieces.push('q',...byKey.q,'e',...byKey.hw);
    }else pieces.push(target,...details[0].tokens);
    pieces.push('preset','mcu',String(t));
    return [pieces.join(' ')];
  }
  if(op==='scanrel') return [`preset mcu ${t}`,`scanrel ${target} ${details[0].tokens.join(' ')}`];
  throw new Error(`Unsupported command ${op}.`);
}
function v42TemplateRegex(command){
  const text=String(command||'');
  const re=/<(value|range)>/gi;
  const esc=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
  let source='^',last=0,m; const types=[];
  while((m=re.exec(text))){ source+=esc(text.slice(last,m.index))+'(.+?)'; types.push(m[1].toLowerCase()); last=m.index+m[0].length; }
  source+=esc(text.slice(last))+'$';
  return {regex:new RegExp(source,'i'),types};
}

function v42MatchAsetAtLines(lines,startIndex,loopStack){
  const nextSignificant=(from)=>{ for(let j=from;j<lines.length;j++){ const raw=lines[j].trim(); if(raw && !raw.startsWith('#') && !raw.startsWith(';')) return {index:j,raw}; } return null; };
  for(const key of v42AsetKeys()){
    const templates=v42TemplateCommands(v42AsetTemplate(key));
    if(!templates.length) continue;
    let cursor=startIndex-1,last=startIndex-1,ok=true; const captures=[]; let timeValue='0';
    for(const template of templates){
      const next=nextSignificant(cursor+1); if(!next){ok=false;break;}
      let candidate=next.raw;
      if(/^scan(?:rel)?\b/i.test(template)){
        const timed=/^(.*?)\s+preset\s+mcu\s+(\d+)\s*$/i.exec(candidate);
        if(!timed){ok=false;break;}
        candidate=timed[1].trim();
        const scanTime=timed[2];
        if(timeValue!=='0' && timeValue!==scanTime){ok=false;break;}
        timeValue=scanTime;
      }
      const {regex,types}=v42TemplateRegex(template),m=regex.exec(candidate);
      if(!m){ok=false;break;}
      for(let g=1;g<m.length;g++){
        const type=types[g-1];
        const rawValue=String(m[g]).trim();
        captures.push({type,value:rawValue.split(/\s+/).map(token=>spiceTokenToTime(token,loopStack)).join(' ')});
      }
      cursor=next.index; last=next.index;
    }
    if(ok){
      const ranges={}; let occurrence=0;
      for(const item of captures) ranges[`aset_${item.type}_${++occurrence}`]=item.value;
      return {key,ranges,mcu:timeValue,endIndex:last};
    }
  }
  return null;
}

function v42RenderSpiceBackdrop(){
  const area=$('scriptSpiceText'),backdrop=$('scriptSpiceBackdrop'),numbers=$('scriptSpiceLineNumbers');
  if(!area||!backdrop) return;
  const lines=String(area.value??'').split('\n');
  backdrop.innerHTML=lines.map((line,i)=>{
    const n=i+1;
    const cls=v42SpiceErrorLines.has(n)?' spice-line-error':(v42SpiceWarningLines.has(n)?' spice-line-warning':'');
    return `<span class="spice-backdrop-line${cls}">${v42EscapeHtml(line)||' '}</span>`;
  }).join('');
  if(numbers) numbers.innerHTML=lines.map((_line,i)=>{
    const n=i+1;
    const cls=v42SpiceErrorLines.has(n)?' spice-line-error':(v42SpiceWarningLines.has(n)?' spice-line-warning':'');
    return `<span class="spice-line-number${cls}">${n}</span>`;
  }).join('');
  backdrop.scrollTop=area.scrollTop; backdrop.scrollLeft=area.scrollLeft; if(numbers) numbers.scrollTop=area.scrollTop;
}
function v49HighlightSpiceErrorFromMessage(message){
  v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set();
  const match=/\bLine\s+(\d+)\s*:/i.exec(String(message||''));
  if(match) v42SpiceErrorLines.add(Number(match[1]));
  v42RenderSpiceBackdrop();
}
function v42ApplyValidationToLineHighlights(validation){
  v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set();
  if(!validation || v42SpiceLineMap.length!==validation.rows.length){ v42RenderSpiceBackdrop(); return; }
  validation.results.forEach((result,i)=>{
    const map=v42SpiceLineMap[i]; if(!map) return;
    const set=result?.ok?v42SpiceWarningLines:v42SpiceErrorLines;
    if(result?.ok && !validation.warnings?.some(w=>String(w).startsWith(`Command ${i+1}:`))) return;
    for(let line=map.start;line<=map.end;line++) set.add(line);
  });
  v42RenderSpiceBackdrop();
}

generateSpiceMacroFromTimeEstimate = function(){
  const validation=validateAllTimeScanRows({showMessage:true});
  const structure=ensureTimeLoopPairIds();
  const lines=[]; v42SpiceLineMap=[]; v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set();
  for(let i=0;i<structure.rows.length;i++){
    const row=structure.rows[i],result=validation.results[i],info=structure.info.get(row);
    const start=lines.length+1;
    if(!result?.ok){
      lines.push(`# ERROR Command ${i+1}: ${String(result?.error||'Invalid command').replace(/^Command\s+\d+:\s*/,'')}`);
    }else{
      try{ lines.push(...v42SpiceLinesForRow(row,info,result)); }
      catch(err){
        result.ok=false; result.error=`Command ${i+1}: ${err?.message||String(err)}`;
        if(!validation.errors.includes(result.error)) validation.errors.push(result.error);
        lines.push(`# ERROR Command ${i+1}: ${err?.message||String(err)}`);
      }
    }
    const end=lines.length;
    v42SpiceLineMap[i]={start,end};
    if(!result?.ok) for(let line=start;line<=end;line++) v42SpiceErrorLines.add(line);
    else if(validation.warnings?.some(w=>String(w).startsWith(`Command ${i+1}:`))) for(let line=start;line<=end;line++) v42SpiceWarningLines.add(line);
  }
  validation.ok=validation.errors.length===0;
  v42LastSpiceValidation=validation;
  return lines.join('\n');
};

parseSpiceVariableGroups = function(tokens,loopStack){
  const names=new Set(['ei','ef','e','q','s1','s2','h','k','l']);
  const groups=[]; let i=0;
  while(i<tokens.length){
    const name=String(tokens[i]||'').toLowerCase();
    if(!names.has(name)) throw new Error(`Unknown scan variable: ${tokens[i]||''}`);
    i++;
    const values=[];
    while(i<tokens.length && !names.has(String(tokens[i]).toLowerCase())) values.push(spiceTokenToTime(tokens[i++],loopStack));
    if(values.length!==1 && values.length!==3) throw new Error(`${name} must have one value or initial final step.`);
    groups.push({name,values});
  }
  return groups;
};
function v42RowsFromGroups(op,groups,t='0'){
  const byName=Object.fromEntries(groups.map(g=>[g.name,g.values.join(' ')]));
  const names=groups.map(g=>g.name);
  if(['h','k','l','e'].every(name=>names.includes(name))){
    return {command:`${op}:hkle`,ranges:{h:byName.h,k:byName.k,l:byName.l,hw:byName.e},mcu:t,fixed:op!=='scan'};
  }
  if(op==='scan' && groups.length===2 && names.includes('q') && names.includes('e')){
    return {command:'scan:qe',ranges:{q:byName.q,hw:byName.e},mcu:t,fixed:false};
  }
  if(groups.length===1 && ['ei','ef','e','s1','s2'].includes(groups[0].name)){
    const target=groups[0].name;
    return {command:`${op}:${target}`,ranges:{[target==='e'?'hw':target]:groups[0].values.join(' ')},mcu:t,fixed:op!=='scan'};
  }
  throw new Error(`Unsupported ${op} target combination.`);
}

parseSpiceMacroToRows = function(text){
  const rows=[],loopStack=[];
  const lines=String(text??'').split(/\r?\n/);
  let pendingMcu=null;
  const significant=(start)=>{ for(let j=start;j<lines.length;j++){ const raw=lines[j].trim(); if(raw && !raw.startsWith('#') && !raw.startsWith(';')) return {index:j,raw}; } return null; };
  for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
    const raw=lines[lineIndex].trim();
    if(!raw || raw.startsWith('#') || raw.startsWith(';')) continue;
    const asetMatch=v42MatchAsetAtLines(lines,lineIndex,loopStack);
    if(asetMatch){
      const template=v42AsetTemplate(asetMatch.key);
      const commands=v42TemplateCommands(template);
      const hasRange=v42TemplatePlaceholders(template).some(p=>p.type==='range');
      const operation=commands.some(c=>/^scanrel\b/i.test(c))?'scanrel':(commands.some(c=>/^scan\b/i.test(c))?'scan':(commands.some(c=>/^driverel\b/i.test(c))?'driverel':(hasRange?'scan':'drive')));
      rows.push({command:`${operation}:${asetMatch.key}`,ranges:asetMatch.ranges,mcu:asetMatch.mcu||'0',fixed:!['scan','scanrel'].includes(operation)});
      lineIndex=asetMatch.endIndex;
      continue;
    }
    let match;
    if((match=/^loop\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^,]+),([^,]+),([^,]+)\s*$/i.exec(raw))){
      if(loopStack.includes(match[1])) throw new Error(`Line ${lineIndex+1}: loop variable ${match[1]} is already active.`);
      loopStack.push(match[1]); rows.push({command:'loop',ranges:{loop:`${match[2].trim()} ${match[3].trim()} ${match[4].trim()}`},mcu:'0',fixed:true}); continue;
    }
    if(/^endloop\s*$/i.test(raw)){ if(!loopStack.length) throw new Error(`Line ${lineIndex+1}: endloop has no matching loop.`); loopStack.pop(); rows.push({command:'endloop',ranges:{},mcu:'0',fixed:true}); continue; }
    if((match=/^scantitle\s+(.+?)\s*$/i.exec(raw))){
      let title;
      try{
        const token=String(match[1]||'').trim();
        const unquoted=token.length>=2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1,-1) : token;
        title=spiceTokenToTime(unquoted.replace(/\\"/g,'"'),loopStack);
      }
      catch(err){ throw new Error(`Line ${lineIndex+1}: ${err?.message||String(err)}`); }
      rows.push({command:'scantitle',ranges:{title},mcu:'0',fixed:true}); continue;
    }
    if((match=/^wait\s+(\d+)\s*$/i.exec(raw))){ rows.push({command:'wait',ranges:{},mcu:match[1],fixed:true}); continue; }
    if((match=/^count(?:\s+preset\s+mcu)?\s+(\d+)\s*$/i.exec(raw))){ rows.push({command:'count',ranges:{},mcu:match[1],fixed:true}); continue; }
    if((match=/^br\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i.exec(raw))){ rows.push({command:'drive:br',ranges:{hkl:[match[1],match[2],match[3]].map(v=>spiceTokenToTime(v,loopStack)).join(' ')},mcu:'0',fixed:true}); continue; }
    if((match=/^preset\s+mcu\s+(\d+)\s*$/i.exec(raw))){ pendingMcu=match[1]; continue; }
    if((match=/^(ei|ef)\s+(\S+)\s*$/i.exec(raw))){
      const target=match[1].toLowerCase(); rows.push({command:`drive:${target}`,ranges:{[target]:spiceTokenToTime(match[2],loopStack)},mcu:'0',fixed:true}); continue;
    }
    const parts=raw.split(/\s+/),op=parts[0].toLowerCase();
    if(op==='drive' || op==='driverel' || op==='drel'){
      const canonical=op==='drive'?'drive':'driverel';
      const rest=parts.slice(1);
      if(rest.length===2){
        const device=rest[0].toLowerCase(),value=spiceTokenToTime(rest[1],loopStack);
        if(['ei','ef','e','s1','s2'].includes(device)){
          rows.push({command:`${canonical}:${device}`,ranges:{[device==='e'?'hw':device]:value},mcu:'0',fixed:true}); continue;
        }
      }
      if(canonical==='drive'){
        const groups=parseSpiceVariableGroups(rest,loopStack);
        rows.push(v42RowsFromGroups('drive',groups,'0')); continue;
      }
      throw new Error(`Line ${lineIndex+1}: unsupported driverel command.`);
    }
    if(op==='scan'){
      const presetIndex=parts.findIndex((token,index)=>index>0&&token.toLowerCase()==='preset');
      if(presetIndex<0 || String(parts[presetIndex+1]||'').toLowerCase()!=='mcu' || !/^\d+$/.test(String(parts[presetIndex+2]||'')) || presetIndex+3!==parts.length) throw new Error(`Line ${lineIndex+1}: scan must end with preset mcu <seconds>.`);
      const groups=parseSpiceVariableGroups(parts.slice(1,presetIndex),loopStack);
      rows.push(v42RowsFromGroups('scan',groups,parts[presetIndex+2])); continue;
    }
    if(op==='th2th'){
      if(parts.length!==4) throw new Error(`Line ${lineIndex+1}: th2th requires initial final step.`);
      const value=parts.slice(1).map(x=>spiceTokenToTime(x,loopStack)).join(' ');
      rows.push({command:'scan:th2th',ranges:{th2th:value},mcu:'1',fixed:false}); continue;
    }
    if(op==='scanrel'){
      let rest=parts.slice(1),mcu=pendingMcu||'1'; pendingMcu=null;
      const presetIndex=rest.findIndex(token=>token.toLowerCase()==='preset');
      if(presetIndex>=0){
        if(String(rest[presetIndex+1]||'').toLowerCase()!=='mcu'||!/^\d+$/.test(String(rest[presetIndex+2]||''))) throw new Error(`Line ${lineIndex+1}: invalid scanrel preset.`);
        mcu=rest[presetIndex+2]; rest=rest.slice(0,presetIndex);
      }
      if(rest.length!==4) throw new Error(`Line ${lineIndex+1}: scanrel requires target initial final step.`);
      const target=rest[0].toLowerCase(),value=rest.slice(1).map(x=>spiceTokenToTime(x,loopStack)).join(' ');
      if(!['ei','ef','e','s1','s2'].includes(target)) throw new Error(`Line ${lineIndex+1}: unsupported scanrel target ${target}.`);
      rows.push({command:`scanrel:${target}`,ranges:{[target==='e'?'hw':target]:value},mcu,fixed:false}); continue;
    }
    throw new Error(`Line ${lineIndex+1}: unsupported SPICE command.`);
  }
  if(loopStack.length) throw new Error('SPICE macro ends before all loops are closed.');
  if(!rows.length) throw new Error('No supported SPICE commands were found.');
  return rows;
};


// v53: ASET placeholder-specific validation. <value> remains scalar-only, while
// <range> accepts either one fixed value / loopN reference or initial final step.
// This lets one ASET template mix fixed and scanned axes without requiring a
// separate template. Scan timing still comes from the row MCU.
const v48BaseValidateTimeRangeInput=validateTimeRangeInput;
validateTimeRangeInput = function(input){
  const key=String(input?.dataset?.timeRangeKey||'');
  const row=input?.closest?.('.time-scan-row')||null;
  const command=row?.querySelector('[data-time-variable]')?.value||'';
  const meta=timeCommandMeta(command);
  if(meta.kind==='scantitle'){
    if(input?.dataset.timeLoopRefBroken==='1'){
      const broken={ok:false,error:'A loop reference in the scan title is no longer inside that loop.'};
      setTimeInputInvalid(input,true); return broken;
    }
    const result=v56ParseScantitleDetail(input?.value,row);
    if(result.ok && input){
      const refs=(result.textRefs||[]).filter(ref=>ref.pair);
      if(refs.length) input.dataset.timeLoopTextPairs=JSON.stringify(refs);
      else delete input.dataset.timeLoopTextPairs;
      delete input.dataset.timeLoopRefPair;
      delete input.dataset.timeLoopRefPairs;
    }
    setTimeInputInvalid(input,!result.ok); return result;
  }
  if(!key.startsWith('aset_')) return v48BaseValidateTimeRangeInput(input);
  if(key.startsWith('aset_range_')){
    const result=parseTimeRange(input?.value,row,{allowLoopReference:true});
    setTimeInputInvalid(input,!result.ok); return result;
  }
  const text=String(input?.value??'').trim();
  // ASET <value> is scalar-only, but the scalar may be an arithmetic expression
  // using enclosing loop variables, e.g. loop1-1 or (loop2+1)/6.  Use the same
  // expression parser as the normal Time estimate command fields so validation,
  // loop binding, reordering, and SPICE round-tripping stay consistent.
  const expr=parseTimeMathExpression(text,row,{allowLoopReference:true});
  if(expr.ok && input){
    if(Array.isArray(expr.refs) && expr.refs.length){
      input.dataset.timeLoopTextPairs=JSON.stringify(expr.refs.map(ref=>({pair:ref.pair,level:ref.level})));
    }else{
      delete input.dataset.timeLoopTextPairs;
    }
    delete input.dataset.timeLoopRefPair;
    delete input.dataset.timeLoopRefPairs;
  }
  const result=expr.ok
    ? {ok:true,fixed:true,count:1,value:expr.refs.length?null:expr.value,expression:expr,expressionText:text,symbolic:expr.refs.length>0,textRefs:expr.refs}
    : {ok:false,error:`Enter one numeric expression using loopN if needed. ${expr.error||''}`.trim()};
  setTimeInputInvalid(input,!result.ok); return result;
};

initializeScriptUI = function(){
  const area=$('scriptSpiceText'),backdrop=$('scriptSpiceBackdrop'),numbers=$('scriptSpiceLineNumbers'),rowsHost=$('timeScanRows');
  v42LoadAset();
  v42RefreshTargetSelects();
  const bindInfoToggle=(buttonId,panelId)=>{
    const button=$(buttonId),panel=$(panelId);
    if(!button || !panel || button.dataset.infoBound==='1') return;
    button.dataset.infoBound='1';
    button.addEventListener('click',()=>{
      const show=panel.classList.contains('hidden');
      panel.classList.toggle('hidden',!show);
      button.setAttribute('aria-expanded',String(show));
    });
  };
  bindInfoToggle('scriptAsetInfoToggle','scriptAsetHelp');
  bindInfoToggle('timeEstimateInfoToggle','timeEstimateInfoPanel');
  const asetHost=$('scriptAsetList');
  const refreshAset=()=>{
    const check=v42ValidateAsetRows();
    v42SaveAset(); v42RefreshTargetSelects();
    for(const row of timeScanRows()){ const meta=timeCommandMeta(row.querySelector('[data-time-variable]')?.value||''); if(meta.aset) updateTimeScanRowFields(row); }
    validateAllTimeScanRows({showMessage:true});
    if(!check.ok) scriptMessage(check.message,true);
  };
  asetHost?.addEventListener('input',event=>{
    if(event.target.closest?.('[data-aset-target],[data-aset-template]')) refreshAset();
  });
  asetHost?.addEventListener('change',event=>{
    if(event.target.closest?.('[data-aset-target],[data-aset-template]')) refreshAset();
  });
  asetHost?.addEventListener('click',event=>{
    const remove=event.target.closest?.('.script-aset-remove'); if(!remove) return;
    const row=remove.closest('[data-aset-row]'); const key=v42AsetRowKey(row);
    row?.remove(); v42RenumberAsetRows(); refreshAset(); scriptMessage(`Removed ASET ${key||''}. Commands that used it must choose another Target.`);
  });
  $('scriptAsetAdd')?.addEventListener('click',v42PromptAddAset);
  const applyAsetCollapsedState=collapsed=>{
    const workspace=document.querySelector('#scriptPanel .script-workspace');
    if(!workspace) return;
    workspace.classList.toggle('aset-collapsed',!!collapsed);
    const button=$('scriptAsetToggle');
    if(button){
      button.textContent=collapsed?'▶ Show ASET':'◀ Hide ASET';
      button.setAttribute('aria-expanded',String(!collapsed));
    }
  };
  let initialAsetCollapsed=false;
  try{ initialAsetCollapsed=localStorage.getItem(V51_ASET_COLLAPSED_STORAGE_KEY)==='1'; }catch(_e){}
  applyAsetCollapsedState(initialAsetCollapsed);
  $('scriptAsetToggle')?.addEventListener('click',()=>{
    const workspace=document.querySelector('#scriptPanel .script-workspace'); if(!workspace) return;
    const collapsed=!workspace.classList.contains('aset-collapsed');
    applyAsetCollapsedState(collapsed);
    try{ localStorage.setItem(V51_ASET_COLLAPSED_STORAGE_KEY,collapsed?'1':'0'); }catch(_e){}
    requestAnimationFrame(resizeVisiblePlots);
  });
  try{ if(area) area.value=localStorage.getItem(SPICE_SCRIPT_STORAGE_KEY)||''; }catch(_e){}
  area?.addEventListener('scroll',()=>{ if(backdrop){backdrop.scrollTop=area.scrollTop;backdrop.scrollLeft=area.scrollLeft;} if(numbers) numbers.scrollTop=area.scrollTop; });
  area?.addEventListener('input',()=>{
    v42SpiceAutoLinked=false; v42SpiceLineMap=[]; v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set(); v42RenderSpiceBackdrop();
    try{localStorage.setItem(SPICE_SCRIPT_STORAGE_KEY,area.value);}catch(_e){} scriptMessage('');
  });
  // Conversion is intentionally one-shot only. Editing either side must not
  // overwrite the other side until the user explicitly presses an arrow button.
  v42SpiceAutoLinked=false;
  v42SpiceMutationObserver?.disconnect();
  v42SpiceMutationObserver=null;
  $('scriptToSpice')?.addEventListener('click',()=>{
    try{
      v42SpiceAutoLinked=false;
      const text=generateSpiceMacroFromTimeEstimate(); area.value=text; v42RenderSpiceBackdrop();
      try{localStorage.setItem(SPICE_SCRIPT_STORAGE_KEY,text);}catch(_e){}
      if(v42LastSpiceValidation?.errors?.length) scriptMessage(v57SpiceValidationSummary(v42LastSpiceValidation),true);
      else if(v42LastSpiceValidation?.warnings?.length) scriptMessage(v57SpiceValidationSummary(v42LastSpiceValidation),false,true);
      else scriptMessage('Converted Time estimate commands to SPICE. ASET placeholders were expanded into their SPICE templates.');
    }catch(err){ scriptMessage(err?.message||String(err),true); }
  });
  $('scriptToCommands')?.addEventListener('click',()=>{
    try{
      const rows=parseSpiceMacroToRows(area?.value||''); replaceTimeEstimateRows(rows); v42SpiceAutoLinked=false;
      v42RenderSpiceBackdrop();
      if(v42LastSpiceValidation?.errors?.length) scriptMessage(v57SpiceValidationSummary(v42LastSpiceValidation),true);
      else if(v42LastSpiceValidation?.warnings?.length) scriptMessage(v57SpiceValidationSummary(v42LastSpiceValidation),false,true);
      else scriptMessage(`Converted ${rows.length} SPICE command row${rows.length===1?'':'s'} to Time estimate commands.`);
    }catch(err){ v49HighlightSpiceErrorFromMessage(err?.message||String(err)); scriptMessage(err?.message||String(err),true); }
  });
  $('scriptCopySpice')?.addEventListener('click',copySpiceScript);
  v42RenderSpiceBackdrop();
};



// ==================== v57 MCU timing / SPICE diagnostics ====================
function v57ReadTimeSettings({mark=true}={}){
  const mcuInput=$('timeMcuSecondsPerUnit');
  const movementInput=$('timeMovementPercent');
  const mcuText=String(mcuInput?.value??'1').trim();
  const movementText=String(movementInput?.value??'1').trim();
  const secondsPerMcu=Number(mcuText);
  const movementPercent=Number(movementText);
  const mcuOk=mcuText!=='' && Number.isFinite(secondsPerMcu) && secondsPerMcu>0;
  const movementOk=movementText!=='' && Number.isFinite(movementPercent) && movementPercent>=0;
  if(mark){
    setTimeInputInvalid(mcuInput,!mcuOk);
    setTimeInputInvalid(movementInput,!movementOk);
  }
  if(!mcuOk) return {ok:false,error:'1 MCU must correspond to a positive number of seconds.'};
  if(!movementOk) return {ok:false,error:'Movement time must be a non-negative percentage.'};
  return {ok:true,secondsPerMcu,movementPercent,movementFactor:1+movementPercent/100};
}
function v57TimeMcuSecondsPerUnit(){
  const settings=v57ReadTimeSettings({mark:false});
  return settings.ok?settings.secondsPerMcu:1;
}
function v57TimeMovementFactor(){
  const settings=v57ReadTimeSettings({mark:false});
  return settings.ok?settings.movementFactor:1.01;
}

// readAllTimeScans reports both the command/counting time and the final time
// including the configurable movement overhead.
readAllTimeScans = function(){
  const settings=v57ReadTimeSettings();
  if(!settings.ok) return settings;
  const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')];
  if(!rows.length) return {ok:false,error:'Add at least one command.'};
  const validation=validateAllTimeScanRows();
  if(!validation.ok) return {ok:false,error:validation.errors.join(' / ')};

  const scans=[];
  const stack=[];
  let multiplier=1,baseSeconds=0,totalPoints=0;
  for(let i=0;i<rows.length;i++){
    const result=validation.results[i];
    if(result.kind==='loop'){
      const iterations=result.loopIterations||1;
      stack.push({rowIndex:i+1,iterations,previousMultiplier:multiplier});
      multiplier*=iterations;
      if(!Number.isFinite(multiplier) || multiplier>Number.MAX_SAFE_INTEGER){
        setTimeScanRowWarning(rows[i],true);
        return {ok:false,error:`Command ${i+1}: loop nesting produces too many repetitions.`};
      }
      continue;
    }
    if(result.kind==='endloop'){
      const opened=stack.pop();
      if(!opened){
        setTimeScanRowWarning(rows[i],true);
        return {ok:false,error:`Command ${i+1}: endloop has no matching loop.`};
      }
      multiplier=opened.previousMultiplier;
      continue;
    }
    const effectiveSeconds=result.seconds*multiplier;
    const effectivePoints=result.points*multiplier;
    scans.push({row:rows[i],...result,loopMultiplier:multiplier,effectiveSeconds,effectivePoints});
    baseSeconds+=effectiveSeconds;
    totalPoints+=effectivePoints;
  }
  if(stack.length){
    const opened=stack[stack.length-1];
    setTimeScanRowWarning(rows[opened.rowIndex-1],true);
    return {ok:false,error:`Command ${opened.rowIndex}: loop has no matching endloop.`};
  }
  const movementSeconds=baseSeconds*settings.movementPercent/100;
  const totalSeconds=baseSeconds+movementSeconds;
  return {ok:true,rows,scans,baseSeconds,movementSeconds,totalSeconds,totalPoints,settings};
};

calculateTimeEstimate = function(){
  clearTimeEstimateMessage();
  const scanData=readAllTimeScans();
  if(!scanData.ok){ setTimeEstimateMessage(scanData.error,true); return; }
  const startResult=readTimeEstimateDate('Start','scan start time');
  if(!startResult.ok){ setTimeEstimateMessage(startResult.error,true); return; }
  const endExact=new Date(startResult.date.getTime()+scanData.totalSeconds*1000);
  writeTimeEstimateDate('End',ceilDateToMinute(endExact));
  saveTimeEstimateState();
  const movement=scanData.settings.movementPercent>0
    ? ` (base ${formatEstimatedDuration(scanData.baseSeconds)} + movement ${formatEstimatedDuration(scanData.movementSeconds)} at ${scanData.settings.movementPercent}%)`
    : '';
  setTimeEstimateMessage(`Estimated duration: ${formatEstimatedDuration(scanData.totalSeconds)}${movement} / ${scanData.totalPoints} execution step${scanData.totalPoints===1?'':'s'} in ${scanData.rows.length} command${scanData.rows.length===1?'':'s'}.`);
};

calculateTimeEstimateMcu = function(){
  clearTimeEstimateMessage();
  const scanData=readAllTimeScans();
  if(!scanData.ok){ setTimeEstimateMessage(scanData.error,true); return; }
  const startResult=validTimeEstimateDateInput('Start','scan start time');
  if(!startResult.ok){ setTimeEstimateMessage(startResult.error,true); return; }
  const endResult=validTimeEstimateDateInput('End','scan finish time');
  if(!endResult.ok){ setTimeEstimateMessage(endResult.error,true); return; }
  const targetSeconds=(endResult.date.getTime()-startResult.date.getTime())/1000;
  if(!(targetSeconds>0)){
    for(const input of [endResult.dateInput,endResult.hourInput,endResult.minuteInput]) setTimeInputInvalid(input,true);
    setTimeEstimateMessage('Scan finish must be later than scan start.',true);
    return;
  }

  const factor=scanData.settings.movementFactor;
  const targetBaseSeconds=targetSeconds/factor;
  const fixedScans=scanData.scans.filter(scan=>scan.fixed);
  const adjustableScans=scanData.scans.filter(scan=>!scan.fixed);
  const fixedSeconds=fixedScans.reduce((sum,scan)=>sum+scan.effectiveSeconds,0);
  const adjustableSeconds=adjustableScans.reduce((sum,scan)=>sum+scan.effectiveSeconds,0);
  const remainingBaseSeconds=targetBaseSeconds-fixedSeconds;
  const eps=1e-9;

  if(remainingBaseSeconds < -eps){
    const fixedWithMovement=fixedSeconds*factor;
    setTimeEstimateMessage(`Fixed commands plus movement overhead already require ${formatEstimatedDuration(fixedWithMovement)}, which exceeds the available ${formatEstimatedDuration(targetSeconds)}.`,true);
    return;
  }
  if(!adjustableScans.length){
    const difference=Math.abs(targetSeconds-scanData.totalSeconds);
    if(difference<=0.01) setTimeEstimateMessage('All adjustable scan MCU values are fixed. The current settings already match the requested finish time.');
    else setTimeEstimateMessage('There are no unfixed scan MCU values available to adjust.',true);
    return;
  }
  if(!(adjustableSeconds>0)){
    if(remainingBaseSeconds<=eps){
      for(const scan of adjustableScans){
        const input=scan.row.querySelector('[data-time-mcu]');
        if(input) input.value='0';
      }
      saveTimeEstimateState();
      setTimeEstimateMessage('Unfixed scan MCU values set to 0; fixed commands and movement overhead use the full available time.');
      return;
    }
    setTimeEstimateMessage('At least one unfixed scan MCU value must be greater than zero to use the entered MCU values as relative weights.',true);
    return;
  }

  const scale=Math.max(0,remainingBaseSeconds)/adjustableSeconds;
  for(const scan of adjustableScans){
    const input=scan.row.querySelector('[data-time-mcu]');
    if(!input) continue;
    input.value=formatScaledMcu((scan.mcuValue??scan.mcuSeconds)*scale);
    setTimeInputInvalid(input,false);
  }
  saveTimeEstimateState();
  const updated=readAllTimeScans();
  const actual=updated.ok?updated.totalSeconds:targetSeconds;
  const movementText=scanData.settings.movementPercent>0?` Movement overhead: ${scanData.settings.movementPercent}%.`:'';
  setTimeEstimateMessage(`Unfixed scan MCU values scaled by ×${Number(scale.toPrecision(6))}; ${fixedScans.length} fixed command${fixedScans.length===1?'':'s'} unchanged.${movementText} Target duration: ${formatEstimatedDuration(targetSeconds)}; calculated duration: ${formatEstimatedDuration(actual)}.`);
};

function v57PreviousSpiceLinesForCommand(commandIndex,oldMap,oldLines){
  const map=oldMap?.[commandIndex];
  if(!map || !(map.start>=1) || !(map.end>=map.start)) return [];
  return oldLines.slice(map.start-1,map.end);
}
function v57CommandNumberFromMessage(message){
  const match=/\bCommand\s+(\d+)\s*:/i.exec(String(message||''));
  return match?Number(match[1]):null;
}
function v57SpiceValidationSummary(validation){
  const messages=[];
  for(const error of validation?.errors||[]){
    const command=v57CommandNumberFromMessage(error);
    const line=command?v42SpiceLineMap[command-1]?.start:null;
    const detail=String(error).replace(/^Command\s+\d+\s*:\s*/i,'');
    messages.push(line?`Line ${line} (Command ${command}): ${detail}`:(command?`Command ${command}: ${detail}`:`Error: ${detail}`));
  }
  for(const warning of validation?.warnings||[]){
    const command=v57CommandNumberFromMessage(warning);
    const line=command?v42SpiceLineMap[command-1]?.start:null;
    const detail=String(warning).replace(/^Command\s+\d+\s*:\s*/i,'');
    messages.push(line?`Warning — Line ${line} (Command ${command}): ${detail}`:(command?`Warning — Command ${command}: ${detail}`:`Warning: ${detail}`));
  }
  return messages.join('\n');
}

// Generate a best-effort macro without replacing invalid commands with # ERROR
// comments. Invalid/warning lines are identified only by the editor highlight;
// their explanations are shown in scriptMessage below the editor.
generateSpiceMacroFromTimeEstimate = function(){
  const validation=validateAllTimeScanRows({showMessage:true});
  const structure=ensureTimeLoopPairIds();
  const area=$('scriptSpiceText');
  const oldLines=String(area?.value??'').split('\n');
  const oldMap=v42SpiceLineMap.map(item=>item?{...item}:item);
  const lines=[];
  v42SpiceLineMap=[]; v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set();
  const commandErrors=new Set((validation.errors||[]).map(v57CommandNumberFromMessage).filter(Number.isFinite));
  const commandWarnings=new Set((validation.warnings||[]).map(v57CommandNumberFromMessage).filter(Number.isFinite));

  for(let i=0;i<structure.rows.length;i++){
    const row=structure.rows[i];
    const result=validation.results[i];
    const info=structure.info.get(row);
    const command=row.querySelector('[data-time-variable]')?.value||result?.command||'drive:s1';
    const start=lines.length+1;
    let rowLines=[];
    if(!result?.ok) rowLines=v57PreviousSpiceLinesForCommand(i,oldMap,oldLines);
    if(!rowLines.length){
      try{
        rowLines=v42SpiceLinesForRow(row,info,result?.command?result:{...result,command});
      }catch(err){
        const message=`Command ${i+1}: ${err?.message||String(err)}`;
        if(!validation.errors.includes(message)) validation.errors.push(message);
        commandErrors.add(i+1);
        rowLines=v57PreviousSpiceLinesForCommand(i,oldMap,oldLines);
      }
    }
    if(!rowLines.length) rowLines=v57PreviousSpiceLinesForCommand(i,oldMap,oldLines);
    if(!rowLines.length) rowLines=[''];
    lines.push(...rowLines);
    const end=lines.length;
    v42SpiceLineMap[i]={start,end};
    if(!result?.ok || commandErrors.has(i+1)) for(let line=start;line<=end;line++) v42SpiceErrorLines.add(line);
    else if(commandWarnings.has(i+1)) for(let line=start;line<=end;line++) v42SpiceWarningLines.add(line);
  }
  validation.ok=validation.errors.length===0;
  v42LastSpiceValidation=validation;
  return lines.join('\n');
};

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
  const uiSign=$('sense').value;
  const config={energy_mode:em,Ei:em==='Ei fixed'?E:null,Ef:em==='Ef fixed'?E:null,geometry:$('geometry').value,sign_config:calculationTasSense(uiSign),ui_sign:uiSign};
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

  const uiSense=b.config.ui_sign ?? checkedValue("sense");

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
  const s2abs=rad2deg(Math.acos(clamp(cosS2,-1,1)));
  // HODACA / pure +-+ has a positive S2 encoder on its physical scattering arm.
  // Do not alter the already-validated +++ and -+- displayed S2 conventions.
  const s2=(uiSense==="+-+") ? +s2abs : senseS*s2abs;

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
  const orientationRef=effectiveOrientationReference(b.rl,fixedE,uiSense);
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
  const omegaTarget=wrap180(tasPhiLabDegForUiSense(ki,kf,s2ForS1,uiSense)-phiTarget);
  const omegaRef=wrap180(tasPhiLabDegForUiSense(k0,k0,s2RefForS1,uiSense)-phiRef);

  // The validated Python simulation uses C2_TO_OMEGA_SIGN = +1 for its
  // native scattering sense.  The opposite TAS sign configuration is the
  // left/right-mirrored instrument, so its sample encoder must run with the
  // opposite C2->omega sign.  Without this factor +-+ and -+- collapse onto
  // the same S1 solution after the signed-S2 geometry is formed.
  //
  //   omega = omega_ref + c2Sign * (S1-S1_ref)
  //   S1    = S1_ref + (omega-omega_ref)/c2Sign
  //
  // Keep the validated +++ and -+- behavior byte-for-byte equivalent to v66.
  // Only the real/pure +-+ branch reverses the sample encoder so positive S1
  // is clockwise (e.g. hexagonal 100 @ 0 deg -> 010 @ +60 deg).
  const c2Sign=(uiSense==="+-+") ? -1 : ((b.config.sign_config==='+-+') ? +1 : -1);
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
  assertImplementedUiSense();
  const resolutionConfig={...b.config,sign_config:legacyTasSense(checkedValue('sense'))};
  const result=calcResolution(b.lc,b.rl,b.col,b.mos,resolutionConfig,b.approximation,b.focusing,b.geom,calc,b.unitMode);
  let angles;
  try{
    angles=tasMotorAngles(calc,b);
  }catch(err){
    // Angle calculation is supplemental.  Do not hide a valid resolution
    // result just because motor angles cannot be determined.
    angles={m1:null,m2:null,s1:null,s2:null,a1:null,a2:null,
      warning:`Angle calculation unavailable: ${userFacingTasMessage(err?.message || String(err))}`};
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
  const selectedSense=checkedValue("sense");
  const uiSense=legacyTasSense(selectedSense);
  const s2Display=Number.isFinite(Number(angles.s2))
    ? (selectedSense==="+-+"
        ? +Math.abs(Number(angles.s2))
        : (uiSense==="+-+" ? -Math.abs(Number(angles.s2)) : +Math.abs(Number(angles.s2))))
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
    style.textContent=`#toolboxPanel .toolbox-grid{grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr))!important;overflow-x:visible!important;align-items:end} #toolboxPanel .toolbox-grid label{min-width:0}`;
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

// ==================== Toolbox: X-ray -> neutron S2 conversion ====================
function updateS2Conversion(){
  const xLambda=Number($("s2ConvXrayLambda")?.value);
  const raw=String($("s2ConvXrayS2")?.value||"").trim();
  const nLambda=fixedInstrumentWavelengthA();
  const nLambdaField=$("s2ConvNeutronLambda");
  const neutronS2Field=$("s2ConvNeutronS2");
  const dField=$("s2ConvD");
  const info=$("s2ConvInfo");
  if(nLambdaField) nLambdaField.value=Number.isFinite(nLambda)?nLambda.toFixed(6):"";
  if(neutronS2Field) neutronS2Field.value="";
  if(dField) dField.value="";
  if(info){ info.textContent=""; info.classList.remove("warning"); }
  if(!(xLambda>0) || !(nLambda>0)){
    if(info){ info.textContent='Enter a positive X-ray wavelength.'; info.classList.add('warning'); }
    return;
  }
  if(!raw){
    if(info){ info.textContent='Enter one or more observed X-ray S2 values between 0° and 180°, separated by spaces.'; info.classList.add('warning'); }
    return;
  }
  const tokens=raw.split(/\s+/).filter(Boolean);
  const values=tokens.map(t=>Number(t));
  if(values.some(v=>!Number.isFinite(v) || !(v>0 && v<180))){
    if(info){ info.textContent='Enter valid X-ray S2 values between 0° and 180°, separated by spaces.'; info.classList.add('warning'); }
    return;
  }
  const rows=values.map(xS2=>{
    const theta=deg2rad(xS2/2);
    const sinTheta=Math.sin(theta);
    const d=xLambda/(2*sinTheta);
    const arg=nLambda/(2*d);
    if(!(sinTheta>0) || !Number.isFinite(d) || !(d>0)){
      return {xS2,d:NaN,neutronS2:NaN,status:'Invalid d-spacing'};
    }
    if(arg>1+1e-12){
      return {xS2,d,neutronS2:NaN,status:'No solution'};
    }
    const neutronS2=2*rad2deg(Math.asin(clamp(arg,-1,1)));
    return {xS2,d,neutronS2,status:''};
  });
  if(neutronS2Field){
    neutronS2Field.value=rows.map(row=>Number.isFinite(row.neutronS2)?row.neutronS2.toFixed(3):'—').join(' ');
  }
  if(dField){
    dField.value=rows.map(row=>Number.isFinite(row.d)?row.d.toFixed(6):'—').join(' ');
  }
  const blocked=rows.filter(r=>r.status).length;
  if(blocked && info){
    info.textContent=`${blocked} entr${blocked===1?'y':'ies'} cannot satisfy the neutron Bragg condition at the current ${checkedValue('energyMode')}.`;
    info.classList.add('warning');
  }
}

function initializeS2Conversion(){
  const source=$("s2ConvSource"), lambda=$("s2ConvXrayLambda"), s2=$("s2ConvXrayS2");
  if(!source || !lambda || !s2) return;
  source.addEventListener('change',()=>{
    if(source.value!=='custom') lambda.value=source.value;
    updateS2Conversion();
  });
  lambda.addEventListener('input',()=>{
    const matching=[...source.options].find(o=>o.value!=='custom' && Math.abs(Number(o.value)-Number(lambda.value))<5e-7);
    source.value=matching?matching.value:'custom';
    updateS2Conversion();
  });
  s2.addEventListener('input',updateS2Conversion);
  for(const id of ['energy','energyMode','instrument']) $(id)?.addEventListener('input',updateS2Conversion);
  for(const id of ['energy','energyMode','instrument']) $(id)?.addEventListener('change',updateS2Conversion);
  updateS2Conversion();
}

// ==================== CIF-based neutron attenuation ====================
function fixedInstrumentWavelengthA(){
  const E=num('energy');
  return E>0 ? Math.sqrt(NEUTRON_E_LAMBDA/E) : NaN;
}

let absorptionBeamUpdating=false;
function syncAbsorptionBeamFromInstrument(){
  if(absorptionBeamUpdating) return;
  const energy=num('energy');
  if(!(energy>0)) return;
  absorptionBeamUpdating=true;
  try{
    if($('absorptionEnergy')) $('absorptionEnergy').value=formatAbsorptionNumber(energy,6);
    if($('absorptionLambda')) $('absorptionLambda').value=formatAbsorptionNumber(Math.sqrt(NEUTRON_E_LAMBDA/energy),6);
  }finally{ absorptionBeamUpdating=false; }
}

function syncAbsorptionBeamFrom(kind){
  if(absorptionBeamUpdating) return;
  const energyField=$('absorptionEnergy'), lambdaField=$('absorptionLambda');
  if(!energyField || !lambdaField) return;
  absorptionBeamUpdating=true;
  try{
    if(kind==='energy'){
      const E=Number(energyField.value);
      if(E>0) lambdaField.value=formatAbsorptionNumber(Math.sqrt(NEUTRON_E_LAMBDA/E),6);
    }else{
      const lambda=Number(lambdaField.value);
      if(lambda>0) energyField.value=formatAbsorptionNumber(NEUTRON_E_LAMBDA/(lambda*lambda),6);
    }
  }finally{ absorptionBeamUpdating=false; }
}

function attenuationWavelengthA(){
  const v=Number($('absorptionLambda')?.value);
  return v>0 ? v : fixedInstrumentWavelengthA();
}

function attenuationEnergyMeV(){
  const v=Number($('absorptionEnergy')?.value);
  if(v>0) return v;
  const lambda=attenuationWavelengthA();
  return lambda>0 ? NEUTRON_E_LAMBDA/(lambda*lambda) : NaN;
}

function formatAbsorptionNumber(value,digits=5){
  const v=Number(value);
  if(!Number.isFinite(v)) return '—';
  if(v===0) return '0';
  if(Math.abs(v)>=1e4 || Math.abs(v)<1e-3) return v.toExponential(4);
  return v.toFixed(digits).replace(/0+$/,'').replace(/\.$/,'');
}

function setAbsorptionThicknessFromTransmissionPercent(percent){
  const overallPct=Number(percent);
  if(!(overallPct>0) || overallPct>100) throw new Error('Overall transmission must be greater than 0% and no more than 100%.');
  if(!selectedCifStructure) throw new Error('Select a CIF before solving thickness from transmission.');
  const seField=$('absorptionSETransmission');
  let sePct=Number(seField?.value);
  if(!Number.isFinite(sePct)) sePct=100;
  sePct=Math.min(100,Math.max(0,sePct));
  if(!(sePct>0)) throw new Error('Overall transmission cannot be solved when SE transmission is 0%.');
  if(overallPct>sePct+1e-9) throw new Error(`Overall transmission cannot exceed the SE transmission (${formatAbsorptionNumber(sePct,3)}%).`);
  const samplePct=overallPct/sePct*100;
  const lambda=attenuationWavelengthA();
  const base=neutronAbsorptionSummary(selectedCifStructure,lambda,0);
  const mu=Number(base.muAttenuationCmInv ?? base.muTotalCmInv);
  let thicknessMm=0;
  if(samplePct<100){
    if(!(mu>0)) throw new Error('This sample has zero calculated attenuation, so a transmission below the SE transmission cannot be reached.');
    thicknessMm=-Math.log(samplePct/100)/mu*10;
  }
  const entry=$('absorptionThickness'), slider=$('absorptionThicknessSlider');
  if(entry) entry.value=formatAbsorptionNumber(thicknessMm,5);
  if(slider){
    if(thicknessMm>Number(slider.max)) slider.max=String(Math.ceil(thicknessMm*100)/100);
    slider.value=String(thicknessMm);
  }
  updateAbsorptionCalculator();
}

function updateAbsorptionCalculator(){
  const host=$('absorptionResults');
  const status=$('absorptionCifStatus');
  const energyField=$('absorptionEnergy');
  const lambdaField=$('absorptionLambda');
  const thicknessEntry=$('absorptionThickness');
  const thicknessSlider=$('absorptionThicknessSlider');
  const transmissionOut=$('absorptionTransmission');
  const seTransmissionField=$('absorptionSETransmission');
  const plot=$('absorptionPlot');
  if(!host || !status || !energyField || !lambdaField || !thicknessEntry || !thicknessSlider || !transmissionOut) return;

  const lambda=attenuationWavelengthA();
  const energyMeV=attenuationEnergyMeV();
  status.value=selectedCifFileName || selectedCifStructure?.name || 'No CIF selected';

  if(!selectedCifStructure){
    transmissionOut.value='';
    host.innerHTML='';
    if(plot && window.Plotly) Plotly.purge(plot);
    return;
  }

  let thicknessMm=Math.max(0,Number(thicknessEntry.value)||0);
  if(document.activeElement!==thicknessEntry) thicknessEntry.value=formatAbsorptionNumber(thicknessMm,2);
  try{
    const r=neutronAbsorptionSummary(selectedCifStructure,lambda,thicknessMm/10);
    const transPct=100*r.transmission;
    const absTransPct=100*r.transmissionAbsorptionOnly;
    let seTransPct=Number(seTransmissionField?.value);
    if(!Number.isFinite(seTransPct)) seTransPct=100;
    seTransPct=Math.min(100,Math.max(0,seTransPct));
    const overallTransPct=transPct*seTransPct/100;
    if(document.activeElement!==transmissionOut) transmissionOut.value=formatAbsorptionNumber(overallTransPct,3);

    const muAtt=Number(r.muAttenuationCmInv ?? r.muTotalCmInv);
    const t50Mm=muAtt>0 ? Math.log(2)/muAtt*10 : 20;
    let sliderMax=Math.max(t50Mm, thicknessMm>t50Mm ? thicknessMm*1.15 : t50Mm);
    if(!(sliderMax>0) || !Number.isFinite(sliderMax)) sliderMax=20;
    sliderMax=Math.min(1000,Math.max(0.5,sliderMax));
    sliderMax=Math.ceil(sliderMax*10)/10;
    thicknessSlider.max=String(sliderMax);
    thicknessSlider.value=String(Math.min(thicknessMm,sliderMax));

    const rows=r.elements.map(e=>{
      const absMu=(Number(e.absContributionBarn)||0)/r.volumeA3;
      const scatMu=(Number(e.scatContributionBarn)||0)/r.volumeA3;
      const ratioDen=(r.muAbsCmInv+r.muScatCmInv) || 1;
      return `<tr><td>${e.element}</td><td>${formatAbsorptionNumber(e.count,4)}</td><td>${formatAbsorptionNumber(absMu,5)}</td><td>${formatAbsorptionNumber(scatMu,5)}</td><td>${formatAbsorptionNumber(100*(absMu+scatMu)/ratioDen,2)}%</td></tr>`;
    }).join('');

    const lengthText=v=>Number.isFinite(v)?`${formatAbsorptionNumber(v,4)} cm`:'∞';
    host.innerHTML=`
      <div class="absorption-summary-cards">
        <div class="absorption-summary-card"><div class="absorption-summary-label">Cell volume</div><div class="absorption-summary-value">${formatAbsorptionNumber(r.volumeA3,4)} Å³</div></div>
        <div class="absorption-summary-card absorption-summary-wide">
          <div class="absorption-summary-label">Scattering cross section</div>
          <div class="absorption-summary-subgrid">
            <div><span>Abs</span><strong>${formatAbsorptionNumber(r.muAbsCmInv,5)} cm⁻¹</strong></div>
            <div><span>Coh</span><strong>${formatAbsorptionNumber(r.muCohCmInv,5)} cm⁻¹</strong></div>
            <div><span>Incoh</span><strong>${formatAbsorptionNumber(r.muIncohCmInv,5)} cm⁻¹</strong></div>
          </div>
        </div>
        <div class="absorption-summary-card absorption-summary-wide">
          <div class="absorption-summary-label">1/e penetration depth</div>
          <div class="absorption-summary-subgrid">
            <div><span>Abs</span><strong>${lengthText(r.absorptionLengthCm)}</strong></div>
            <div><span>Abs + Incoh</span><strong>${lengthText(r.attenuationLengthCm)}</strong></div>
            <div><span>Abs + Incoh + Coh</span><strong>${lengthText(r.fullLengthCm)}</strong></div>
          </div>
        </div>
        <div class="absorption-summary-card absorption-summary-wide">
          <div class="absorption-summary-label">Transmission</div>
          <div class="absorption-summary-subgrid">
            <div><span>Abs</span><strong>${formatAbsorptionNumber(absTransPct,3)}%</strong></div>
            <div><span>Sample total</span><strong>${formatAbsorptionNumber(transPct,3)}%</strong></div>
            <div><span>Overall</span><strong>${formatAbsorptionNumber(overallTransPct,3)}%</strong></div>
          </div>
        </div>
      </div>
      <div class="absorption-table-wrap"><table class="absorption-table absorption-atom-table"><thead><tr><th>Atom</th><th>Atoms / cell</th><th>Abs (cm⁻¹)</th><th>Scat total (cm⁻¹)</th><th>Ratio</th></tr></thead><tbody>${rows}</tbody></table></div>`;

    if(plot && window.Plotly){
      const n=241;
      const x=Array.from({length:n},(_,i)=>sliderMax*i/(n-1));
      const y=x.map(mm=>seTransPct*Math.exp(-muAtt*mm/10));
      Plotly.react(plot,[
        {x,y,mode:'lines',name:'Overall transmission',hovertemplate:'Thickness %{x:.3f} mm<br>Transmission %{y:.3f}%<extra></extra>'},
        {x:[thicknessMm],y:[overallTransPct],mode:'markers',name:'Selected thickness',marker:{size:10},hovertemplate:'Thickness %{x:.3f} mm<br>Transmission %{y:.3f}%<extra></extra>'}
      ],{
        margin:{l:68,r:20,t:28,b:58},
        xaxis:{title:'Sample thickness (mm)',range:[0,sliderMax],zeroline:false},
        yaxis:{title:'Transmission (%)',range:[0,100],zeroline:false},
        showlegend:false,
        uirevision:'absorptionPlot'
      },{responsive:true,displaylogo:false});
    }
  }catch(err){
    transmissionOut.value='';
    host.innerHTML=`<div class="absorption-warning">${String(err?.message||err)}</div>`;
    if(plot && window.Plotly) Plotly.purge(plot);
  }
}

// ==================== Powder Angle calculation helper ====================
function powderWavevectors(hw){
  const E=num('energy');
  const mode=checkedValue('energyMode');
  const Ei=mode==='Ef fixed' ? E+hw : E;
  const Ef=mode==='Ef fixed' ? E : E-hw;
  if(!(Ei>0) || !(Ef>0)) return null;
  return {Ei,Ef,ki:Math.sqrt(Ei/2.072),kf:Math.sqrt(Ef/2.072)};
}

function powderQFromS2AtHW(s2,hw){
  const wv=powderWavevectors(hw);
  if(!wv) return NaN;
  const theta=deg2rad(Math.abs(Number(s2)));
  return Math.sqrt(Math.max(0,wv.ki*wv.ki+wv.kf*wv.kf-2*wv.ki*wv.kf*Math.cos(theta)));
}

function powderSignedS2FromQAtHW(q,hw){
  const s2abs=powderS2ForQAtHW(q,hw);
  if(!Number.isFinite(s2abs)) return NaN;
  return legacyTasSense(checkedValue('sense'))==='+-+' ? -Math.abs(s2abs) : Math.abs(s2abs);
}

function powderLinkDriver(){
  const host=$('powderGeometryTarget');
  return host?.dataset.linkDriver==='s2' ? 's2' : 'q';
}

function setPowderLinkDriver(driver){
  const host=$('powderGeometryTarget');
  if(host) host.dataset.linkDriver=driver==='s2'?'s2':'q';
}

function syncPowderLinkedInputs(driver=powderLinkDriver(),{recalc=false}={}){
  const s2Field=$('powderGeomS2'), qField=$('powderGeomQ'), hwField=$('powderGeomHW');
  if(!s2Field || !qField || !hwField) return;
  const hw=parseNumericValue(hwField.value);
  if(!Number.isFinite(hw)) return;

  if(driver==='s2'){
    const s2=parseNumericValue(s2Field.value);
    if(!Number.isFinite(s2)) return;
    const q=powderQFromS2AtHW(s2,hw);
    if(Number.isFinite(q) && document.activeElement!==qField) qField.value=q.toFixed(6);
  }else{
    const q=parseNumericValue(qField.value);
    if(!Number.isFinite(q)) return;
    const s2=powderSignedS2FromQAtHW(q,hw);
    if(Number.isFinite(s2) && document.activeElement!==s2Field) s2Field.value=s2.toFixed(4);
  }
  if(recalc) scheduleRecalc();
}

function powderGeometryTarget(uiSenseOverride=null,rawSenseForDrawing=false){
  const s2Input=parseNumericValue($('powderGeomS2')?.value);
  const qInput=parseNumericValue($('powderGeomQ')?.value);
  const hw=parseNumericValue($('powderGeomHW')?.value);
  if(!Number.isFinite(s2Input) || !Number.isFinite(qInput) || !Number.isFinite(hw)){
    throw new Error('Enter valid Powder S2, Q and ħω values. Fractions such as 1/2 are accepted.');
  }
  const wv=powderWavevectors(hw);
  if(!wv) throw new Error('This ħω is outside the positive Ei/Ef range.');
  const {Ei,Ef,ki,kf}=wv;

  // The last edited linked field is authoritative. Recalculate the partner once
  // more here so calculations cannot use a stale Q/S2 pair.
  let q,s2abs;
  if(powderLinkDriver()==='s2'){
    s2abs=Math.abs(s2Input);
    if(!(s2abs>=0 && s2abs<=180)) throw new Error('S2 must be between -180° and 180°.');
    q=powderQFromS2AtHW(s2Input,hw);
  }else{
    q=qInput;
    if(!(q>=0)) throw new Error('Q must be non-negative.');
    s2abs=powderS2ForQAtHW(q,hw);
    if(!Number.isFinite(s2abs)) throw new Error('The entered Q is not accessible at this ħω.');
  }

  const braggAngle=(k,d,label)=>{
    const arg=PI/(Number(d)*k);
    if(arg>1+1e-12 || arg<-1-1e-12) throw new Error(`${label} Bragg condition is inaccessible at the selected energy.`);
    return rad2deg(Math.asin(clamp(arg,-1,1)));
  };
  let m1abs=braggAngle(ki,num('dMono'),'Monochromator');
  let a1abs=braggAngle(kf,num('dAna'),'Analyzer');
  if(checkedValue('geometry')==='anti-W') a1abs=-a1abs;

  // Match the same internal/user sign mapping used by Single-crystal Angle
  // calculation. Powder has no sample orientation, so S1 is defined as 0.
  const uiSense=uiSenseOverride ?? checkedValue('sense');
  const requestedSense=legacyTasSense(uiSense);
  const internalSense=rawSenseForDrawing ? requestedSense : calculationTasSense(uiSense);
  let senseM,senseS,senseA;
  if(internalSense==='+-+'){ senseM=+1; senseS=-1; senseA=+1; }
  else if(internalSense==='-+-'){ senseM=-1; senseS=+1; senseA=-1; }
  else throw new Error(`Unsupported TAS sign configuration: ${internalSense}`);

  const angles={
    m1:senseM*m1abs,
    m2:2*senseM*m1abs,
    s1:0,
    s2:senseS*s2abs,
    a1:senseA*a1abs,
    a2:2*senseA*a1abs,
    warning:''
  };
  return {calc:{q,hw,s2:s2abs},q,s2:s2abs,angles,Ei,Ef,ki,kf};
}

function safeResizePlot(el){
  if(typeof Plotly === "undefined" || !Plotly.Plots || !el || !el.isConnected) return;
  const style=window.getComputedStyle?.(el);
  if(style && (style.display==='none' || style.visibility==='hidden')) return;
  if(!(el.offsetWidth>0) || !(el.offsetHeight>0)) return;
  try{
    const result=Plotly.Plots.resize(el);
    if(result && typeof result.catch==='function') result.catch(()=>{});
  }catch(_err){}
}

function resizeVisiblePlots(){
  if(typeof Plotly === "undefined" || !Plotly.Plots) return;
  const panel = [$("qePanel"),$("resolutionPanel"),$("toolboxPanel"),$("cifGeneratorPanel"),$("scriptPanel")].find(p=>p && !p.classList.contains("hidden"));
  if(!panel) return;
  panel.querySelectorAll(".js-plotly-plot").forEach(el=>{
    safeResizePlot(el);
  });
}

let responsivePlotResizeFrame=0;
function scheduleVisiblePlotResize(){
  if(responsivePlotResizeFrame) cancelAnimationFrame(responsivePlotResizeFrame);
  responsivePlotResizeFrame=requestAnimationFrame(()=>{
    responsivePlotResizeFrame=requestAnimationFrame(()=>{
      responsivePlotResizeFrame=0;
      resizeVisiblePlots();
    });
  });
}

function initializeResponsivePlotResize(){
  window.addEventListener('resize',scheduleVisiblePlotResize,{passive:true});
  if(typeof ResizeObserver!=="undefined"){
    const main=document.querySelector('main');
    if(main){
      const observer=new ResizeObserver(scheduleVisiblePlotResize);
      observer.observe(main);
    }
  }
}

function setActiveTab(name){
  const isQE=name==='qe', isResolution=name==='resolution', isToolbox=name==='toolbox', isCifGenerator=name==='cif-generator', isScript=name==='script';
  mountTimeEstimateForScript(isScript);
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
  $('scriptPanel')?.classList.toggle('hidden',!isScript);
  for(const [id,on] of [['tabQe',isQE],['tabResolution',isResolution],['tabToolbox',isToolbox],['tabCifGenerator',isCifGenerator],['tabScript',isScript]]){
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
    .filter(el=>!el.closest?.('.time-estimate-pane') && el.type!=='button' && el.type!=='submit' && el.type!=='file');
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
    return ['qe','resolution','toolbox','cif-generator','script'].includes(name) ? name : 'qe';
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
  const el=$(id); if(!el || value===undefined || el.type==='file') return false;
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

async function tryLoadDir(directory,map,{skipGitHubPages=false}={}){
  if(skipGitHubPages && isGitHubPages()){ map.clear(); return 0; }
  try{return await loadJsonDirectory(directory,map);}catch(_e){map.clear();return 0;}
}
async function tryLoadCifDir(directory,map,{skipGitHubPages=false}={}){
  if(skipGitHubPages && isGitHubPages()){ map.clear(); return 0; }
  try{return await loadCifDirectory(directory,map);}catch(_e){map.clear();return 0;}
}
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
  initializeTimeEstimateUI();
  initializeScriptUI();
  try{
    const savedUnit=localStorage.getItem('tas-qe-map-unit-v1');
    if($('qeMapUnit') && (savedUnit==='ainv'||savedUnit==='rlu')) $('qeMapUnit').value=savedUnit;
    const savedMapTab=localStorage.getItem('tas-qe-map-tab-v1');
    setQEMapTab(savedMapTab==='vector'?'vector':'constant');
  }catch(_e){ setQEMapTab('constant'); }

  // Register the main tabs before any optional async data source is loaded.
  // A missing optional directory or CIF-generator asset must never leave the
  // application stuck with only the initially visible Q-E panel.
  $('tabQe')?.addEventListener('click',()=>setActiveTab('qe'));
  $('tabResolution')?.addEventListener('click',()=>setActiveTab('resolution'));
  $('tabToolbox')?.addEventListener('click',()=>setActiveTab('toolbox'));
  $('tabCifGenerator')?.addEventListener('click',()=>setActiveTab('cif-generator'));
  $('tabScript')?.addEventListener('click',()=>setActiveTab('script'));

  setStatus('neutron data / instrument / BG_material / sample_environments loading...');
  let nNeutron=0;
  try{ nNeutron=await initializeNeutronData(); }
  catch(err){ console.warn('Neutron data load warning:',err); }
  const nInstrument=await loadJsonDirectory('instrument',instruments);
  const [nBG,nSE]=await Promise.all([
    // Optional data directories are loaded on every host.  GitHub Pages uses
    // the repository contents API, so no directory/index.json probe is needed.
    tryLoadCifDir('BG_material',backgroundMaterials),
    tryLoadDir('sample_environments',sampleEnvironments)
  ]);
  // The unified instrument/ directory is the preferred source. On localhost,
  // do not probe a possibly absent legacy instruments/ directory at startup;
  // that failed compatibility probe only creates noisy 404s. Static/GitHub
  // deployments retain the legacy fallback during migration.
  const needsLegacy=[...instruments.values()].some(inst=>!(Array.isArray(inst.S2_limits)||(inst.qe_range&&(Array.isArray(inst.qe_range.S2_limits)||Array.isArray(inst.qe_range.configuration)))));
  if(needsLegacy && !isLocalDirectoryListingHost() && !isGitHubPages()){
    // `instruments/` is only a legacy compatibility source.  On GitHub Pages
    // the unified `instrument/` directory is authoritative; probing a removed
    // legacy directory causes a visible 404 and can also hit a stale repo URL.
    await tryLoadDir('instruments',legacyRangeInstruments);
  }
  mergeLegacyRangeData();
  refreshSelect(instruments,$('instrument'),null);setBackgroundCount(Number($('backgroundCount')?.value)||1);for(const slot of darkAssetSlots()) refreshDarkEnvironmentSelect(slot);
  if(!instruments.size) throw new Error('instrument directory has no JSON files.');
  $('instrument').selectedIndex=0;for(const i of backgroundRowIndices()) $(`backgroundSelect${i}`).value='';for(const slot of darkAssetSlots()) $(darkAssetIds(slot).se).value='';applyInstrumentDefaults();for(const slot of darkAssetSlots()) applySampleEnvironmentDefaults(slot);updateBackgroundSelectAvailability();
  // JSON configuration is now fully loaded.  Only at this point is it safe to
  // overlay browser-local user parameters (including the selected instrument).
  const restoredLocalState=restoreLeftPanelState();
  if(currentGeometryCardTab()==='time') validateAllTimeScanRows({showMessage:true});
  // Restoring sidebar values can change Dark-angle Reference after the sample-
  // environment defaults were applied.  Re-sync the h/k/l row explicitly.
  for(const slot of darkAssetSlots()) updateDarkReferenceUI(slot);
  // Geometry starts at the current Reference Q HKL while preserving the current energy transfer.
  setGeometryTargetHKL([num("refh"),num("refk"),num("refl")]);
  setPropagationVectorCount(propagationVectorIndices().length); setDarkAssetCount(darkAssetSlots().length); updatePropagationVectorLabels(); ensureExtendedToolboxUI(); ensureNuclearLabelControl(); ensureQESliderControls(); updateCifUI();
  try{ await initializeCifGenerator(); }
  catch(err){ console.warn('CIF Generator initialization warning:',err); }
  // Right-side controls are restored only after dynamic Toolbox controls exist and
  // after the default geometry target has been initialized, so saved values win.
  const restoredRightState=restoreRightPanelState();
  syncSfColorMaxControl("restore");
  enableRightPanelPersistence();
  for(const id of ['toolLambda','toolEnergy','toolK','toolTHz','toolTemp','toolCm','toolVelocity','toolMass','toolField','toolJ','toolCal']) $(id).addEventListener('input',()=>setToolboxFrom(id));
  $('absorptionThickness')?.addEventListener('input',()=>{
    const slider=$('absorptionThicknessSlider');
    const entry=$('absorptionThickness');
    if(!entry) return;
    const raw=entry.value;
    // Preserve intermediate typing states such as "0." instead of normalizing
    // the field immediately and deleting the decimal point.
    if(raw==='' || /[.]$/.test(raw)) return;
    const parsed=Number(raw);
    if(!Number.isFinite(parsed) || parsed<0) return;
    if(slider){
      if(parsed>Number(slider.max)) slider.max=String(parsed);
      slider.value=String(parsed);
    }
    updateAbsorptionCalculator();
  });
  $('absorptionThickness')?.addEventListener('change',()=>updateAbsorptionCalculator());
  $('absorptionThicknessSlider')?.addEventListener('input',()=>{
    const slider=$('absorptionThicknessSlider'), entry=$('absorptionThickness');
    if(slider && entry) entry.value=Number(slider.value).toFixed(2).replace(/\.?0+$/,'');
    updateAbsorptionCalculator();
  });
  $('absorptionTransmission')?.addEventListener('change',()=>{
    const field=$('absorptionTransmission');
    try{ setAbsorptionThicknessFromTransmissionPercent(field?.value); }
    catch(err){ showError(err); updateAbsorptionCalculator(); }
  });
  $('absorptionTransmission')?.addEventListener('keydown',event=>{
    if(event.key==='Enter'){ event.preventDefault(); event.currentTarget.blur(); }
  });
  initializeS2Conversion();
  $('absorptionCifSelectButton')?.addEventListener('click',()=>$('absorptionCifFileInput')?.click());
  $('absorptionCifFileInput')?.addEventListener('change',async()=>{
    const input=$('absorptionCifFileInput');
    const file=input?.files?.[0];
    if(!file) return;
    try{ await selectCifFile(file); }
    catch(err){ showError(err); }
    finally{ if(input) input.value=''; }
  });
  $('absorptionEnergy')?.addEventListener('input',()=>{ syncAbsorptionBeamFrom('energy'); updateAbsorptionCalculator(); });
  $('absorptionLambda')?.addEventListener('input',()=>{ syncAbsorptionBeamFrom('lambda'); updateAbsorptionCalculator(); });
  $('absorptionSETransmission')?.addEventListener('input',()=>updateAbsorptionCalculator());
  $('absorptionSETransmission')?.addEventListener('change',()=>{
    const field=$('absorptionSETransmission');
    if(!field) return;
    let v=Number(field.value);
    if(!Number.isFinite(v)) v=100;
    v=Math.min(100,Math.max(0,v));
    field.value=formatAbsorptionNumber(v,3);
    updateAbsorptionCalculator();
  });
  $('energy')?.addEventListener('input',()=>{ syncAbsorptionBeamFromInstrument(); updateAbsorptionCalculator(); });
  for(const id of ['energy','energyMode','instrument']) $(id)?.addEventListener('change',()=>{ syncAbsorptionBeamFromInstrument(); updateAbsorptionCalculator(); });
  syncAbsorptionBeamFromInstrument();
  updateAbsorptionCalculator();
  $('powderGeomS2')?.addEventListener('input',()=>{ setPowderLinkDriver('s2'); syncPowderLinkedInputs('s2'); });
  $('powderGeomQ')?.addEventListener('input',()=>{ setPowderLinkDriver('q'); syncPowderLinkedInputs('q'); });
  $('powderGeomHW')?.addEventListener('input',()=>syncPowderLinkedInputs());
  for(const id of ['energy','energyMode','sense']) $(id)?.addEventListener('change',()=>{
    if(checkedValue('sampleMode')==='powder') syncPowderLinkedInputs();
  });
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
  setToolboxFrom('toolLambda'); syncPowderLinkedInputs();
  initializeResponsivePlotResize();
  setActiveTab(savedActiveTab());
  $('gm1').addEventListener('change',updateSupermirrorUI);$('calcMode').addEventListener('change',updateCalcMode);$('calc').addEventListener('click',doSingleResolution);$('calcScan').addEventListener('click',doScanResolution);$('scanSlider').addEventListener('input',()=>renderResolutionScan(num('scanSlider')));$('prev').addEventListener('click',()=>renderResolutionScan(num('scanSlider')-1));$('next').addEventListener('click',()=>renderResolutionScan(num('scanSlider')+1));
  for(const id of ['a','b','c','alpha','beta','gamma','Uh','Uk','Ul','Vh','Vk','Vl']) $(id).addEventListener('input',updateAutoW);
  // Keep the Bragg-reference plane warning live as lattice/plane/HKL inputs change.
  for(const id of ['a','b','c','alpha','beta','gamma','Uh','Uk','Ul','Vh','Vk','Vl','refh','refk','refl']){
    $(id)?.addEventListener('input',updateBraggOrientationPlaneWarning);
    $(id)?.addEventListener('change',updateBraggOrientationPlaneWarning);
  }
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
  setStatus(`${nInstrument} instrument(s), ${nBG} BG CIF material(s), ${nSE} sample environment(s), ${nNeutron} neutron-data record(s) loaded${(restoredLocalState||restoredRightState) ? ' / local parameters restored' : ''}`);recalculate();
}
initialize().catch(err=>{showError(err);setStatus('Configuration loading failed. Open the project through an HTTP server.');});
