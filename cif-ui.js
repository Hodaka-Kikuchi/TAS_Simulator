// Extracted from app.js without changing calculation/display behavior.
// Dependencies are injected by app.js to keep module boundaries explicit.
const LEFT_PANEL_STORAGE_KEY='tas-qe-left-panel-v1';
const SELECTED_CIF_STORAGE_KEY='tas-simulator-selected-cif-v1';

export function createCifUI(deps){
  const {
    $,
    PI,
    RL_calc,
    add,
    canonicalReflectionHkl,
    checkedValue,
    clamp,
    clearError,
    compareHkl,
    cross,
    currentInstrument,
    dot,
    effectiveS2MaxAtEi,
    hklKey,
    hklToQ,
    makeSpiceScatteringPlaneBasis,
    norm,
    nuclearStructureFactorSquared,
    num,
    parseCifStructure,
    parseNumericValue,
    rad2deg,
    reciprocalSymmetryMatrices,
    reflectionStar,
    saveLeftPanelState,
    scheduleRecalc,
    updateAutoW,
    updateModeVisibility,
    updateAbsorptionCalculator,
    getPropagationVectors,
    setPropagationVectorsFromFile,
    getSelectedCifStructure,
    getSelectedCifFileName,
    getSelectedCifText,
    setSelectedCifState
  }=deps;

function hasSelectedCif(){
  return checkedValue("sampleMode")==="single" && !!getSelectedCifStructure();
}

function updateCifUI(){
  const row=$("cifSelectRow");
  if(row) row.classList.remove("hidden");
  const name=$("cifFileName");
  if(name){
    name.value=getSelectedCifFileName() || "No file selected";
    if(getSelectedCifStructure()){
      const bits=[getSelectedCifStructure().name];
      if(getSelectedCifStructure().spaceGroup) bits.push(`Space group: ${getSelectedCifStructure().spaceGroup}`);
      bits.push(`${getSelectedCifStructure().asymmetricSiteCount} asymmetric site(s)`);
      bits.push(`${getSelectedCifStructure().symmetryOperationCount} symmetry operation(s)`);
      name.title=bits.join(" | ");
    }else name.title="";
  }
  const clearButton=$("cifClearButton");
  if(clearButton) clearButton.disabled=!getSelectedCifStructure();
  const structureName=$("structureCifName");
  if(structureName) structureName.value=getSelectedCifFileName() || "No CIF selected";
  const structureClear=$("structureCifClear");
  if(structureClear) structureClear.disabled=!getSelectedCifStructure();
  if($("structureMcifShowCurrent")) $("structureMcifShowCurrent").disabled=!getSelectedCifText();
  const showCurrentButton=$("cifShowCurrent");
  if(showCurrentButton) showCurrentButton.disabled=!getSelectedCifText();
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

function saveSelectedCifLocal(text,fileName){
  try{
    const payload={version:1,fileName:String(fileName||"selected_structure.cif"),text:String(text||"")};
    if(payload.text) localStorage.setItem(SELECTED_CIF_STORAGE_KEY,JSON.stringify(payload));
  }catch(_e){}
}
function restoreSelectedCifLocal(){
  let saved;
  try{ saved=JSON.parse(localStorage.getItem(SELECTED_CIF_STORAGE_KEY)||"null"); }catch(_e){ return false; }
  if(!saved || saved.version!==1 || !saved.text) return false;
  try{
    loadCifText(saved.text,saved.fileName||"selected_structure.cif",{persist:false});
    return true;
  }catch(_e){
    try{ localStorage.removeItem(SELECTED_CIF_STORAGE_KEY); }catch(__e){}
    return false;
  }
}

function propagationVectorsFromMcif(text,parsed){
  const lines=String(text||'').replace(/\r/g,'').split('\n');
  const result=[];
  for(let i=0;i<lines.length;i++){
    if(lines[i].trim().toLowerCase()!=='loop_') continue;
    let j=i+1, tags=[];
    while(j<lines.length && lines[j].trim().startsWith('_')){tags.push(lines[j].trim().toLowerCase());j++;}
    const idx=tags.findIndex(tag=>['_parent_propagation_vector.kxkykz','_parent_propagation_vector_kxkykz'].includes(tag));
    if(idx<0) continue;
    while(j<lines.length){
      const row=lines[j].trim();
      if(!row || row.startsWith('#')){j++;continue;}
      if(row==='loop_' || row.startsWith('_') || /^data_/i.test(row)) break;
      const match=row.match(/\[([^\]]+)\]/);
      const components=match ? match[1].split(/[\s,]+/) : row.split(/\s+/).slice(idx,idx+3);
      const nums=components.map(Number);
      if(nums.length===3 && nums.every(Number.isFinite)) result.push({h:nums[0],k:nums[1],l:nums[2],enabled:true});
      j++;
    }
  }
  if(!result.length && parsed?.incommensurateSingleQ) for(const q of (parsed.propagationVectors||[])) result.push({h:q.h,k:q.k,l:q.l,enabled:true});
  return result;
}

function loadCifText(text,fileName="generated_structure.cif",{persist=true}={}){
  const parsed=parseCifStructure(text);
  const cifText=String(text??"");
  const importedQ=propagationVectorsFromMcif(cifText,parsed);
  if(importedQ.length) setPropagationVectorsFromFile?.(importedQ);
  if($("mcifPreviewText")) $("mcifPreviewText").textContent=cifText;
  if($("structureMcifGeneratedName")) $("structureMcifGeneratedName").value=cleanMcifBaseName(fileName);
  invalidateGeneratedMcif();
  // Save the currently displayed structure before switching.  Settings are
  // stored per structure fingerprint, so they can only return for the same CIF.
  saveStructureViewerState();
  setSelectedCifState(parsed,fileName,cifText);
  cifStructureSourcePreference="selected";
  restoreStructureViewerState();
  if(parsed.magnetic){
    // Imported mCIF vectors are authoritative. Restore visual preferences,
    // but never allow an old local XYZ value to override the file's moments.
    for(const [siteIndex,site] of (parsed.asymmetricSites||[]).entries()){
      const key=momentKey({...site,siteIndex});
      const saved=structureMomentSettings.get(key)||{};
      const imported=defaultMomentSetting(site,parsed);
      structureMomentSettings.set(key,{...saved,enabled:imported.enabled,
        mx:imported.mx,my:imported.my,mz:imported.mz});
    }
    // Clear live inputs before rebuilding or they could overwrite the imported
    // XYZ vectors during updateMagneticMomentRows().
    $("cifMagMomentRows")?.replaceChildren();
    structureControlSignature="";
  }
  prepareStructureViewerControls();
  if(persist) saveSelectedCifLocal(cifText,fileName);

  // A selected/generated CIF defines the crystallographic unit cell. Keep the
  // existing U/V orientation indices, but synchronize the six lattice fields.
  const sg=findGeneratorSpaceGroup(parsed);
  if(sg) setSampleSpaceGroup(sg.number,{recalc:false});
  const lattice=parsed?.lattice || {};
  // Use the exact reported mCIF cell parameters, not symmetry-normalized values.
  for(const id of ["a","b","c","alpha","beta","gamma"]){
    const value=Number(lattice[id]);
    if(Number.isFinite(value) && $(id)) $(id).value=String(value);
  }

  // Keep CIF Generator synchronized with the currently selected sample CIF.
  // Only editable generator fields are populated; file inputs are never set
  // programmatically.
  if(cifSpaceGroups.length) loadParsedCifIntoGenerator(parsed,fileName,{message:false});

  updateAutoW();
  updateCifUI();
  clearError();
  scheduleRecalc();
  renderCifStructureIfVisible();
  return parsed;
}

async function selectCifFile(file){
  if(!file) return;
  return loadCifText(await file.text(),file.name);
}

function clearSelectedCif(){
  saveStructureViewerState();
  setSelectedCifState(null,"","");
  resetStructureViewerStateToDefaults();
  try{ localStorage.removeItem(SELECTED_CIF_STORAGE_KEY); }catch(_e){}
  cifStructureSourcePreference="selected";
  if($("cifFileInput")) $("cifFileInput").value="";
  if(cifSpaceGroups.length) setSampleSpaceGroup(1,{recalc:false});
  else{
    if($("sampleSpaceGroup")) $("sampleSpaceGroup").value="1";
    if($("sampleSpaceGroupNumber")) $("sampleSpaceGroupNumber").value="1";
  }
  updateCifUI();
  clearError();
  saveLeftPanelState();
  scheduleRecalc();
  renderCifStructureIfVisible();
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
    opt.textContent=sg.hm;
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

const CIF_GENERATOR_ATOMS_STORAGE_KEY="tas-simulator-cif-generator-atoms-v1";
let restoringCifGeneratorAtoms=false;

function currentCifGeneratorAtomRows(){
  return [...document.querySelectorAll("#cifAtomRows .cif-atom-row")].map(cifAtomRowValues).filter(Boolean);
}
function saveCifGeneratorAtomsState(){
  if(restoringCifGeneratorAtoms) return;
  try{ localStorage.setItem(CIF_GENERATOR_ATOMS_STORAGE_KEY,JSON.stringify({version:1,atoms:currentCifGeneratorAtomRows()})); }catch(_e){}
}
function restoreCifGeneratorAtomsState(){
  let saved;
  try{ saved=JSON.parse(localStorage.getItem(CIF_GENERATOR_ATOMS_STORAGE_KEY)||"null"); }catch(_e){ return false; }
  if(!saved || saved.version!==1 || !Array.isArray(saved.atoms) || !saved.atoms.length) return false;
  restoringCifGeneratorAtoms=true;
  try{ replaceCifAtomRows(saved.atoms); return true; }
  finally{ restoringCifGeneratorAtoms=false; }
}

let lastGeneratedCifText="";
let lastGeneratedCifName="generated_structure.cif";
let selectedCifReflectionKey="";
let cifReflectionSort={key:"intensity",direction:"desc"};
let lastGeneratedCifParsed=null;
let lastGeneratedCifSpaceGroup=null;
let lastGeneratedReflections=[];
let cifStructureViewMode="a";
let cifStructureSourcePreference="generated";
let loadedGeneratorCifStructure=null;
let loadedGeneratorCifName="";
const STRUCTURE_VIEWER_STORAGE_KEY="tas-simulator-structure-viewer-v2";
let restoringStructureViewer=false;
let restoredStructureBondRules=null;
let structureCameraState=null;
let structureProgrammaticCameraUpdate=false;
let structureCameraWatchFrame=0;
let structureCameraWatchSignature="";
let structureMomentStructureType="collinear";
let structureMomentRotationAxis="c";
let structureMomentChirality="CCW";
let structureMomentPropagationIndex=0;
let structureMomentDirectionMode="cartesian";
let structureConfigActiveTab="atoms";
let structureMomentGlobalLength=1;
let structureMomentGlobalWidth=10;
let structureMomentGlobalHeadSize=0.51;
let structureMomentGlobalWidthBlank=false;
let structureMomentGlobalHeadBlank=false;
let structureUnitCellMode="one";
let structureShowXYZ=true;
// Every CIF asymmetric site is available in the Spins tab.
// Only transition-metal and rare-earth sites start enabled by default;
// all other elements (for example O) remain available but start disabled.
const DEFAULT_SPIN_ELEMENTS=new Set([
  // 3d / 4d / 5d transition metals
  "SC","TI","V","CR","MN","FE","CO","NI","CU","ZN",
  "Y","ZR","NB","MO","TC","RU","RH","PD","AG","CD",
  "HF","TA","W","RE","OS","IR","PT","AU","HG",
  // Rare-earth elements (lanthanides; Sc/Y are already included above)
  "LA","CE","PR","ND","PM","SM","EU","GD","TB","DY","HO","ER","TM","YB","LU"
]);
const structureAtomColorOverrides=new Map();
const structureAtomSizeOverrides=new Map();
const structureAtomSizeCleared=new Set();
const structureAtomVisibility=new Map();
const structureMomentSettings=new Map();
const structureElementDefaultColors=new Map();
let structureControlSignature="";
const STRUCTURE_PALETTE=["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf","#c2185b","#009688"];

function structureStateFingerprint(structure){
  if(!structure) return "";
  const raw=structureSignature(structure);
  // Small deterministic FNV-1a fingerprint.  This is only a localStorage key,
  // not a security hash.  The full structure signature is also stored in the
  // saved entry so an accidental hash collision cannot restore the wrong state.
  let h=0x811c9dc5;
  for(let i=0;i<raw.length;i++){
    h^=raw.charCodeAt(i);
    h=Math.imul(h,0x01000193)>>>0;
  }
  return h.toString(16).padStart(8,"0");
}
function currentStructureStateIdentity(){
  const source=currentStructureForViewer();
  if(!source?.structure) return null;
  const signature=structureSignature(source.structure);
  return {fingerprint:structureStateFingerprint(source.structure),signature};
}
function readStructureViewerStateStore(){
  try{
    const parsed=JSON.parse(localStorage.getItem(STRUCTURE_VIEWER_STORAGE_KEY)||"null");
    if(parsed?.version===2 && parsed.states && typeof parsed.states==="object") return parsed;
  }catch(_e){}
  return {version:2,states:{}};
}
function resetStructureViewerStateToDefaults(){
  restoringStructureViewer=true;
  try{
    cifStructureViewMode="a";
    structureCameraState=null;
    structureCameraWatchSignature="";
    for(const axis of ["x","y","z"]){
      const cap=axis.toUpperCase();
      if($("cifRange"+cap)) $("cifRange"+cap).value="0 1";
      if($("cifRange"+cap+"Min")) $("cifRange"+cap+"Min").value="0";
      if($("cifRange"+cap+"Max")) $("cifRange"+cap+"Max").value="1";
    }
    structureAtomColorOverrides.clear();
    structureAtomSizeOverrides.clear();
    structureAtomSizeCleared.clear();
    structureAtomVisibility.clear();
    structureMomentSettings.clear();
    structureMomentStructureType="collinear";
    structureMomentRotationAxis="c";
    structureMomentChirality="CCW";
    structureMomentPropagationIndex=0;
    structureMomentDirectionMode="cartesian";
    structureConfigActiveTab="atoms";
    structureMomentGlobalLength=1;
    structureMomentGlobalWidth=10;
    structureMomentGlobalHeadSize=0.51;
    structureMomentGlobalWidthBlank=false;
    structureMomentGlobalHeadBlank=false;
    structureUnitCellMode="one";
    structureShowXYZ=true;
    restoredStructureBondRules=[];
    structureControlSignature="";
    
    const unitCellSelect=$("cifUnitCellMode"); if(unitCellSelect) unitCellSelect.value="one";
    const xyzSelect=$("cifShowXYZ"); if(xyzSelect) xyzSelect.value="show";
  }finally{ restoringStructureViewer=false; }
}
function saveStructureViewerState(){
  if(restoringStructureViewer) return;
  try{
    const identity=currentStructureStateIdentity();
    if(!identity) return;
    const liveMoments=currentMomentSettings();
    for(const [key,value] of liveMoments) structureMomentSettings.set(key,value);
    const payload={
      signature:identity.signature,
      viewMode:cifStructureViewMode,
      range:structureRange(),
      atomColors:Object.fromEntries(structureAtomColorOverrides),
      atomSizes:Object.fromEntries(structureAtomSizeOverrides),
      atomSizeCleared:[...structureAtomSizeCleared],
      atomVisible:Object.fromEntries(structureAtomVisibility),
      moments:Object.fromEntries(structureMomentSettings),
      momentStructureType:structureMomentStructureType,
      momentRotationAxis:structureMomentRotationAxis,
      momentChirality:structureMomentChirality,
      momentPropagationIndex:structureMomentPropagationIndex,
      momentDirectionMode:structureMomentDirectionMode,
      configActiveTab:structureConfigActiveTab,
      momentCoordinatesVersion:3,
      momentGlobalLength:structureMomentGlobalLength,
      momentGlobalWidth:structureMomentGlobalWidth,
      momentGlobalHeadSize:structureMomentGlobalHeadSize,
      momentGlobalWidthBlank:structureMomentGlobalWidthBlank,
      momentGlobalHeadBlank:structureMomentGlobalHeadBlank,
      unitCellMode:structureUnitCellMode,
      showXYZ:structureShowXYZ,
      bonds:readStructureBondRules()
    };
    const store=readStructureViewerStateStore();
    store.states[identity.fingerprint]=payload;
    localStorage.setItem(STRUCTURE_VIEWER_STORAGE_KEY,JSON.stringify(store));
  }catch(_e){}
}
function sourceIsMagneticCif(){return currentStructureForViewer()?.structure?.magnetic===true;}
function restoreStructureViewerState(){
  const identity=currentStructureStateIdentity();
  if(!identity){ resetStructureViewerStateToDefaults(); return false; }
  const store=readStructureViewerStateStore();
  const saved=store.states?.[identity.fingerprint];
  // Different CIF/structure: never leak atom colours, spin settings or bonds
  // from the previously displayed structure.
  if(!saved || saved.signature!==identity.signature){
    resetStructureViewerStateToDefaults();
    return false;
  }
  restoringStructureViewer=true;
  try{
    // Always start the Structure viewer from the crystallographic a direction.
    cifStructureViewMode="a";
    structureCameraState=null;
    structureCameraWatchSignature="";
    for(const axis of ["x","y","z"]){
      const cap=axis.toUpperCase();
      const legacy=Number(saved.repeat?.[axis]);
      const minValue=Number(saved.range?.[axis]?.min);
      const maxValue=Number(saved.range?.[axis]?.max);
      const min=Number.isFinite(minValue)?minValue:0;
      const max=Number.isFinite(maxValue)?maxValue:(Number.isFinite(legacy)?legacy:1);
      if($("cifRange"+cap)) $("cifRange"+cap).value=`${min} ${max}`;
      if($("cifRange"+cap+"Min")) $("cifRange"+cap+"Min").value=String(min);
      if($("cifRange"+cap+"Max")) $("cifRange"+cap+"Max").value=String(max);
    }
    structureAtomColorOverrides.clear();
    for(const [element,color] of Object.entries(saved.atomColors||{})) if(/^#[0-9a-f]{6}$/i.test(String(color))) structureAtomColorOverrides.set(element,String(color));
    structureAtomSizeOverrides.clear();
    for(const [element,size] of Object.entries(saved.atomSizes||{})){ const n=Number(size); if(Number.isFinite(n)) structureAtomSizeOverrides.set(element,n); }
    structureAtomSizeCleared.clear();
    for(const element of (Array.isArray(saved.atomSizeCleared)?saved.atomSizeCleared:[])) structureAtomSizeCleared.add(String(element));
    structureAtomVisibility.clear();
    for(const [element,visible] of Object.entries(saved.atomVisible||{})) structureAtomVisibility.set(element,visible!==false);
    structureMomentSettings.clear();
    for(const [key,value] of Object.entries(saved.moments||{})) if(value && typeof value==="object") structureMomentSettings.set(key,{...value});
    if(sourceIsMagneticCif() && saved.momentCoordinatesVersion!==3) {
      for(const site of (currentStructureForViewer()?.structure?.asymmetricSites||[])) {
        if(!Array.isArray(site.magneticMoment)) continue;
        const key=momentKey({...site,siteIndex:(currentStructureForViewer()?.structure?.asymmetricSites||[]).indexOf(site)});
        const existing=structureMomentSettings.get(key)||{};
        const canonical=defaultMomentSetting(site,currentStructureForViewer().structure);
        structureMomentSettings.set(key,{...existing,mx:canonical.mx,my:canonical.my,mz:canonical.mz,size:1});
      }
    }
    if(["collinear","helical","sinusoidal"].includes(String(saved.momentStructureType||""))) structureMomentStructureType=String(saved.momentStructureType);
    else if(String(saved.momentStructureType||"")==="canted") structureMomentStructureType="collinear";
    if(["a","b","c"].includes(String(saved.momentRotationAxis||""))) structureMomentRotationAxis=String(saved.momentRotationAxis);
    if(["CW","CCW"].includes(String(saved.momentChirality||""))) structureMomentChirality=String(saved.momentChirality);
    { const n=Number(saved.momentPropagationIndex); structureMomentPropagationIndex=Number.isInteger(n)&&n>0?n:0; }
    if(["cartesian","polar"].includes(String(saved.momentDirectionMode||""))) structureMomentDirectionMode=String(saved.momentDirectionMode);
    structureConfigActiveTab=["atoms","spins","bonds"].includes(saved.configActiveTab)?saved.configActiveTab:"atoms";
    { const n=Number(saved.momentGlobalLength); if(Number.isFinite(n)&&n>=0) structureMomentGlobalLength=n; }
    { const n=Number(saved.momentGlobalWidth); if(Number.isFinite(n)&&n>=1) structureMomentGlobalWidth=n; }
    { const n=Number(saved.momentGlobalHeadSize); if(Number.isFinite(n)&&n>0) structureMomentGlobalHeadSize=n; }
    structureMomentGlobalWidthBlank=saved.momentGlobalWidthBlank===true;
    structureMomentGlobalHeadBlank=saved.momentGlobalHeadBlank===true;
    if(["all","one","none"].includes(String(saved.unitCellMode||""))) structureUnitCellMode=String(saved.unitCellMode);
    else structureUnitCellMode="one";
    structureShowXYZ=saved.showXYZ!==false;
    restoredStructureBondRules=Array.isArray(saved.bonds)?saved.bonds.map(x=>({...x})):[];
    structureControlSignature="";
    
    const unitCellSelect=$("cifUnitCellMode"); if(unitCellSelect) unitCellSelect.value=structureUnitCellMode;
    const xyzSelect=$("cifShowXYZ"); if(xyzSelect) xyzSelect.value=structureShowXYZ?"show":"hide";
    return true;
  }finally{ restoringStructureViewer=false; }
}

function vecAdd(a,b){ return [a[0]+b[0],a[1]+b[1],a[2]+b[2]]; }
function vecSub(a,b){ return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
function vecScale(v,s){ return [v[0]*s,v[1]*s,v[2]*s]; }
function vecDot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function vecCross(a,b){ return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
function vecNorm(v){ return Math.hypot(v[0],v[1],v[2]); }
function vecNormalize(v){ const n=vecNorm(v); return n>1e-12 ? [v[0]/n,v[1]/n,v[2]/n] : [0,0,1]; }
function directionToPolar(v){
  const n=vecNormalize(v);
  const theta=Math.acos(Math.max(-1,Math.min(1,n[2])))*180/PI;
  let phi=Math.atan2(n[1],n[0])*180/PI;
  if(phi<0) phi+=360;
  return {theta,phi};
}
function directionFromPolar(thetaDeg,phiDeg){
  const theta=Number(thetaDeg)*PI/180, phi=Number(phiDeg)*PI/180;
  if(!Number.isFinite(theta)||!Number.isFinite(phi)) return [0,0,1];
  return [Math.sin(theta)*Math.cos(phi),Math.sin(theta)*Math.sin(phi),Math.cos(theta)];
}
function fracWrap01(x){ return ((x%1)+1)%1; }
function clampInt(value,min,max,fallback=1){
  const n=Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min,Math.min(max,n)) : fallback;
}
function directLatticeBasis(lattice){
  const a=Number(lattice?.a), b=Number(lattice?.b), c=Number(lattice?.c);
  const al=Number(lattice?.alpha||90)*PI/180;
  const be=Number(lattice?.beta||90)*PI/180;
  const ga=Number(lattice?.gamma||90)*PI/180;
  if(![a,b,c,al,be,ga].every(Number.isFinite) || !(a>0&&b>0&&c>0)) return null;
  const ca=Math.cos(al), cb=Math.cos(be), cg=Math.cos(ga), sg=Math.sin(ga);
  if(Math.abs(sg)<1e-12) return null;
  const avec=[a,0,0];
  const bvec=[b*cg,b*sg,0];
  const cx=c*cb;
  const cy=c*(ca-cb*cg)/sg;
  const cz2=Math.max(0,c*c-cx*cx-cy*cy);
  const cvec=[cx,cy,Math.sqrt(cz2)];
  const V=vecDot(avec,vecCross(bvec,cvec));
  if(!(Math.abs(V)>1e-12)) return null;
  const astar=vecScale(vecCross(bvec,cvec),1/V);
  const bstar=vecScale(vecCross(cvec,avec),1/V);
  const cstar=vecScale(vecCross(avec,bvec),1/V);
  return {a:avec,b:bvec,c:cvec,astar,bstar,cstar,volume:Math.abs(V)};
}
function fractionalToCartesian(basis,frac){
  return vecAdd(vecAdd(vecScale(basis.a,frac[0]),vecScale(basis.b,frac[1])),vecScale(basis.c,frac[2]));
}
function supercellCenter(basis,repeats){
  return vecScale(vecAdd(vecAdd(vecScale(basis.a,repeats.x),vecScale(basis.b,repeats.y)),vecScale(basis.c,repeats.z)),0.5);
}
function hashString(str){
  let h=0;
  const s=String(str||"");
  for(let i=0;i<s.length;i++) h=((h<<5)-h+s.charCodeAt(i))|0;
  return Math.abs(h);
}
function hslToHex(h,s,l){
  s/=100; l/=100;
  const c=(1-Math.abs(2*l-1))*s;
  const x=c*(1-Math.abs((h/60)%2-1));
  const m=l-c/2;
  let r=0,g=0,b=0;
  if(h<60){r=c;g=x;} else if(h<120){r=x;g=c;} else if(h<180){g=c;b=x;} else if(h<240){g=x;b=c;} else if(h<300){r=x;b=c;} else {r=c;b=x;}
  const hex=v=>Math.round((v+m)*255).toString(16).padStart(2,"0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
function assignDistinctElementColors(elements){
  structureElementDefaultColors.clear();
  elements.forEach((element,index)=>{
    const color=index<STRUCTURE_PALETTE.length ? STRUCTURE_PALETTE[index] : hslToHex((index*137.508)%360,68,50);
    structureElementDefaultColors.set(String(element),color);
  });
}
function defaultElementColor(element){
  return structureElementDefaultColors.get(String(element||"")) || STRUCTURE_PALETTE[hashString(element)%STRUCTURE_PALETTE.length];
}
function elementColor(element){
  return structureAtomColorOverrides.get(String(element||"")) || defaultElementColor(element);
}
function defaultElementRadius(_element){
  return 10;
}
function elementRadius(element){
  const override=Number(structureAtomSizeOverrides.get(String(element||"")));
  return Number.isFinite(override) ? Math.max(2,Math.min(30,override)) : defaultElementRadius(element);
}
function currentStructureForViewer(){
  if(cifStructureSourcePreference==="loaded" && loadedGeneratorCifStructure) return {structure:loadedGeneratorCifStructure,label:loadedGeneratorCifName||"loaded mCIF",kind:"loaded"};
  const preferSelected=cifStructureSourcePreference==="selected";
  if(preferSelected && getSelectedCifStructure()) return {structure:getSelectedCifStructure(), label:getSelectedCifFileName()||"selected CIF", kind:"selected"};
  try{
    const generated=buildGeneratedCif();
    return {structure:generated.parsed, label:generated.filename, kind:"draft"};
  }catch(_err){ /* fall back below */ }
  if(lastGeneratedCifParsed) return {structure:lastGeneratedCifParsed, label:lastGeneratedCifName, kind:"generated"};
  if(getSelectedCifStructure()) return {structure:getSelectedCifStructure(), label:getSelectedCifFileName()||"selected CIF", kind:"selected"};
  return null;
}
function isStructurePanelVisible(){
  const panel=$("structurePanel");
  return !!panel && !panel.classList.contains("hidden");
}
function renderCifStructureIfVisible(){
  if(isStructurePanelVisible() && $("mcifStructurePane") && !$("mcifStructurePane").classList.contains("hidden")) renderCifStructureView();
}
function enabledPropagationVectorsForStructure(){
  const rows=(typeof getPropagationVectors==="function" ? getPropagationVectors() : []) || [];
  return rows.map((row,index)=>({
    index:index+1,
    h:parseNumericValue(row?.h),
    k:parseNumericValue(row?.k),
    l:parseNumericValue(row?.l),
    enabled:!!row?.enabled
  })).filter(q=>q.enabled && [q.h,q.k,q.l].every(Number.isFinite));
}
function parseStructureRangeEntry(value){
  const parts=String(value??"").trim().split(/[\s,]+/).filter(Boolean);
  let min=Number(parts[0]), max=Number(parts[1]);
  if(!Number.isFinite(min)) min=0;
  if(!Number.isFinite(max)) max=1;
  if(max<min) [min,max]=[max,min];
  if(Math.abs(max-min)<1e-9) max=min+1;
  return {min,max};
}
function structureRange(){
  const out={};
  for(const axis of ["x","y","z"]){
    const cap=axis.toUpperCase();
    const legacy=$("cifRange"+cap);
    const minInput=$("cifRange"+cap+"Min");
    const maxInput=$("cifRange"+cap+"Max");
    if(minInput && maxInput){
      let min=Number(minInput.value), max=Number(maxInput.value);
      if(!Number.isFinite(min) || !Number.isFinite(max)){
        const parsed=parseStructureRangeEntry(legacy?.value);
        if(!Number.isFinite(min)) min=parsed.min;
        if(!Number.isFinite(max)) max=parsed.max;
      }
      if(max<min) [min,max]=[max,min];
      if(Math.abs(max-min)<1e-9) max=min+1;
      out[axis]={min,max};
    }else{
      out[axis]=parseStructureRangeEntry(legacy?.value);
    }
  }
  return out;
}
function normalizeStructureRangeInputs(){
  const range=structureRange();
  for(const axis of ["x","y","z"]){
    const cap=axis.toUpperCase();
    const legacy=$("cifRange"+cap);
    const minInput=$("cifRange"+cap+"Min");
    const maxInput=$("cifRange"+cap+"Max");
    if(minInput) minInput.value=String(range[axis].min);
    if(maxInput) maxInput.value=String(range[axis].max);
    // Keep the original combined entry synchronized for backward-compatible
    // localStorage state, but it is hidden once the split controls are built.
    if(legacy) legacy.value=`${range[axis].min} ${range[axis].max}`;
  }
  return range;
}
function rangeCellBounds(rangeAxis){
  return {from:Math.floor(rangeAxis.min),to:Math.ceil(rangeAxis.max)-1};
}
function structureCameraForView(viewMode,basis,distance=2.4){
  const viewVec=basis?.[viewMode] || basis?.cstar || [0,0,1];
  const eye=vecScale(vecNormalize(viewVec),distance);
  const upCandidates=[basis?.c,basis?.b,basis?.a,basis?.cstar,basis?.bstar,basis?.astar].filter(Boolean).map(vecNormalize);
  let up=upCandidates.find(v=>Math.abs(vecDot(v,vecNormalize(viewVec)))<0.85) || [0,0,1];
  if(vecNorm(up)<1e-12) up=[0,0,1];
  return {eye:{x:eye[0],y:eye[1],z:eye[2]}, up:{x:up[0],y:up[1],z:up[2]}, center:{x:0,y:0,z:0}};
}
function currentStructureCameraDistance(){
  const camera=$("cifStructurePlot")?._fullLayout?.scene?.camera;
  const eye=camera?.eye;
  const d=Math.hypot(Number(eye?.x)||0,Number(eye?.y)||0,Number(eye?.z)||0);
  return d>0.2 ? d : 2.4;
}
function currentStructureCamera(){
  const camera=$("cifStructurePlot")?._fullLayout?.scene?.camera;
  if(!camera?.eye) return null;
  const copy={
    eye:{x:Number(camera.eye.x)||0,y:Number(camera.eye.y)||0,z:Number(camera.eye.z)||0},
    up:{x:Number(camera.up?.x)||0,y:Number(camera.up?.y)||0,z:Number(camera.up?.z)||1},
    center:{x:Number(camera.center?.x)||0,y:Number(camera.center?.y)||0,z:Number(camera.center?.z)||0}
  };
  const d=Math.hypot(copy.eye.x,copy.eye.y,copy.eye.z);
  return d>0.2 ? copy : null;
}
function copyStructureCamera(camera){
  if(!camera?.eye) return null;
  const copy={
    eye:{x:Number(camera.eye.x)||0,y:Number(camera.eye.y)||0,z:Number(camera.eye.z)||0},
    up:{x:Number(camera.up?.x)||0,y:Number(camera.up?.y)||0,z:Number(camera.up?.z)||1},
    center:{x:Number(camera.center?.x)||0,y:Number(camera.center?.y)||0,z:Number(camera.center?.z)||0}
  };
  const d=Math.hypot(copy.eye.x,copy.eye.y,copy.eye.z);
  return d>0.2 ? copy : null;
}
function cameraFromRelayoutEvent(ev){
  if(!ev || typeof ev!=="object") return null;
  if(ev["scene.camera"]?.eye) return copyStructureCamera(ev["scene.camera"]);
  const base=copyStructureCamera(structureCameraState) || currentStructureCamera() || {eye:{x:1.55,y:1.55,z:1.25},up:{x:0,y:0,z:1},center:{x:0,y:0,z:0}};
  let touched=false;
  for(const part of ["eye","up","center"]){
    for(const axis of ["x","y","z"]){
      const key=`scene.camera.${part}.${axis}`;
      if(ev[key]!==undefined){ base[part][axis]=Number(ev[key])||0; touched=true; }
    }
  }
  return touched ? copyStructureCamera(base) : null;
}
function structureCameraForTriad(camera){
  return copyStructureCamera(camera) || structureCameraState || {eye:{x:1.55,y:1.55,z:1.25},up:{x:0,y:0,z:1},center:{x:0,y:0,z:0}};
}
function projectStructureDirection(v,camera){
  const c=structureCameraForTriad(camera);
  const eye=[c.eye.x,c.eye.y,c.eye.z];
  const forward=vecNormalize(vecScale(eye,-1));
  let up=vecNormalize([c.up.x,c.up.y,c.up.z]);
  let right=vecNormalize(vecCross(forward,up));
  if(vecNorm(right)<1e-9) right=[1,0,0];
  up=vecNormalize(vecCross(right,forward));
  const u=vecNormalize(v);
  return {x:vecDot(u,right),y:vecDot(u,up),depth:vecDot(u,forward)};
}
function renderStructureTriad(svg,names,vectors,camera){
  if(!svg) return;
  const NS='http://www.w3.org/2000/svg';
  svg.replaceChildren();
  const colors=['#d62728','#2ca02c','#1f77b4'];
  const center={x:80,y:80};
  const axisLength=54; // 1.5x the original on-screen axis length.
  const labelOffset=22;
  vectors.forEach((v,i)=>{
    const p=projectStructureDirection(v,camera);
    const x2=center.x+p.x*axisLength;
    const y2=center.y-p.y*axisLength;
    const marker=document.createElementNS(NS,'marker');
    marker.id=`${svg.id}-arrow-${i}`;
    marker.setAttribute('markerWidth','18'); // 3x the original head size.
    marker.setAttribute('markerHeight','18');
    marker.setAttribute('refX','8');
    marker.setAttribute('refY','5');
    marker.setAttribute('orient','auto');
    marker.setAttribute('markerUnits','userSpaceOnUse');
    marker.setAttribute('viewBox','0 0 10 10');
    const head=document.createElementNS(NS,'path');
    head.setAttribute('d','M 0 0 L 10 5 L 0 10 z');
    head.setAttribute('fill',colors[i]);
    marker.appendChild(head);
    let defs=svg.querySelector('defs');
    if(!defs){ defs=document.createElementNS(NS,'defs'); svg.appendChild(defs); }
    defs.appendChild(marker);
    const line=document.createElementNS(NS,'line');
    line.setAttribute('x1',String(center.x)); line.setAttribute('y1',String(center.y));
    line.setAttribute('x2',String(x2)); line.setAttribute('y2',String(y2));
    line.setAttribute('stroke',colors[i]); line.setAttribute('stroke-width','4');
    line.setAttribute('stroke-linecap','round');
    line.setAttribute('marker-end',`url(#${marker.id})`);
    svg.appendChild(line);
    const text=document.createElementNS(NS,'text');
    const n=Math.hypot(p.x,p.y)||1;
    text.setAttribute('x',String(x2+(p.x/n)*labelOffset));
    text.setAttribute('y',String(y2-(p.y/n)*labelOffset));
    text.setAttribute('fill',colors[i]);
    text.setAttribute('font-size','36'); // 3x the original label size.
    text.setAttribute('font-weight','700');
    text.setAttribute('text-anchor','middle');
    text.setAttribute('dominant-baseline','central');
    text.textContent=names[i];
    svg.appendChild(text);
  });
}
function updateStructureOrientationTriads(basis,camera=null){
  const c=structureCameraForTriad(camera || structureCameraState || currentStructureCamera());
  renderStructureTriad($("cifDirectTriad"),["a","b","c"],[basis.a,basis.b,basis.c],c);
  renderStructureTriad($("cifReciprocalTriad"),["a*","b*","c*"],[basis.astar,basis.bstar,basis.cstar],c);
}
function structureCameraSignature(camera){
  const c=copyStructureCamera(camera);
  if(!c) return "";
  return [c.eye.x,c.eye.y,c.eye.z,c.up.x,c.up.y,c.up.z,c.center.x,c.center.y,c.center.z]
    .map(v=>Number(v).toFixed(7)).join(",");
}
function stopStructureCameraWatch(){
  if(structureCameraWatchFrame) cancelAnimationFrame(structureCameraWatchFrame);
  structureCameraWatchFrame=0;
  structureCameraWatchSignature="";
}
function startStructureCameraWatch(){
  stopStructureCameraWatch();
  const tick=()=>{
    if(!isStructurePanelVisible()){ structureCameraWatchFrame=0; return; }
    const camera=currentStructureCamera();
    const sig=structureCameraSignature(camera);
    if(camera && sig && sig!==structureCameraWatchSignature){
      structureCameraWatchSignature=sig;
      structureCameraState=copyStructureCamera(camera);
      const latest=directLatticeBasis(currentStructureForViewer()?.structure?.lattice);
      if(latest) updateStructureOrientationTriads(latest,structureCameraState);
    }
    structureCameraWatchFrame=requestAnimationFrame(tick);
  };
  structureCameraWatchFrame=requestAnimationFrame(tick);
}
function buildOneCellEdgeTrace(basis,range){
  const x=[],y=[],z=[];
  const append=(p,q)=>{ x.push(p[0],q[0],null); y.push(p[1],q[1],null); z.push(p[2],q[2],null); };
  const ix=Math.floor((range.x.min+range.x.max)*0.5);
  const iy=Math.floor((range.y.min+range.y.max)*0.5);
  const iz=Math.floor((range.z.min+range.z.max)*0.5);
  const p=(fx,fy,fz)=>fractionalToCartesian(basis,[fx,fy,fz]);
  const p000=p(ix,iy,iz), p100=p(ix+1,iy,iz), p010=p(ix,iy+1,iz), p001=p(ix,iy,iz+1);
  const p110=p(ix+1,iy+1,iz), p101=p(ix+1,iy,iz+1), p011=p(ix,iy+1,iz+1), p111=p(ix+1,iy+1,iz+1);
  for(const [a,b] of [[p000,p100],[p000,p010],[p000,p001],[p100,p110],[p100,p101],[p010,p110],[p010,p011],[p001,p101],[p001,p011],[p110,p111],[p101,p111],[p011,p111]]) append(a,b);
  return {type:"scatter3d",mode:"lines",x,y,z,name:"Unit cell",hoverinfo:"skip",showlegend:false,line:{color:"#000",width:3}};
}
function buildAllCellEdgeTrace(basis,range){
  const x=[],y=[],z=[];
  const append=(p,q)=>{ x.push(p[0],q[0],null); y.push(p[1],q[1],null); z.push(p[2],q[2],null); };
  const xb=rangeCellBounds(range.x), yb=rangeCellBounds(range.y), zb=rangeCellBounds(range.z);
  const p=(fx,fy,fz)=>fractionalToCartesian(basis,[fx,fy,fz]);
  for(let ix=xb.from;ix<=xb.to;ix++) for(let iy=yb.from;iy<=yb.to;iy++) for(let iz=zb.from;iz<=zb.to;iz++){
    const p000=p(ix,iy,iz), p100=p(ix+1,iy,iz), p010=p(ix,iy+1,iz), p001=p(ix,iy,iz+1);
    const p110=p(ix+1,iy+1,iz), p101=p(ix+1,iy,iz+1), p011=p(ix,iy+1,iz+1), p111=p(ix+1,iy+1,iz+1);
    for(const [a,b] of [[p000,p100],[p000,p010],[p000,p001],[p100,p110],[p100,p101],[p010,p110],[p010,p011],[p001,p101],[p001,p011],[p110,p111],[p101,p111],[p011,p111]]) append(a,b);
  }
  return {type:"scatter3d",mode:"lines",x,y,z,name:"Unit cells",hoverinfo:"skip",showlegend:false,line:{color:"#000",width:3}};
}
function unitCellTraces(basis,range){
  if(structureUnitCellMode==="none") return [];
  return [structureUnitCellMode==="all" ? buildAllCellEdgeTrace(basis,range) : buildOneCellEdgeTrace(basis,range)];
}
function updateStructureAtomLegend(elements){
  const host=$("cifAtomLegend");
  if(!host) return;
  host.replaceChildren();
  for(const element of elements){
    if(structureAtomVisibility.get(String(element))===false) continue;
    const item=document.createElement("span"); item.className="structure-atom-legend-item";
    const dot=document.createElement("i"); dot.className="structure-atom-legend-dot"; dot.style.background=elementColor(element);
    const text=document.createElement("span"); text.textContent=element;
    item.append(dot,text); host.appendChild(item);
  }
  host.classList.toggle("hidden",!host.children.length);
}
function structureElements(structure){
  // One shared ordering rule for Atoms, Spins, Bonds and the in-plot legend:
  // preserve the order in which each element first appears in the CIF.
  const atoms=(Array.isArray(structure?.asymmetricSites) && structure.asymmetricSites.length ? structure.asymmetricSites : (structure?.atoms || []));
  const seen=new Set(), out=[];
  for(const atom of atoms){
    const element=String(atom?.element||"").trim();
    if(!element || seen.has(element)) continue;
    seen.add(element); out.push(element);
  }
  return out;
}
function naturalStructureLabelCompare(a,b){
  return String(a||"").localeCompare(String(b||""),undefined,{numeric:true,sensitivity:"base"});
}
function makePaletteButtons(current,onPick){
  const host=document.createElement("div");
  host.className="structure-color-palette";
  for(const color of STRUCTURE_PALETTE){
    const button=document.createElement("button");
    button.type="button";
    button.className="structure-color-chip";
    button.style.background=color;
    button.title=color;
    button.setAttribute("aria-label",`Set color ${color}`);
    if(color.toLowerCase()===String(current||"").toLowerCase()) button.classList.add("selected");
    button.addEventListener("click",()=>{
      host.querySelectorAll(".structure-color-chip").forEach(b=>b.classList.toggle("selected",b===button));
      onPick(color);
    });
    host.appendChild(button);
  }
  return host;
}
function makeMomentColorPicker(current,onPick){
  const custom=document.createElement("input");
  custom.type="color";
  custom.className="structure-moment-color-swatch";
  custom.value=current;
  custom.dataset.momentField="color";
  custom.title="Arrow color";
  custom.addEventListener("input",()=>onPick(custom.value));
  return custom;
}
function syncDefaultMomentColorsForElement(element,color){
  for(const row of document.querySelectorAll("#cifMagMomentRows .structure-moment-row")){
    if(row.dataset.momentElement!==String(element)) continue;
    if(row.dataset.momentColorCustom==="1") continue;
    const key=row.dataset.momentKey;
    const cur=currentMomentSettings().get(key);
    if(cur){ cur.color=color; cur.colorCustomized=false; structureMomentSettings.set(key,cur); }
    row.dataset.momentColor=color;
    const input=row.querySelector('[data-moment-field="color"]');
    if(input) input.value=color;
  }
}
function compressStructureSiteLabels(labels,element=""){
  const cleaned=[...new Set((labels||[]).map(x=>String(x||"").trim()).filter(Boolean))];
  if(cleaned.length<=1) return cleaned.join("");
  const parsed=cleaned.map(label=>{
    const m=label.match(/^(.*?)(\d+)$/);
    return m ? {label,prefix:m[1],n:Number(m[2])} : null;
  });
  if(parsed.every(Boolean)){
    const prefix=parsed[0].prefix;
    const nums=parsed.map(x=>x.n).sort((a,b)=>a-b);
    const samePrefix=parsed.every(x=>x.prefix===prefix);
    const consecutive=nums.every((n,i)=>i===0 || n===nums[i-1]+1);
    if(samePrefix && consecutive && nums.length>2) return `${prefix}${nums[0]}–${nums[nums.length-1]}`;
  }
  if(cleaned.length>5){
    const first=cleaned[0], last=cleaned[cleaned.length-1];
    return `${first}…${last}`;
  }
  return cleaned.join(", ");
}

function setSpinEnabledForElement(element,enabled){
  const target=String(element||"");
  const live=currentMomentSettings();
  for(const [key,value] of live) structureMomentSettings.set(key,value);
  for(const row of document.querySelectorAll("#cifMagMomentRows .structure-moment-row")){
    if(String(row.dataset.momentElement||"")!==target) continue;
    const checkbox=row.querySelector('[data-moment-field="enabled"]');
    if(checkbox) checkbox.checked=!!enabled;
    const key=row.dataset.momentKey;
    if(!key) continue;
    const cur=structureMomentSettings.get(key)||{};
    structureMomentSettings.set(key,{...cur,enabled:!!enabled});
  }
  syncSpinElementToggleStates();
}
function syncSpinElementToggleStates(){
  const host=$("cifSpinElementToggles");
  if(!host) return;
  for(const checkbox of host.querySelectorAll('input[data-spin-element]')){
    const element=String(checkbox.dataset.spinElement||"");
    const rows=[...document.querySelectorAll("#cifMagMomentRows .structure-moment-row")].filter(row=>String(row.dataset.momentElement||"")===element);
    const states=rows.map(row=>!!row.querySelector('[data-moment-field="enabled"]')?.checked);
    const checked=states.length>0 && states.every(Boolean);
    const any=states.some(Boolean);
    checkbox.checked=checked;
    checkbox.indeterminate=any && !checked;
  }
}
function updateSpinElementToggles(structure){
  const host=$("cifSpinElementToggles");
  if(!host) return;
  host.replaceChildren();
  const elements=structureElements(structure);
  for(const element of elements){
    const label=document.createElement("label");
    label.className="structure-spin-element-toggle";
    const checkbox=document.createElement("input");
    checkbox.type="checkbox";
    checkbox.dataset.spinElement=element;
    const text=document.createElement("span");
    text.textContent=`All ${element}`;
    checkbox.addEventListener("change",()=>{
      setSpinEnabledForElement(element,checkbox.checked);
      saveStructureViewerState();
      renderCifStructureIfVisible();
    });
    label.append(checkbox,text);
    host.appendChild(label);
  }
  syncSpinElementToggleStates();
}
function updateStructureAtomColorRows(elements,structure=null){
  const host=$("cifAtomColorRows");
  if(!host) return;
  host.replaceChildren();
  if(!elements.length){
    const div=document.createElement("div"); div.className="structure-rows-empty"; div.textContent="No atoms available."; host.appendChild(div); return;
  }
  for(const element of elements){
    const row=document.createElement("div"); row.className="structure-color-row";
    const visible=document.createElement("input");
    visible.type="checkbox";
    visible.checked=structureAtomVisibility.get(element)!==false;
    visible.title="Show this atom element";
    const name=document.createElement("span");
    const siteLabels=[...new Set((structure?.asymmetricSites||[]).filter(site=>String(site.element||"")===element).map(site=>String(site.label||"").trim()).filter(Boolean))];
    name.textContent=siteLabels.length ? compressStructureSiteLabels(siteLabels,element) : element;
    name.title=siteLabels.length ? `${element}: ${siteLabels.join(", ")}` : element;
    const size=document.createElement("input");
    size.type="number"; size.min="2"; size.max="30"; size.step="1";
    const savedSize=Number(structureAtomSizeOverrides.get(element));
    const defaultSize=defaultElementRadius(element);
    size.value=structureAtomSizeCleared.has(element) ? "" : (Number.isFinite(savedSize) ? String(savedSize) : String(defaultSize));
    size.placeholder=String(defaultSize);
    size.title="Atom display size (leave blank for default)";
    const sizeField=document.createElement("label"); sizeField.className="structure-entry-field";
    const sizeCaption=document.createElement("span"); sizeCaption.className="structure-entry-label"; sizeCaption.textContent="Size";
    sizeField.append(sizeCaption,size);
    const custom=document.createElement("input");
    custom.type="color"; custom.className="structure-color-swatch"; custom.value=elementColor(element); custom.title="Custom atom color";
    const applyColor=color=>{
      structureAtomColorOverrides.set(element,color);
      saveStructureViewerState();
      custom.value=color;
      row.querySelectorAll('.structure-color-chip').forEach(b=>b.classList.toggle('selected',b.title.toLowerCase()===color.toLowerCase()));
      syncDefaultMomentColorsForElement(element,color);
      renderCifStructureIfVisible();
    };
    custom.addEventListener("input",()=>applyColor(custom.value));
    visible.addEventListener("change",()=>{
      structureAtomVisibility.set(element,visible.checked);
      if(!visible.checked) setSpinEnabledForElement(element,false);
      saveStructureViewerState();
      renderCifStructureIfVisible();
    });
    size.addEventListener("input",()=>{
      const raw=String(size.value||"").trim();
      const n=Number(raw);
      if(!raw || !Number.isFinite(n)){
        structureAtomSizeOverrides.delete(element);
        structureAtomSizeCleared.add(element);
      }else{
        structureAtomSizeOverrides.set(element,Math.max(2,Math.min(30,n)));
        structureAtomSizeCleared.delete(element);
      }
      saveStructureViewerState(); renderCifStructureIfVisible();
    });
    row.append(visible,name,sizeField,makePaletteButtons(elementColor(element),applyColor),custom);
    host.appendChild(row);
  }
}
function magneticCandidateSites(structure){
  const sites=Array.isArray(structure?.asymmetricSites) ? structure.asymmetricSites : [];
  const elementOrder=new Map(structureElements(structure).map((element,index)=>[String(element),index]));
  return sites.map((site,index)=>({...site,siteIndex:index})).sort((a,b)=>{
    const ea=elementOrder.get(String(a.element)) ?? Number.MAX_SAFE_INTEGER;
    const eb=elementOrder.get(String(b.element)) ?? Number.MAX_SAFE_INTEGER;
    if(ea!==eb) return ea-eb;
    const byLabel=naturalStructureLabelCompare(a.label||a.element,b.label||b.element);
    return byLabel || a.siteIndex-b.siteIndex;
  });
}
function momentKey(site){ return `${site.siteIndex}:${site.label||site.element}`; }
// mCIF crystalaxis values are components along unit crystallographic
// directions, not fractional atomic coordinates. Never multiply moments
// by lattice lengths a, b, c (in Angstrom).
function mcifCrystalAxisToCartesian(basis,m){
  if(!basis || !Array.isArray(m)) return m?.slice()||[0,0,0];
  const ua=vecNormalize(basis.a),ub=vecNormalize(basis.b),uc=vecNormalize(basis.c);
  return vecAdd(vecAdd(vecScale(ua,m[0]),vecScale(ub,m[1])),vecScale(uc,m[2]));
}

function evaluateFourierCrystalMoment(model,phase){
  if(!model) return [0,0,0];
  const cosVec=Array.isArray(model.cos)?model.cos:[0,0,0];
  const sinVec=Array.isArray(model.sin)?model.sin:[0,0,0];
  const arg=2*PI*((Number(model.phaseSign)||1)*phase + (Number(model.phaseShift)||0));
  let out=[0,0,0].map((_,i)=>(Number(cosVec[i])||0)*Math.cos(arg) + (Number(sinVec[i])||0)*Math.sin(arg));
  if(Array.isArray(model.transformR)){
    const factor=Number.isFinite(Number(model.transformFactor)) ? Number(model.transformFactor) : 1;
    out=model.transformR.map(row=>factor*row.reduce((sum,x,j)=>sum+x*out[j],0));
  }
  return out;
}
function representativeCrystalMoment(site){
  const base=Array.isArray(site?.magneticMoment)?site.magneticMoment.slice():[0,0,0];
  if(site?.magneticFourier){
    const mod=evaluateFourierCrystalMoment({...site.magneticFourier,phaseSign:1,phaseShift:0},0);
    return base.map((v,i)=>v+(mod[i]||0));
  }
  return base;
}
function atomCrystalMoment(atom,frac){
  const base=Array.isArray(atom?.magneticMoment)?atom.magneticMoment.slice():[0,0,0];
  if(atom?.magneticFourier){
    const q=atom.magneticFourier.q||[0,0,0];
    const phase=(Number(q[0])||0)*(Number(frac[0])||0) + (Number(q[1])||0)*(Number(frac[1])||0) + (Number(q[2])||0)*(Number(frac[2])||0);
    const mod=evaluateFourierCrystalMoment(atom.magneticFourier,phase);
    return base.map((v,i)=>v+(mod[i]||0));
  }
  return base;
}
function defaultMomentSetting(site,structure=null){
  const element=String(site.element||"").toUpperCase();
  const hasMoment=Array.isArray(site.magneticMoment);
  const hasFourier=!!site?.magneticFourier;
  // Sunny uses the mCIF cell matrix to turn crystalaxis components into
  // Cartesian magnetic moments; do not show unconverted components as XYZ.
  const basis=directLatticeBasis(structure?.lattice);
  const representative=representativeCrystalMoment(site);
  const cart=(hasMoment||hasFourier)&&basis ? mcifCrystalAxisToCartesian(basis,representative) : null;
  const isMcif=structure?.magnetic===true;
  return {enabled:hasMoment || hasFourier || (!isMcif&&DEFAULT_SPIN_ELEMENTS.has(element)),
    mx:cart?.[0]??0,my:cart?.[1]??0,mz:cart?.[2]??(isMcif?0:1),
    size:1,width:10,headSize:0.51,color:elementColor(site.element),colorCustomized:false};
}
// Four significant digits are for display only; never round stored vectors.
function formatSpinValue(value){
  const n=Number(value);
  if(!Number.isFinite(n)) return "0";
  if(Math.abs(n)<1e-12) return "0";
  return String(Number(n.toPrecision(4)));
}
function currentMomentSettings(){
  const rows=[...document.querySelectorAll("#cifMagMomentRows .structure-moment-row")];
  const out=new Map();
  for(const row of rows){
    const key=row.dataset.momentKey;
    if(!key) continue;
    const fallback=structureMomentSettings.get(key)||{};
    let mx=Number(fallback.mx)||0, my=Number(fallback.my)||0, mz=Number(fallback.mz);
    if(!Number.isFinite(mz)) mz=1;
    const readEditedNumber=(field)=>{
      const input=row.querySelector(`[data-moment-field="${field}"]`);
      if(!input) return null;
      const shown=String(input.value);
      const precise=Number(input.dataset.fullPrecision);
      return shown===input.dataset.displayValue && Number.isFinite(precise) ? precise : Number(shown);
    };
    const thetaInput=row.querySelector('[data-moment-field="theta"]');
    const phiInput=row.querySelector('[data-moment-field="phi"]');
    if(thetaInput || phiInput){
      const magnitudeInput=row.querySelector('[data-moment-field="moment"]');
      const untouched=[thetaInput,phiInput,magnitudeInput].every(input=>input && input.value===input.dataset.displayValue);
      if(!untouched){
        const theta=readEditedNumber("theta"), phi=readEditedNumber("phi"), magnitude=readEditedNumber("moment");
        if([theta,phi,magnitude].every(Number.isFinite) && magnitude>=0) [mx,my,mz]=vecScale(directionFromPolar(theta,phi),magnitude);
      }
    }else{
      for(const field of ["mx","my","mz"]){
        const value=readEditedNumber(field);
        if(Number.isFinite(value)) {if(field==="mx") mx=value; else if(field==="my") my=value; else mz=value;}
      }
    }
    out.set(key,{
      enabled:!!row.querySelector('[data-moment-field="enabled"]')?.checked,
      mx,my,mz,size:structureMomentGlobalLength,
      width:structureMomentGlobalWidth,headSize:structureMomentGlobalHeadSize,
      color:row.querySelector('[data-moment-field="color"]')?.value || row.dataset.momentColor || elementColor(row.dataset.momentElement),
      colorCustomized:row.dataset.momentColorCustom==="1"
    });
  }
  return out;
}
function updateMagneticMomentRows(structure){
  const host=$("cifMagMomentRows");
  if(!host) return;
  const live=currentMomentSettings();
  for(const [key,value] of live) structureMomentSettings.set(key,value);
  host.replaceChildren();
  const sites=magneticCandidateSites(structure);
  if(!sites.length){
    const div=document.createElement("div"); div.className="structure-rows-empty"; div.textContent="No atomic sites were found in the CIF asymmetric unit."; host.appendChild(div); return;
  }
  sites.forEach((site,siteOrder)=>{
    const key=momentKey(site);
    const saved=structureMomentSettings.get(key)||{};
    const setting={...defaultMomentSetting(site,structure),...saved};
    // For mCIF, loaded components are physical Cartesian moments, not fractional coordinates.
    // Keep the original physical components in XYZ; Length is a visual-only control.
    if(!setting.colorCustomized && !saved.colorCustomized) setting.color=elementColor(site.element);
    const row=document.createElement("div");
    row.className="structure-moment-row";
    row.dataset.momentKey=key;
    row.dataset.momentElement=String(site.element||"");
    row.dataset.momentColorCustom=setting.colorCustomized?"1":"0";
    row.dataset.momentColor=setting.color;

    const enabled=document.createElement("input");
    enabled.type="checkbox";
    enabled.checked=!!setting.enabled;
    enabled.dataset.momentField="enabled";
    enabled.title="Use this magnetic site";

    const siteLabel=document.createElement("span");
    siteLabel.className="structure-moment-site";
    siteLabel.textContent=site.label||site.element;
    siteLabel.title=`${site.element} @ (${Number(site.x).toFixed(5)}, ${Number(site.y).toFixed(5)}, ${Number(site.z).toFixed(5)})`;

    const makeField=(labelText,input)=>{
      const label=document.createElement("label");
      label.className="structure-entry-field";
      const caption=document.createElement("span"); caption.className="structure-entry-label"; caption.textContent=labelText;
      label.append(caption,input);
      return label;
    };

    const xyz=document.createElement("div");
    xyz.className="structure-moment-vector structure-entry-grid";
    const momentInputs=[];
    if(structureMomentDirectionMode==="polar"){
      const polar=directionToPolar([setting.mx,setting.my,setting.mz]);
      for(const [field,labelText,value] of [["theta","θ (z)",polar.theta],["phi","φ (xy)",polar.phi],["moment","μB",vecNorm([setting.mx,setting.my,setting.mz])]]){
        const inp=document.createElement("input");
        inp.type="number"; inp.step=field==="moment"?"0.01":"1"; if(field==="moment") inp.min="0";
        inp.value=formatSpinValue(value); inp.dataset.displayValue=inp.value; inp.dataset.fullPrecision=String(value);
        inp.dataset.momentField=field;
        inp.title=field==="theta"?"Polar angle from +z (degrees)":field==="phi"?"Azimuth from +x toward +y (degrees)":"Physical magnetic moment magnitude (μB); separate from Length display scale";
        momentInputs.push(inp); xyz.appendChild(makeField(labelText,inp));
      }
    }else{
      for(const [field,labelText,value] of [["mx","x",setting.mx],["my","y",setting.my],["mz","z",setting.mz]]){
        const inp=document.createElement("input");
        inp.type="number"; inp.step="any"; inp.value=formatSpinValue(value); inp.dataset.displayValue=inp.value; inp.dataset.fullPrecision=String(value); inp.dataset.momentField=field;
        inp.title=`${labelText} Cartesian magnetic moment component (μB)`; momentInputs.push(inp); xyz.appendChild(makeField(labelText,inp));
      }
    }

    const picker=makeMomentColorPicker(setting.color,color=>{
      row.dataset.momentColorCustom="1";
      row.dataset.momentColor=color;
      const cur=currentMomentSettings().get(key)||setting;
      cur.color=color;
      cur.colorCustomized=true;
      structureMomentSettings.set(key,cur);
      saveStructureViewerState();
      renderCifStructureIfVisible();
    });

    const commit=()=>{
      const cur=currentMomentSettings().get(key);
      if(cur) structureMomentSettings.set(key,cur);
      saveStructureViewerState();
      renderCifStructureIfVisible();
    };
    enabled.addEventListener("change",()=>{ commit(); syncSpinElementToggleStates(); });
    for(const input of momentInputs){
      const autoEnable=()=>{
        if(!enabled.checked) enabled.checked=true;
        commit();
      };
      input.addEventListener("input",autoEnable);
      input.addEventListener("change",autoEnable);
    }

    // Three numeric fields: Cartesian x/y/z or Polar θ/φ/μB.
    xyz.classList.add("structure-moment-three-fields");
    row.append(enabled,siteLabel,xyz,picker);
    host.appendChild(row);
  });
  updateSpinElementToggles(structure);
}
function parseBondRange(value,fallbackMin=0,fallbackMax=3){
  const parts=String(value??"").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  let min=Number.isFinite(parts[0])?parts[0]:fallbackMin;
  let max=Number.isFinite(parts[1])?parts[1]:fallbackMax;
  min=Math.max(0,min); max=Math.max(0,max);
  if(max<min) [min,max]=[max,min];
  return {min,max};
}
function readStructureBondRules(){
  const rows=[...document.querySelectorAll("#cifBondRows .structure-bond-row")];
  return rows.map(row=>{
    const legacy=row.querySelector('[data-bond-field="distanceRange"]');
    const legacyParsed=parseBondRange(legacy?.value,0,3);
    let min=Number(row.querySelector('[data-bond-field="minDistance"]')?.value);
    let max=Number(row.querySelector('[data-bond-field="maxDistance"]')?.value);
    if(!Number.isFinite(min)) min=legacyParsed.min;
    if(!Number.isFinite(max)) max=legacyParsed.max;
    min=Math.max(0,min); max=Math.max(0,max);
    if(max<min) [min,max]=[max,min];
    return {
      a:String(row.querySelector('[data-bond-field="a"]')?.value || "").trim(),
      b:String(row.querySelector('[data-bond-field="b"]')?.value || "").trim(),
      minDistance:min,
      maxDistance:max,
      width:Math.max(1,Number(row.querySelector('[data-bond-field="width"]')?.value)||3),
      widthBlank:String(row.querySelector('[data-bond-field="width"]')?.value??"").trim()==="",
      color:row.querySelector('[data-bond-field="color"]')?.value || "#888888"
    };
  }).filter(rule=>rule.a && rule.b && Number.isFinite(rule.minDistance) && Number.isFinite(rule.maxDistance));
}
function populateBondSelect(select,elements,value){
  if(!select) return;
  const keep=value || select.value || elements[0] || "";
  select.replaceChildren();
  const values=[...elements];
  if(keep && !values.includes(keep)) values.push(keep);
  for(const element of values){ const opt=document.createElement("option"); opt.value=element; opt.textContent=element; select.appendChild(opt); }
  select.value=keep;
}
function defaultBondColor(a,b){
  const first=elementColor(a), second=elementColor(b);
  const rgb=color=>{ const hex=String(color||"").trim().replace(/^#/,""); return /^[0-9a-fA-F]{6}$/.test(hex)?[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)):null; };
  const x=rgb(first),y=rgb(second);
  if(!x||!y) return first||"#888888";
  // Keep same-element bonds identical to the atom color. For different
  // elements, use the RGB complement of the mean atom color.
  if(String(a)===String(b)) return first;
  return "#"+x.map((v,i)=>{
    const mixed=Math.round((v+y[i])/2);
    return (255-mixed).toString(16).padStart(2,"0");
  }).join("");
}
function createBondRuleRow(rule={},elements=[]){
  const row=document.createElement("div"); row.className="structure-bond-row";
  const a=document.createElement("select"); a.dataset.bondField="a"; a.title="First atom";
  const b=document.createElement("select"); b.dataset.bondField="b"; b.title="Second atom";
  const legacyMax=Number.isFinite(Number(rule.maxDistance))?Number(rule.maxDistance):Number(rule.distance);
  const minValue=Number.isFinite(Number(rule.minDistance))?Number(rule.minDistance):0;
  const maxValue=Number.isFinite(legacyMax)?legacyMax:3;
  const makeNumber=(field,value,min,step,title)=>{
    const input=document.createElement("input"); input.type="number"; input.min=String(min); input.step=String(step);
    input.dataset.bondField=field; input.value=String(value); input.title=title; return input;
  };
  const minDistance=makeNumber("minDistance",minValue,0,0.1,"Minimum bond distance (Å)");
  const maxDistance=makeNumber("maxDistance",maxValue,0,0.1,"Maximum bond distance (Å)");
  const bondWidth=Number.isFinite(Number(rule.width))?Number(rule.width):5;
  const width=makeNumber("width",bondWidth,1,1,"Bond width (pixels; leave blank for default)");
  width.max="30"; width.placeholder="5"; if(rule.widthBlank===true) width.value="";
  const color=document.createElement("input"); color.type="color"; color.dataset.bondField="color"; color.value=rule.color||defaultBondColor(a.value,b.value); color.title="Bond color";
  const field=(text,input)=>{ const label=document.createElement("label"); label.className="structure-entry-field"; const span=document.createElement("span"); span.className="structure-entry-label"; span.textContent=text; label.append(span,input); return label; };
  const rangePair=document.createElement("div"); rangePair.className="structure-bond-range-pair";
  rangePair.append(field("Min (Å)",minDistance),field("Max (Å)",maxDistance));
  const widthField=field("Width",width);
  const remove=document.createElement("button"); remove.type="button"; remove.textContent="Remove";
  populateBondSelect(a,elements,rule.a||elements[0]||""); populateBondSelect(b,elements,rule.b||elements[1]||elements[0]||"");
  if(!rule.color) color.value=defaultBondColor(a.value,b.value);
  remove.addEventListener("click",()=>{ row.remove(); saveStructureViewerState(); renderCifStructureIfVisible(); if(!$("cifBondRows")?.children.length) updateStructureBondRows(elements); });
  // Track explicit user color changes; automatically update the pair default otherwise.
  let customized=!!rule.color && rule.color.toLowerCase()!==defaultBondColor(a.value,b.value).toLowerCase();
  color.addEventListener("input",()=>{customized=true;});
  const updatePairColor=()=>{if(!customized) color.value=defaultBondColor(a.value,b.value);};
  a.addEventListener("change",updatePairColor);
  b.addEventListener("change",updatePairColor);
  const commit=()=>{ saveStructureViewerState(); renderCifStructureIfVisible(); };
  for(const el of [a,b,minDistance,maxDistance,width,color]){
    el.addEventListener("input",commit);
    el.addEventListener("change",()=>{
      if(el===minDistance || el===maxDistance){
        let min=Number(minDistance.value), max=Number(maxDistance.value);
        if(!Number.isFinite(min)) min=0; if(!Number.isFinite(max)) max=3;
        min=Math.max(0,min); max=Math.max(0,max); if(max<min) [min,max]=[max,min];
        minDistance.value=String(min); maxDistance.value=String(max);
      }
      commit();
    });
  }
  row.append(a,b,rangePair,widthField,color,remove);
  return row;
}
function updateStructureBondRows(elements,seedRules=null){
  const host=$("cifBondRows"); if(!host) return;
  const rules=Array.isArray(seedRules)?seedRules:readStructureBondRules();
  host.replaceChildren();
  if(!elements.length){ const div=document.createElement("div"); div.className="structure-rows-empty"; div.textContent="No atoms available."; host.appendChild(div); return; }
  for(const rule of rules) host.appendChild(createBondRuleRow(rule,elements));
  if(!host.children.length){ const div=document.createElement("div"); div.className="structure-rows-empty"; div.textContent="No bond rules yet."; host.appendChild(div); }
}
function addStructureBondRule(){
  const info=currentStructureForViewer(); const elements=structureElements(info?.structure||null); const host=$("cifBondRows");
  if(!host||!elements.length) return;
  if(host.firstElementChild?.classList.contains("structure-rows-empty")) host.replaceChildren();
  host.appendChild(createBondRuleRow({a:elements[0],b:elements[Math.min(1,elements.length-1)]||elements[0],minDistance:0,maxDistance:3,width:5},elements));
  saveStructureViewerState();
  renderCifStructureIfVisible();
}
function structureSignature(structure){
  if(!structure) return "";
  const lattice=structure.lattice||{};
  const sites=(structure.asymmetricSites||[]).map((s,i)=>`${i}:${s.label||""}:${s.element}:${s.x}:${s.y}:${s.z}:${(s.magneticMoment||[]).join(",")}:${s.magneticFourier?JSON.stringify(s.magneticFourier):""}`).join("|");
  return `${lattice.a},${lattice.b},${lattice.c},${lattice.alpha},${lattice.beta},${lattice.gamma}|${sites}`;
}
function syncStructureControlRows(structure){
  const sig=structureSignature(structure);
  if(sig===structureControlSignature) return;
  const oldBondRules=restoredStructureBondRules!==null ? restoredStructureBondRules : readStructureBondRules();
  restoredStructureBondRules=null;
  structureControlSignature=sig;
  const elements=structureElements(structure);
  assignDistinctElementColors(elements);
  updateStructureAtomColorRows(elements,structure);
  updateMagneticMomentRows(structure);
  updateStructureBondRows(elements,oldBondRules);
}
function replicatedAtoms(structure,range){
  const base=(Array.isArray(structure?.atoms)&&structure.atoms.length?structure.atoms:structure?.asymmetricSites||[]);
  const out=[];
  const xb=rangeCellBounds(range.x), yb=rangeCellBounds(range.y), zb=rangeCellBounds(range.z);
  const eps=1e-9;
  for(let ix=xb.from-2;ix<=xb.to+2;ix++) for(let iy=yb.from-2;iy<=yb.to+2;iy++) for(let iz=zb.from-2;iz<=zb.to+2;iz++){
    for(const atom of base){
      const phaseX=fracWrap01(atom.x)+ix, phaseY=fracWrap01(atom.y)+iy, phaseZ=fracWrap01(atom.z)+iz;
      const x=phaseX, y=phaseY, z=phaseZ;
      if(x<range.x.min-eps||x>range.x.max+eps||y<range.y.min-eps||y>range.y.max+eps||z<range.z.min-eps||z>range.z.max+eps) continue;
      out.push({...atom,x,y,z,phaseX,phaseY,phaseZ,cell:[ix,iy,iz]});
    }
  }
  return out;
}
function bondMatchesPair(rule,a,b){ return (rule.a===a&&rule.b===b)||(rule.a===b&&rule.b===a); }
function bondTraces(atoms,basis,rules){
  const traces=[];
  for(const rule of rules){
    if(rule.maxDistance<rule.minDistance) continue;
    const x=[],y=[],z=[];
    for(let i=0;i<atoms.length;i++){
      const ai=atoms[i];
      for(let j=i+1;j<atoms.length;j++){
        const aj=atoms[j];
        if(!bondMatchesPair(rule,String(ai.element),String(aj.element))) continue;
        const pi=fractionalToCartesian(basis,[ai.x,ai.y,ai.z]);
        const pj=fractionalToCartesian(basis,[aj.x,aj.y,aj.z]);
        const d=vecNorm(vecSub(pj,pi));
        if(!(d>1e-6)||d<rule.minDistance-1e-9||d>rule.maxDistance+1e-9) continue;
        x.push(pi[0],pj[0],null); y.push(pi[1],pj[1],null); z.push(pi[2],pj[2],null);
      }
    }
    if(x.length) traces.push({type:"scatter3d",mode:"lines",x,y,z,name:`${rule.a}-${rule.b} ${rule.minDistance}–${rule.maxDistance} Å`,hoverinfo:"skip",showlegend:false,line:{color:rule.color,width:Math.max(1,Number(rule.width)||5)}});
  }
  return traces;
}
function atomMomentSetting(atom,settings,structure){
  const sourceIndex=Number.isInteger(atom.sourceSiteIndex)?atom.sourceSiteIndex:null;
  if(sourceIndex!==null){
    const site=(structure?.asymmetricSites||[])[sourceIndex];
    if(site) return settings.get(momentKey({...site,siteIndex:sourceIndex}))||null;
  }
  const candidates=[...settings.entries()];
  const label=String(atom.sourceLabel||"");
  if(label){ const hit=candidates.find(([key])=>key.endsWith(`:${label}`)); if(hit) return hit[1]; }
  return null;
}
function appendSolidArrowHead(mesh,tip,dir,headLength,color){
  const length=Math.max(0.01,Number(headLength)||0.5);
  const radius=length*0.42;
  const baseCenter=vecSub(tip,vecScale(dir,length));
  const helper=Math.abs(dir[2])<0.9?[0,0,1]:[0,1,0];
  const p1=vecNormalize(vecCross(dir,helper));
  const p2=vecNormalize(vecCross(dir,p1));
  const segments=10;
  const baseStart=mesh.x.length;
  for(let n=0;n<segments;n++){
    const a=2*PI*n/segments;
    const p=vecAdd(baseCenter,vecAdd(vecScale(p1,radius*Math.cos(a)),vecScale(p2,radius*Math.sin(a))));
    mesh.x.push(p[0]); mesh.y.push(p[1]); mesh.z.push(p[2]);
  }
  const tipIndex=mesh.x.length;
  mesh.x.push(tip[0]); mesh.y.push(tip[1]); mesh.z.push(tip[2]);
  const centerIndex=mesh.x.length;
  mesh.x.push(baseCenter[0]); mesh.y.push(baseCenter[1]); mesh.z.push(baseCenter[2]);
  for(let n=0;n<segments;n++){
    const a=baseStart+n, b=baseStart+((n+1)%segments);
    mesh.i.push(a); mesh.j.push(b); mesh.k.push(tipIndex);
    mesh.i.push(centerIndex); mesh.j.push(b); mesh.k.push(a);
  }
  mesh.color=color;
  return baseCenter;
}
function structureMomentRotationAxisVector(basis){
  const key=["a","b","c"].includes(String(structureMomentRotationAxis||"")) ? String(structureMomentRotationAxis) : "c";
  return vecNormalize(basis?.[key]||basis?.c||[0,0,1]);
}
function rotateVectorAroundAxis(v,axis,angle){
  const n=vecNormalize(axis);
  const c=Math.cos(angle), s=Math.sin(angle);
  return vecAdd(vecAdd(vecScale(v,c),vecScale(vecCross(n,v),s)),vecScale(n,vecDot(n,v)*(1-c)));
}
function effectivePropagationVectorForStructure(){
  const qs=enabledPropagationVectorsForStructure();
  if(!qs.length) return {h:0,k:0,l:0,index:0,count:0};
  let q=qs.find(item=>item.index===structureMomentPropagationIndex);
  if(!q){
    q=qs[0];
    structureMomentPropagationIndex=q.index;
  }
  return {h:q.h,k:q.k,l:q.l,index:q.index,count:qs.length};
}
function refreshMomentPropagationVectorSelect(){
  const select=$("cifMomentPropagationVector");
  if(!select) return;
  const qs=enabledPropagationVectorsForStructure();
  const previous=structureMomentPropagationIndex;
  select.replaceChildren();
  if(!qs.length){
    const option=document.createElement("option");
    option.value="0"; option.textContent="None (k = 0, 0, 0)";
    select.appendChild(option);
    select.value="0"; select.disabled=true;
    structureMomentPropagationIndex=0;
    return;
  }
  select.disabled=false;
  for(const q of qs){
    const option=document.createElement("option");
    option.value=String(q.index);
    option.textContent=`k${q.index}`;
    select.appendChild(option);
  }
  const chosen=qs.some(q=>q.index===previous)?previous:qs[0].index;
  structureMomentPropagationIndex=chosen;
  select.value=String(chosen);
}
function magneticStructureTraces(atoms,basis,structure){
  const q=effectivePropagationVectorForStructure();
  const settings=currentMomentSettings();
  if(!settings.size) return [];
  const rotationAxis=structureMomentRotationAxisVector(basis);
  const groups=new Map();
  for(const atom of atoms){
    const setting=atomMomentSetting(atom,settings,structure);
    if(!setting?.enabled) continue;
    // mCIF supplies the site-resolved magnetic moment. Preserve its canting.
    // mCIF crystalaxis components must be transformed with the actual
    // magnetic cell vectors (as in Sunny), not reinterpreted as UI XYZ values.
    // mCIF moments are axial crystalaxis vectors, NOT fractional positions.
    // Their symmetry-transformed components are mapped to physical Cartesian
    // coordinates with the magnetic unit-cell basis exactly once (Sunny).
    // Never synthesize a spin along c for sites missing an mCIF moment.
    if(structure?.magnetic && !Array.isArray(atom.magneticMoment) && !atom.magneticFourier) continue;
    const frac=[Number.isFinite(atom.phaseX)?atom.phaseX:atom.x,Number.isFinite(atom.phaseY)?atom.phaseY:atom.y,Number.isFinite(atom.phaseZ)?atom.phaseZ:atom.z];
    const crystalMoment=(Array.isArray(atom.magneticMoment)||atom.magneticFourier)
      ? atomCrystalMoment(atom,frac) : null;
    const moment=crystalMoment ? mcifCrystalAxisToCartesian(basis,crystalMoment) : [setting.mx,setting.my,setting.mz];
    const mnorm=vecNorm(moment);
    if(!(mnorm>1e-12)) continue;
    const basePhase=2*PI*(q.h*frac[0]+q.k*frac[1]+q.l*frac[2]);
    let dir=vecNormalize(moment);
    let amplitude=1;
    if(Array.isArray(atom.magneticMoment) || atom.magneticFourier){
      // Magnetic symmetry/Fourier modulation already provides the spin.
    }else if(structureMomentStructureType==="helical"){
      const chiralitySign=structureMomentChirality==="CW" ? 1 : -1;
      dir=vecNormalize(rotateVectorAroundAxis(moment,rotationAxis,chiralitySign*basePhase));
    }else if(structureMomentStructureType==="sinusoidal"){
      amplitude=Math.cos(basePhase);
      if(Math.abs(amplitude)<1e-5) continue;
      if(amplitude<0) dir=vecScale(dir,-1);
      amplitude=Math.abs(amplitude);
    }else{
      // Collinear includes the former Uniform mode: k = 0 gives the same
      // moment in every cell, while half-integer propagation components give
      // the usual parallel/antiparallel AFM alternation.
      const phaseAmplitude=Math.cos(basePhase);
      if(phaseAmplitude<0) dir=vecScale(dir,-1);
    }
    // Length is only a display multiplier. The original Cartesian moment
    // (including its magnitude in mu_B) stays unchanged for mCIF export.
    // Using the norm here preserves relative arrow lengths between distinct
    // magnetic ions: e.g. 2 mu_B and 1 mu_B display at a 2:1 ratio.
    const displayMultiplier=Number(structureMomentGlobalLength);
    const length=(Number.isFinite(displayMultiplier) ? Math.max(0.05,displayMultiplier) : 1)*mnorm*amplitude;
    if(!(length>1e-12)) continue;
    const width=Math.max(1,Number(structureMomentGlobalWidth)||10);
    // Avoid a fixed arrowhead minimum that could dwarf small moments.
    const headLength=Math.min(Math.max(0.01,Number(structureMomentGlobalHeadSize)||0.51),2*length*0.95);
    const center=fractionalToCartesian(basis,frac);
    // Length is the center-to-end (half-length) setting.  The displayed arrow
    // is symmetric about the atom position: tail = center - L*dir,
    // tip = center + L*dir, so the atom sits at the arrow midpoint.
    const start=vecSub(center,vecScale(dir,length));
    const tip=vecAdd(center,vecScale(dir,length));
    const color=setting.color||elementColor(atom.element);
    const key=`${color}|${width}`;
    if(!groups.has(key)) groups.set(key,{color,width,x:[],y:[],z:[],mesh:{x:[],y:[],z:[],i:[],j:[],k:[],color}});
    const g=groups.get(key);
    const shaftEnd=appendSolidArrowHead(g.mesh,tip,dir,headLength,color);
    g.x.push(start[0],shaftEnd[0],null);
    g.y.push(start[1],shaftEnd[1],null);
    g.z.push(start[2],shaftEnd[2],null);
  }
  const traces=[];
  for(const g of groups.values()){
    if(g.x.length) traces.push({type:"scatter3d",mode:"lines",x:g.x,y:g.y,z:g.z,name:"Magnetic moments",hoverinfo:"skip",showlegend:false,line:{color:g.color,width:g.width}});
    if(g.mesh.x.length) traces.push({type:"mesh3d",x:g.mesh.x,y:g.mesh.y,z:g.mesh.z,i:g.mesh.i,j:g.mesh.j,k:g.mesh.k,color:g.color,flatshading:true,opacity:1,hoverinfo:"skip",showscale:false,showlegend:false,name:"Magnetic moment heads"});
  }
  return traces;
}
function ensureStructureViewerStyle(){
  // Structure Viewer layout is defined in styles.css.  Keeping this hook avoids
  // late runtime CSS overriding the HTML/CSS layout and shrinking entry boxes.
}
function createSplitRangeControls(axis){
  const cap=axis.toUpperCase();
  const legacy=$("cifRange"+cap);
  let minInput=$("cifRange"+cap+"Min");
  let maxInput=$("cifRange"+cap+"Max");
  if(!minInput || !maxInput){
    if(!legacy) return;
    const parsed=parseStructureRangeEntry(legacy.value);
    const parent=legacy.parentElement || legacy.parentNode;
    const field=(suffix,labelText,value)=>{
      const label=document.createElement("label"); label.className="structure-entry-field";
      const caption=document.createElement("span"); caption.className="structure-entry-label"; caption.textContent=labelText;
      const input=document.createElement("input"); input.id=`cifRange${cap}${suffix}`; input.type="number"; input.step="0.1"; input.value=String(value);
      label.append(caption,input); return {label,input};
    };
    const minField=field("Min",`${axis} min`,parsed.min), maxField=field("Max",`${axis} max`,parsed.max);
    if(parent){ parent.insertBefore(minField.label,legacy); parent.insertBefore(maxField.label,legacy); }
    legacy.type="hidden";
    minInput=minField.input; maxInput=maxField.input;
  }
  if(!minInput || !maxInput || minInput.dataset.structureRangeBound==="1") return;
  const syncLegacy=()=>{
    let min=Number(minInput.value), max=Number(maxInput.value);
    if(Number.isFinite(min) && Number.isFinite(max) && legacy) legacy.value=`${min} ${max}`;
  };
  const commit=()=>{
    normalizeStructureRangeInputs();
    saveStructureViewerState();
    renderCifStructureIfVisible();
  };
  for(const input of [minInput,maxInput]){
    input.dataset.structureRangeBound="1";
    input.addEventListener("input",()=>{ syncLegacy(); saveStructureViewerState(); });
    input.addEventListener("change",commit);
    input.addEventListener("keydown",ev=>{ if(ev.key==="Enter"){ ev.preventDefault(); input.blur(); } });
  }
}
function hideLegacyStructureColumnHeaders(hostId,requiredWords){
  const host=$(hostId); if(!host) return;
  const words=requiredWords.map(x=>String(x).toLowerCase());
  const candidates=[];
  let node=host.previousElementSibling;
  for(let i=0;node && i<5;i++,node=node.previousElementSibling) candidates.push(node);
  for(const child of host.parentElement?.children||[]) if(child!==host) candidates.push(child);
  for(const el of [...new Set(candidates)]){
    if(!el || el.querySelector?.("input,select,textarea")) continue;
    const text=String(el.textContent||"").replace(/\s+/g," ").trim().toLowerCase();
    if(text && words.every(word=>text.includes(word))){
      el.classList.add("structure-legacy-column-header");
      break;
    }
  }
}
function findStructureSectionHeading(host,titleWords){
  if(!host) return null;
  const words=titleWords.map(x=>String(x).toLowerCase());
  const matches=el=>{
    const text=String(el?.textContent||"").replace(/\s+/g," ").trim().toLowerCase();
    return text && words.every(word=>text.includes(word));
  };
  let node=host.previousElementSibling;
  for(let i=0;node && i<8;i++,node=node.previousElementSibling){
    if(matches(node) && !node.querySelector?.("input,select,textarea")) return node;
  }
  const parent=host.parentElement;
  if(parent){
    const selectors="h1,h2,h3,h4,h5,h6,.section-title,.panel-title,.card-title,.structure-section-title,strong";
    const list=[...parent.querySelectorAll(selectors)];
    const before=list.filter(el=>matches(el) && (el.compareDocumentPosition(host)&Node.DOCUMENT_POSITION_FOLLOWING));
    if(before.length) return before[before.length-1];
  }
  return null;
}
function resetMomentDisplayDefaults(){
  structureMomentStructureType="collinear";
  structureMomentRotationAxis="c";
  structureMomentChirality="CCW";
  if($("cifMomentStructureType")) $("cifMomentStructureType").value="collinear";
  if($("cifMomentRotationAxis")) $("cifMomentRotationAxis").value="c";
  if($("cifMomentChirality")) $("cifMomentChirality").value="CCW";
  const info=currentStructureForViewer();
  const sites=magneticCandidateSites(info?.structure||null);
  const live=currentMomentSettings();
  for(const site of sites){
    const key=momentKey(site);
    const current=live.get(key)||structureMomentSettings.get(key)||defaultMomentSetting(site,info?.structure);
    structureMomentSettings.set(key,{...current,size:1,width:10,headSize:0.51,color:elementColor(site.element),colorCustomized:false});
  }
  $("cifMagMomentRows")?.replaceChildren();
  structureControlSignature="";
  saveStructureViewerState();
  renderCifStructureIfVisible();
}
function resetAtomDisplayDefaults(){
  structureAtomColorOverrides.clear();
  structureAtomSizeOverrides.clear();
  structureControlSignature="";
  saveStructureViewerState();
  renderCifStructureIfVisible();
}
function resetBondDisplayDefaults(){
  for(const row of document.querySelectorAll("#cifBondRows .structure-bond-row")){
    const min=row.querySelector('[data-bond-field="minDistance"]'); if(min) min.value="0";
    const max=row.querySelector('[data-bond-field="maxDistance"]'); if(max) max.value="3";
    const legacy=row.querySelector('[data-bond-field="distanceRange"]'); if(legacy) legacy.value="0 3";
    const width=row.querySelector('[data-bond-field="width"]'); if(width) width.value="5";
    const color=row.querySelector('[data-bond-field="color"]'); if(color) color.value=defaultBondColor(row.querySelector('[data-bond-field="a"]')?.value,row.querySelector('[data-bond-field="b"]')?.value);
  }
  saveStructureViewerState();
  renderCifStructureIfVisible();
}
function ensureSectionDefaultButton(hostId,buttonId,handler,titleWords,existingButton=null){
  const host=$(hostId); if(!host) return null;
  document.getElementById(buttonId+"Row")?.remove();
  let button=existingButton || document.getElementById(buttonId);
  if(!button){ button=document.createElement("button"); button.type="button"; button.id=buttonId; button.textContent="Default"; }
  button.textContent="Default";
  if(button._structureDefaultHandler) button.removeEventListener("click",button._structureDefaultHandler);
  button._structureDefaultHandler=handler;
  button.addEventListener("click",handler);
  // The updated HTML already places each Default button next to its section title.
  // Keep that exact placement instead of moving the button into the <h3> element.
  if(button.parentElement?.classList.contains("structure-section-heading")) return button;
  const title=findStructureSectionHeading(host,titleWords);
  const headingRow=title?.closest?.(".structure-section-heading");
  if(headingRow){ headingRow.appendChild(button); return button; }
  if(title){
    const row=document.createElement("div"); row.className="structure-section-heading";
    title.parentElement?.insertBefore(row,title); row.append(title,button); return button;
  }
  host.parentElement?.insertBefore(button,host);
  return button;
}
// mCIF determines the magnetic arrangement itself, independent of the manual
// Collinear/Helical/Sinusoidal generator mode. Keep the latter preference.
function syncImportedMomentStructureType(){
  const select=$("cifMomentStructureType");
  if(!select) return;
  const imported=sourceIsMagneticCif();
  const option=select.querySelector('option[value="mcif"]');
  if(option){ option.hidden=!imported; option.disabled=!imported; }
  select.disabled=imported;
  select.value=imported?"mcif":structureMomentStructureType;
  select.title=imported?"The magnetic structure is defined by the loaded mCIF.":"Choose a generated magnetic structure type.";
}
function prepareStructureViewerControls(){
  ensureStructureViewerStyle();
  const viewButtons=[...document.querySelectorAll("[data-cif-structure-view]")];
  const viewButtonParents=[...new Set(viewButtons.map(button=>button.parentElement).filter(Boolean))];
  if(viewButtons.length===6 && viewButtonParents.length===1) viewButtonParents[0].classList.add("structure-view-buttons-six");
  for(const axis of ["x","y","z"]) createSplitRangeControls(axis);
  const rangeWrappers=[...document.querySelectorAll(".structure-view-range-axis")];
  const rangeParents=[...new Set(rangeWrappers.map(wrapper=>wrapper.parentElement).filter(Boolean))];
  if(rangeWrappers.length===3 && rangeParents.length===1) rangeParents[0].classList.add("structure-view-range-grid");
  hideLegacyStructureColumnHeaders("cifMagMomentRows",["use","site","mx","length","width","head"]);
  hideLegacyStructureColumnHeaders("cifAtomColorRows",["show","atom","marker","color"]);
  hideLegacyStructureColumnHeaders("cifBondRows",["atom1","atom2","range","width","color"]);
  for(const button of document.querySelectorAll("[data-structure-config-tab]")){
    const active=button.dataset.structureConfigTab===structureConfigActiveTab;
    button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));
  }
  for(const panel of document.querySelectorAll("[data-structure-config-panel]")){
    const active=panel.dataset.structureConfigPanel===structureConfigActiveTab;
    panel.classList.toggle("active",active);panel.hidden=!active;
  }
  for(const button of document.querySelectorAll("[data-structure-config-tab]")){
    if(button.dataset.structureTabBound) continue;
    button.dataset.structureTabBound="1";
    button.addEventListener("click",()=>{
      const key=button.dataset.structureConfigTab;
      structureConfigActiveTab=key;
      saveStructureViewerState();
      for(const tab of document.querySelectorAll("[data-structure-config-tab]")){
        const active=tab===button; tab.classList.toggle("active",active); tab.setAttribute("aria-selected",active?"true":"false");
      }
      for(const panel of document.querySelectorAll("[data-structure-config-panel]")){
        const active=panel.dataset.structureConfigPanel===key; panel.classList.toggle("active",active); panel.hidden=!active;
      }
    });
  }
  refreshMomentPropagationVectorSelect();
  const propagationSelect=$("cifMomentPropagationVector");
  if(propagationSelect && !propagationSelect.dataset.structureBound){
    propagationSelect.dataset.structureBound="1";
    propagationSelect.addEventListener("change",()=>{
      const n=Number(propagationSelect.value);
      structureMomentPropagationIndex=Number.isInteger(n)&&n>0?n:0;
      saveStructureViewerState();
      renderCifStructureIfVisible();
    });
  }
  const structureTypeSelect=$("cifMomentStructureType");
  const axisSelect=$("cifMomentRotationAxis");
  const chiralitySelect=$("cifMomentChirality");
  const directionSelect=$("cifMomentDirectionMode");
  const lengthInput=$("cifMomentGlobalLength");
  const widthInput=$("cifMomentGlobalWidth");
  const headInput=$("cifMomentGlobalHead");
  if(directionSelect){
    directionSelect.value=structureMomentDirectionMode;
    if(!directionSelect.dataset.structureBound){
      directionSelect.dataset.structureBound="1";
      directionSelect.addEventListener("change",()=>{
        const live=currentMomentSettings();
        for(const [key,value] of live) structureMomentSettings.set(key,value);
        structureMomentDirectionMode=directionSelect.value==="polar"?"polar":"cartesian";
        saveStructureViewerState();
        updateMagneticMomentRows(currentStructureForViewer()?.structure||null);
        renderCifStructureIfVisible();
      });
    }
  }
  if(lengthInput){
    lengthInput.value=String(structureMomentGlobalLength);
    if(!lengthInput.dataset.structureBound){
      lengthInput.dataset.structureBound="1";
      const commit=()=>{
        const raw=String(lengthInput.value||"").trim(), n=Number(raw);
        structureMomentGlobalLength=raw && Number.isFinite(n)?Math.max(0,n):1;
        saveStructureViewerState(); renderCifStructureIfVisible();
      };
      lengthInput.addEventListener("input",commit);
      lengthInput.addEventListener("change",commit);
    }
  }
  const bindGlobalArrowInput=(input,kind)=>{
    if(!input) return;
    const isWidth=kind==="width", defaultValue=isWidth?6:0.5;
    const blank=isWidth?structureMomentGlobalWidthBlank:structureMomentGlobalHeadBlank;
    input.value=blank?"":String(isWidth?structureMomentGlobalWidth:structureMomentGlobalHeadSize);
    input.placeholder=String(defaultValue);
    if(input.dataset.structureBound) return;
    input.dataset.structureBound="1";
    const commit=()=>{
      const raw=String(input.value||"").trim(); const n=Number(raw);
      if(isWidth){ structureMomentGlobalWidthBlank=!raw; structureMomentGlobalWidth=raw&&Number.isFinite(n)?Math.max(1,n):6; }
      else{ structureMomentGlobalHeadBlank=!raw; structureMomentGlobalHeadSize=raw&&Number.isFinite(n)?Math.max(0.01,n):0.5; }
      saveStructureViewerState(); renderCifStructureIfVisible();
    };
    input.addEventListener("input",commit); input.addEventListener("change",commit);
  };
  bindGlobalArrowInput(widthInput,"width");
  bindGlobalArrowInput(headInput,"head");
  const syncMomentStructureModeControls=()=>{
    const helical=!sourceIsMagneticCif() && structureMomentStructureType==="helical";
    if(axisSelect) axisSelect.disabled=!helical;
    if(chiralitySelect) chiralitySelect.disabled=!helical;
  };
  if(structureTypeSelect){
    syncImportedMomentStructureType();
    if(!structureTypeSelect.dataset.structureBound){
      structureTypeSelect.dataset.structureBound="1";
      structureTypeSelect.addEventListener("change",()=>{
        if(sourceIsMagneticCif()){
          syncImportedMomentStructureType();
          return;
        }
        structureMomentStructureType=["collinear","helical","sinusoidal"].includes(structureTypeSelect.value)?structureTypeSelect.value:"collinear";
        syncMomentStructureModeControls();
        saveStructureViewerState();
        renderCifStructureIfVisible();
      });
    }
  }
  if(axisSelect){
    axisSelect.value=structureMomentRotationAxis;
    if(!axisSelect.dataset.structureBound){
      axisSelect.dataset.structureBound="1";
      axisSelect.addEventListener("change",()=>{
        structureMomentRotationAxis=["a","b","c"].includes(axisSelect.value)?axisSelect.value:"c";
        saveStructureViewerState();
        renderCifStructureIfVisible();
      });
    }
  }
  if(chiralitySelect){
    chiralitySelect.value=structureMomentChirality;
    if(!chiralitySelect.dataset.structureBound){
      chiralitySelect.dataset.structureBound="1";
      chiralitySelect.addEventListener("change",()=>{
        structureMomentChirality=chiralitySelect.value==="CW"?"CW":"CCW";
        saveStructureViewerState();
        renderCifStructureIfVisible();
      });
    }
  }
  syncMomentStructureModeControls();
}

function loadFigureOverlayImage(url){
  return new Promise((resolve,reject)=>{const img=new Image(); img.onload=()=>resolve(img);img.onerror=()=>reject(new Error("Could not render figure overlay"));img.src=url;});
}
async function saveStructureFigure(){
  const plot=$("cifStructurePlot"), wrap=plot?.closest(".structure-plot-wrap");
  if(!plot || !wrap || !plot._fullLayout || typeof Plotly?.toImage!=="function") throw new Error("Draw the structure before saving a figure.");
  const bounds=wrap.getBoundingClientRect(), pb=plot.getBoundingClientRect();
  if(bounds.width<1 || bounds.height<1) throw new Error("The structure is not visible.");
  const scale=1,canvas=document.createElement("canvas");
  canvas.width=Math.round(bounds.width*scale);canvas.height=Math.round(bounds.height*scale);
  const ctx=canvas.getContext("2d");ctx.scale(scale,scale);
  ctx.fillStyle="#ffffff";ctx.fillRect(0,0,bounds.width,bounds.height);
  // Plotly export sometimes uses a stale view camera; snapshot the live scene first.
  // Export at display resolution, avoiding the expensive 2x WebGL re-render.
  const camera=currentStructureCamera();
  const previousCamera=plot.layout?.scene?.camera;
  if(camera && plot.layout?.scene) plot.layout.scene.camera=copyStructureCamera(camera);
  let data;
  try{ data=await Plotly.toImage(plot,{format:"png",width:Math.max(2,Math.round(pb.width)),height:Math.max(2,Math.round(pb.height)),scale:1}); }
  finally{if(plot.layout?.scene) plot.layout.scene.camera=previousCamera;}
  const base=await loadFigureOverlayImage(data);
  ctx.drawImage(base,pb.left-bounds.left,pb.top-bounds.top,pb.width,pb.height);
  // Render the element legend using computed CSS and its current DOM positions.
  const legend=$("cifAtomLegend");
  if(legend && !legend.classList.contains("hidden")){
    const r=legend.getBoundingClientRect(),style=getComputedStyle(legend);
    ctx.fillStyle=style.backgroundColor==="rgba(0, 0, 0, 0)"?"rgba(255,255,255,0.90)":style.backgroundColor;
    ctx.fillRect(r.left-bounds.left,r.top-bounds.top,r.width,r.height);
    for(const item of legend.querySelectorAll(".structure-atom-legend-item")){
      const ir=item.getBoundingClientRect(),dot=item.querySelector(".structure-atom-legend-dot"),dr=dot?.getBoundingClientRect();
      if(dr){ctx.fillStyle=getComputedStyle(dot).backgroundColor;ctx.beginPath();ctx.arc(dr.left-bounds.left+dr.width/2,dr.top-bounds.top+dr.height/2,Math.min(dr.width,dr.height)/2,0,Math.PI*2);ctx.fill();}
      ctx.font=getComputedStyle(item).font||"18px sans-serif";ctx.fillStyle=getComputedStyle(item).color||"#222";
      const text=item.querySelector("span")?.textContent||item.textContent;
      ctx.textBaseline="middle";ctx.fillText(text,(dr?.right||ir.left)-bounds.left+7,ir.top-bounds.top+ir.height/2);
    }
  }
  // Both SVG triads are live camera-synchronized overlays. Serialize them at the
  // last displayed orientation, without resetting or changing the 3D camera.
  for(const id of ["cifDirectTriad","cifReciprocalTriad"]){
    const el=$(id);if(!el) continue;
    const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
    const bg=getComputedStyle(el).backgroundColor;
    if(bg && bg!=="rgba(0, 0, 0, 0)"){ctx.fillStyle=bg;ctx.fillRect(r.left-bounds.left,r.top-bounds.top,r.width,r.height);}
    const clone=el.cloneNode(true);
    clone.setAttribute("xmlns","http://www.w3.org/2000/svg");clone.setAttribute("width",String(r.width));clone.setAttribute("height",String(r.height));
    const source=new XMLSerializer().serializeToString(clone);
    const url=URL.createObjectURL(new Blob([source],{type:"image/svg+xml;charset=utf-8"}));
    try{const img=await loadFigureOverlayImage(url);ctx.drawImage(img,r.left-bounds.left,r.top-bounds.top,r.width,r.height);}finally{URL.revokeObjectURL(url);}
  }
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
  if(!blob) throw new Error("Could not encode PNG image.");
  const href=URL.createObjectURL(blob),link=document.createElement("a");
  link.download="structure-figure.png";link.href=href;document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(href),1500);
}
function renderCifStructureView(){
  const plot=$("cifStructurePlot"),status=$("cifStructureStatus");
  if(!plot||!status) return;
  if(typeof Plotly==="undefined"){ status.textContent="Plotly is unavailable, so the structure view cannot be drawn."; return; }
  const source=currentStructureForViewer();
  syncImportedMomentStructureType();
  if(!source?.structure){ status.textContent="No CIF structure is available yet. Load/select a CIF or enter a valid CIF Generator structure."; Plotly.purge(plot); return; }
  const basis=directLatticeBasis(source.structure.lattice);
  if(!basis){ status.textContent="The CIF lattice parameters are invalid, so the structure view cannot be drawn."; Plotly.purge(plot); return; }
  syncStructureControlRows(source.structure);
  const range=structureRange();
  const atoms=replicatedAtoms(source.structure,range);
  if(!atoms.length){ status.textContent="The current CIF contains no atoms to display."; Plotly.purge(plot); return; }
  const grouped=new Map();
  for(const atom of atoms){
    const key=String(atom.element||"X");
    if(structureAtomVisibility.get(key)===false) continue;
    if(!grouped.has(key)) grouped.set(key,[]);
    grouped.get(key).push(atom);
  }
  const displayedAtoms=atoms.filter(atom=>structureAtomVisibility.get(String(atom.element||"X"))!==false);
  const bondRules=readStructureBondRules();
  const traces=[...unitCellTraces(basis,range),...bondTraces(displayedAtoms,basis,bondRules)];
  const orderedElements=structureElements(source.structure);
  for(const element of orderedElements){
    const list=grouped.get(element);
    if(!list?.length) continue;
    const xs=[],ys=[],zs=[],texts=[];
    for(const atom of list){
      const cart=fractionalToCartesian(basis,[atom.x,atom.y,atom.z]);
      xs.push(cart[0]);ys.push(cart[1]);zs.push(cart[2]);
      texts.push(`${element}<br>frac=(${atom.x.toFixed(3)}, ${atom.y.toFixed(3)}, ${atom.z.toFixed(3)})`);
    }
    traces.push({type:"scatter3d",mode:"markers",name:element,x:xs,y:ys,z:zs,text:texts,hovertemplate:"%{text}<extra></extra>",marker:{size:elementRadius(element),color:elementColor(element),line:{color:"#333",width:0.8},opacity:0.92}});
  }
  updateStructureAtomLegend(orderedElements.filter(element=>grouped.has(element)));
  const magneticOverlays=magneticStructureTraces(displayedAtoms,basis,source.structure); traces.push(...magneticOverlays);
  const magneticSummary=enabledPropagationVectorsForStructure();
  const effectiveK=effectivePropagationVectorForStructure();
  const enabledMoments=[...currentMomentSettings().values()].filter(x=>x.enabled).length;
  status.textContent=`${source.label}: x ${range.x.min}–${range.x.max}, y ${range.y.min}–${range.y.max}, z ${range.z.min}–${range.z.max}; ${displayedAtoms.length} displayed atoms.`+
    (bondRules.length?` ${bondRules.length} bond rule${bondRules.length===1?"":"s"}.`:"")+
    (source.structure.magnetic?" mCIF moments from magnetic symmetry/Fourier modulation.":enabledMoments?` ${enabledMoments} magnetic site setting${enabledMoments===1?"":"s"}; ${structureMomentStructureType}${structureMomentStructureType==="helical"?` about ${structureMomentRotationAxis} (${structureMomentChirality})`:""}, k${effectiveK.index||1}=(${effectiveK.h}, ${effectiveK.k}, ${effectiveK.l})${effectiveK.count>1?" (selected propagation vector)":""}.`:"");
  // Keep an explicit camera state independent of Plotly.react.  This prevents
  // later redraws (including range edits) from restoring the view-button camera
  // after the user has already rotated or zoomed the structure.
  const liveCamera=currentStructureCamera();
  const mainCamera=copyStructureCamera(structureCameraState) || liveCamera || structureCameraForView(cifStructureViewMode,basis,currentStructureCameraDistance());
  structureCameraState=copyStructureCamera(mainCamera);
  const layout={
    margin:{l:0,r:0,t:8,b:0},paper_bgcolor:"#fff",plot_bgcolor:"#fff",showlegend:false,
    scene:{aspectmode:"data",dragmode:"orbit",xaxis:{visible:structureShowXYZ,title:{text:"x (Å)",font:{size:18,color:"#222"}},showticklabels:structureShowXYZ,tickfont:{size:12},ticks:"outside",showline:true,linecolor:"#666",backgroundcolor:"#fafafa",gridcolor:"#e5e5e5",zerolinecolor:"#ccc"},yaxis:{visible:structureShowXYZ,title:{text:"y (Å)",font:{size:18,color:"#222"}},showticklabels:structureShowXYZ,tickfont:{size:12},ticks:"outside",showline:true,linecolor:"#666",backgroundcolor:"#fafafa",gridcolor:"#e5e5e5",zerolinecolor:"#ccc"},zaxis:{visible:structureShowXYZ,title:{text:"z (Å)",font:{size:18,color:"#222"}},showticklabels:structureShowXYZ,tickfont:{size:12},ticks:"outside",showline:true,linecolor:"#666",backgroundcolor:"#fafafa",gridcolor:"#e5e5e5",zerolinecolor:"#ccc"},camera:mainCamera},
    uirevision:"cif-structure-interactive"
  };
  Plotly.react(plot,traces,layout,{displaylogo:false,responsive:true,scrollZoom:true});
  if(plot._context) plot._context.scrollZoom=true;
  updateStructureOrientationTriads(basis,mainCamera);
  startStructureCameraWatch();
  if(!plot._structureCameraBound && typeof plot.on==="function"){
    plot._structureCameraBound=true;
    const syncTriadsFromCamera=camera=>{
      const copied=copyStructureCamera(camera);
      if(!copied) return;
      structureCameraState=copied;
      const latest=directLatticeBasis(currentStructureForViewer()?.structure?.lattice) || basis;
      updateStructureOrientationTriads(latest,copied);
    };
    const syncTriadsFromLiveCamera=()=>{
      const copied=currentStructureCamera();
      if(copied) syncTriadsFromCamera(copied);
    };
    const onCameraMotion=ev=>{
      const eventCamera=cameraFromRelayoutEvent(ev);
      if(eventCamera) syncTriadsFromCamera(eventCamera);
      else requestAnimationFrame(syncTriadsFromLiveCamera);
    };
    let trackingPointer=false, trackingFrame=0;
    const trackWhilePointerDown=()=>{
      if(!trackingPointer) return;
      syncTriadsFromLiveCamera();
      trackingFrame=requestAnimationFrame(trackWhilePointerDown);
    };
    plot.on("plotly_relayouting",onCameraMotion);
    plot.on("plotly_relayout",onCameraMotion);
    plot.addEventListener("pointerdown",()=>{
      trackingPointer=true;
      cancelAnimationFrame(trackingFrame);
      trackingFrame=requestAnimationFrame(trackWhilePointerDown);
    });
    const stopTracking=()=>{
      trackingPointer=false;
      cancelAnimationFrame(trackingFrame);
      requestAnimationFrame(syncTriadsFromLiveCamera);
    };
    plot.addEventListener("pointerup",stopTracking);
    plot.addEventListener("pointercancel",stopTracking);
    plot.addEventListener("mouseleave",()=>{ if(trackingPointer) stopTracking(); });
    plot.addEventListener("wheel",()=>{
      requestAnimationFrame(syncTriadsFromLiveCamera);
      setTimeout(syncTriadsFromLiveCamera,60);
      setTimeout(syncTriadsFromLiveCamera,140);
    },{passive:true});
  }

}

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
  renderCifStructureIfVisible();
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
    input.addEventListener("input",saveCifGeneratorAtomsState);
    input.addEventListener("change",saveCifGeneratorAtomsState);
    cell.appendChild(input); row.appendChild(cell);
    if(type==="fraction") validateCifAtomNumericInput(input);
  }
  const action=document.createElement("div"); action.className="cif-atom-cell";
  const remove=document.createElement("button"); remove.type="button"; remove.textContent="Remove";
  remove.addEventListener("click",()=>{
    row.remove();
    if(!host.querySelector(".cif-atom-row")) addCifAtomRow({}, {invalidate:false});
    refreshCifAtomRowIndices();
    saveCifGeneratorAtomsState();
    invalidateGeneratedCif();
  });
  action.appendChild(remove); row.appendChild(action);
  host.appendChild(row);
  refreshCifAtomRowIndices();
  saveCifGeneratorAtomsState();
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
  saveCifGeneratorAtomsState();
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


// CIF reciprocal-space symmetry helpers are implemented in cif-symmetry.js.

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
  const reflections=name==="reflections";
  $("cifOutputTabPreview")?.classList.toggle("active",preview);
  $("cifOutputTabReflections")?.classList.toggle("active",reflections);
  $("cifOutputTabPreview")?.setAttribute("aria-selected",String(preview));
  $("cifOutputTabReflections")?.setAttribute("aria-selected",String(reflections));
  $("cifPreviewPanel")?.classList.toggle("hidden",!preview);
  $("cifReflectionsPanel")?.classList.toggle("hidden",!reflections);
}

function generateCifForReview(){
  const generated=buildGeneratedCif();
  lastGeneratedCifText=generated.text;
  lastGeneratedCifName=generated.filename;
  lastGeneratedCifParsed=generated.parsed;
  lastGeneratedCifSpaceGroup=generated.sg;
  cifStructureSourcePreference="generated";
  saveStructureViewerState();
  if($("cifPreview")) $("cifPreview").textContent=generated.text;
  setCifGeneratedReady(true);
  recalculateGeneratedReflections();
  renderCifStructureIfVisible();
  setCifGeneratorMessage(`Generated ${generated.filename}: ${generated.sg.hm}, ${generated.atoms.length} asymmetric site(s), ${generated.parsed.atoms.length} expanded atom(s). Review the CIF, structure, and reflections, then Download CIF or Set CIF.`);
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
  if(message){ cifStructureSourcePreference="loaded"; saveStructureViewerState(); }
  $("cifSpaceGroup").value=String(sg.number);
  for(const [key,id] of Object.entries(CIF_LATTICE_FIELDS)) if($(id)) $(id).value=String(lattice[key]);
  replaceCifAtomRows(parsed.asymmetricSites.map(a=>({element:a.element,x:a.x,y:a.y,z:a.z,occupancy:a.occupancy})));
  if($("cifGeneratedName")) $("cifGeneratedName").value=cleanCifBaseName(fileName);
  updateCifSpaceGroupInfo();
  if(parsed.magnetic) for(const [key,id] of Object.entries(CIF_LATTICE_FIELDS)) if($(id)) $(id).value=String(lattice[key]);
  invalidateGeneratedCif("");
  if(message) setCifGeneratorMessage(`Loaded ${fileName} for editing: #${sg.number} ${sg.hm}, ${parsed.asymmetricSites.length} asymmetric site(s). Open Structure to view it immediately, or press Generate to review the regenerated CIF and reflection table.`);
  renderCifStructureIfVisible();
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
  loadedGeneratorCifStructure=parsed;
  loadedGeneratorCifName=file.name;
  if($("mcifPreviewText")) $("mcifPreviewText").textContent=text;
  cifStructureSourcePreference="loaded";
  prepareStructureViewerControls();
  renderCifStructureIfVisible();
}


// mCIF Generator: preserve the complete source symmetry/orbit specification.
let lastGeneratedMcifText="", lastGeneratedMcifName="";
function cleanMcifBaseName(name){
  return (String(name||"generated_structure").replace(/[\\/:*?"<>|]+/g,"_").replace(/\.(mcif|cif)$/i,"").trim()||"generated_structure");
}
function nextMcifGeneratedBaseName(raw){
  const current=cleanMcifBaseName(raw), matched=current.match(/^(.*)_generate(\d+)$/i);
  return matched?`${matched[1]}_generate${String(Number(matched[2])+1).padStart(2,"0")}`:`${current}_generate01`;
}
function invalidateGeneratedMcif(){
  lastGeneratedMcifText=""; lastGeneratedMcifName="";
  for(const id of ["structureMcifDownload","structureMcifSet"]) if($(id)) $(id).disabled=true;
}
function mcifMessage(message,error=false){
  const el=$("structureMcifMessage"); if(!el) return;
  el.textContent=message; el.classList.toggle("error",error);
}
function mcifPreview(text){
  if($("mcifPreviewText")) $("mcifPreviewText").textContent=text;
  $("mcifTabPreview")?.click();
}
function crystalComponents(lattice,cart){
  const basis=directLatticeBasis(lattice);
  if(!basis) throw new Error("Invalid unit cell for magnetic vector conversion.");
  const a=vecNormalize(basis.a),b=vecNormalize(basis.b),c=vecNormalize(basis.c);
  const det=vecDot(a,vecCross(b,c));
  if(Math.abs(det)<1e-12) throw new Error("Singular crystallographic axes.");
  return [vecDot(cart,vecCross(b,c))/det,vecDot(cart,vecCross(c,a))/det,vecDot(cart,vecCross(a,b))/det];
}
// The original mCIF is retained to preserve the BNS setting, time reversal,
// atomic site labels, and all magnetic symmetry loops. Replace only the moment loop.
function replaceMcifMoments(source,rows){
  const lines=String(source).replace(/\r\n?/g,"\n").split("\n");
  let start=-1,end=-1;
  for(let i=0;i<lines.length;i++){
    if(lines[i].trim().toLowerCase()!=="loop_") continue;
    let j=i+1, tags=[];
    while(j<lines.length && lines[j].trim().startsWith("_")) tags.push(lines[j++].trim().toLowerCase().split(/\s+/)[0]);
    if(!tags.some(x=>x==="_atom_site_moment.label"||x==="_atom_site_moment_label")) continue;
    start=i;end=j;
    while(end<lines.length){
      const line=lines[end].trim();
      if(/^(loop_|data_|save_|stop_|_)/i.test(line)) break;
      end++;
    }
    break;
  }
  const block=["loop_","_atom_site_moment.label","_atom_site_moment.crystalaxis_x","_atom_site_moment.crystalaxis_y","_atom_site_moment.crystalaxis_z","_atom_site_moment.symmform",...rows,""];
  if(start>=0) lines.splice(start,end-start,...block);
  else lines.push("",...block);
  return lines.join("\n");
}
function generateMcifForReview(){
  const source=getSelectedCifText();
  if(!source) throw new Error("Select a CIF/mCIF before generating.");
  const structure=getSelectedCifStructure();
  if(!structure) throw new Error("Selected structure is unavailable.");
  const hasMagOps=/_space_group_symop_magn_operation[._]/i.test(source);
  if(!hasMagOps) throw new Error("This generator currently requires an mCIF with magnetic symmetry operations. A nonmagnetic CIF cannot be converted without choosing a magnetic space group.");
  const live=currentMomentSettings();
  const records=[];
  (structure.asymmetricSites||[]).forEach((site,siteIndex)=>{
    const key=momentKey({...site,siteIndex});
    const setting=live.get(key)||structureMomentSettings.get(key)||defaultMomentSetting(site,structure);
    if(!setting.enabled) return;
    const cart=[Number(setting.mx)||0,Number(setting.my)||0,Number(setting.mz)||0];
    if(cart.some(x=>!Number.isFinite(x))) throw new Error(`Invalid spin components for ${site.label}`);
    const v=crystalComponents(structure.lattice,cart);
    records.push(`${site.label} ${v.map(x=>Number(x.toFixed(8))).join(" ")} mx,my,mz`);
  });
  if(!records.length) throw new Error("No spin sites enabled. Enable at least one spin.");
  const text=replaceMcifMoments(source,records);
  // Reparse and verify symmetry consistency before allowing Set or Download.
  const check=parseCifStructure(text);
  if(!check.magnetic) throw new Error("Generated file lost magnetic structure information.");
  for(const site of check.asymmetricSites){
    const expected=structure.asymmetricSites.find(x=>x.label===site.label);
    if(!expected) throw new Error(`Magnetic site ${site.label} was lost.`);
  }
  const base=cleanMcifBaseName($("structureMcifGeneratedName")?.value);
  lastGeneratedMcifText=text; lastGeneratedMcifName=`${base}.mcif`;
  for(const id of ["structureMcifDownload","structureMcifSet"]) if($(id)) $(id).disabled=false;
  mcifPreview(text);
  mcifMessage(`Generated ${lastGeneratedMcifName}; magnetic symmetry checked (${check.atoms.filter(a=>Array.isArray(a.magneticMoment)).length} magnetic atoms).`);
}
function initMcifGeneratorActions(){
  $("structureMcifShowCurrent")?.addEventListener("click",()=>{
    if(!getSelectedCifText()){mcifMessage("No current CIF/mCIF selected.",true);return;}
    mcifPreview(getSelectedCifText());mcifMessage(`Showing ${getSelectedCifFileName()}.`);
  });
  $("structureMcifGeneratedName")?.addEventListener("change",()=>{
    $("structureMcifGeneratedName").value=cleanMcifBaseName($("structureMcifGeneratedName").value);
    invalidateGeneratedMcif();
  });
  $("structureMcifGenerate")?.addEventListener("click",()=>{
    const el=$("structureMcifGeneratedName"),previous=el?.value;
    if(el) el.value=nextMcifGeneratedBaseName(previous);
    try{ generateMcifForReview(); }
    catch(err){if(el)el.value=previous;invalidateGeneratedMcif();mcifMessage(err.message||String(err),true);}
  });
  $("structureMcifDownload")?.addEventListener("click",()=>{
    if(!lastGeneratedMcifText)return;
    downloadGeneratedCif(lastGeneratedMcifText,lastGeneratedMcifName);
    mcifMessage(`Downloaded ${lastGeneratedMcifName}.`);
  });
  $("structureMcifSet")?.addEventListener("click",()=>{
    try{
      if(!lastGeneratedMcifText)throw new Error("Generate mCIF first.");
      if($("sampleMode")?.value!=="single"){
        $("sampleMode").value="single";updateModeVisibility();
      }
      loadCifText(lastGeneratedMcifText,lastGeneratedMcifName);
      $("mcifTabStructure")?.click();renderCifStructureIfVisible();
      mcifMessage(`Set ${lastGeneratedMcifName} as the current mCIF.`);
    }catch(err){mcifMessage(err.message||String(err),true);}
  });
  $("cifMagMomentRows")?.addEventListener("input",invalidateGeneratedMcif);
  $("cifMagMomentRows")?.addEventListener("change",invalidateGeneratedMcif);
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
    if(!getSelectedCifStructure()) restoreSelectedCifLocal();
    copyCurrentLatticeToGenerator();
    addCifAtomRow({element:"",x:0,y:0,z:0,occupancy:1},{invalidate:false});
    updateCifSpaceGroupInfo();
    syncCifReflectionBeamFromInstrument();
    if(getSelectedCifStructure()) loadParsedCifIntoGenerator(getSelectedCifStructure(),getSelectedCifFileName()||"selected_structure.cif",{message:false});
    else restoreCifGeneratorAtomsState();

    setCifGeneratedReady(false);
    clearCifReflectionTable("Press Generate to calculate reflections.");
    setCifOutputTab("preview");
    restoreStructureViewerState();

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
      if(cifStructureSourcePreference==="loaded") cifStructureSourcePreference="generated";
      invalidateGeneratedCif();
      renderCifStructureIfVisible();
    });
    inputPane?.addEventListener("change",ev=>{
      if(["cifLoadFile","cifReflectionEnergy","cifReflectionWavelength","cifReflectionWavevector"].includes(ev.target?.id)) return;
      if(cifStructureSourcePreference==="loaded") cifStructureSourcePreference="generated";
      invalidateGeneratedCif();
      renderCifStructureIfVisible();
    });

    $("cifCopyLattice")?.addEventListener("click",()=>{
      copyCurrentLatticeToGenerator();
      invalidateGeneratedCif("Current sample lattice copied — press Generate to review the updated CIF.");
    });
    $("cifShowCurrent")?.addEventListener("click",()=>{
      if(!getSelectedCifText()){
        setCifGeneratorMessage("No current CIF is selected.",true);
        return;
      }
      cifStructureSourcePreference="selected";
      saveStructureViewerState();
      if($("cifPreview")) $("cifPreview").textContent=getSelectedCifText();
      setCifOutputTab("preview");
      renderCifStructureIfVisible();
      setCifGeneratorMessage(`Showing current selected CIF: ${getSelectedCifFileName()||"selected CIF"}.`);
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
        cifStructureSourcePreference="selected";
        saveStructureViewerState();
        renderCifStructureIfVisible();
        setCifGeneratorMessage(`Set ${lastGeneratedCifName} as the selected CIF: ${parsed.atoms.length} expanded atom(s).`);
      }catch(err){ setCifGeneratorMessage(err?.message||String(err),true); }
    });

    for(const button of document.querySelectorAll("[data-cif-output-tab]")){
      button.addEventListener("click",()=>setCifOutputTab(button.dataset.cifOutputTab));
    }
    $("tabStructure")?.addEventListener("click",()=>requestAnimationFrame(renderCifStructureView));
    if($("cifSaveFigure")) $("cifSaveFigure").onclick=()=>saveStructureFigure().catch(err=>{alert(`Save figure failed: ${err?.message||err}`);});
    
    const unitCellSelect=$("cifUnitCellMode");
    if(unitCellSelect){ unitCellSelect.value=structureUnitCellMode; unitCellSelect.addEventListener("change",()=>{ structureUnitCellMode=unitCellSelect.value; saveStructureViewerState(); renderCifStructureIfVisible(); }); }
    const xyzSelect=$("cifShowXYZ");
    if(xyzSelect){ xyzSelect.value=structureShowXYZ?"show":"hide"; xyzSelect.addEventListener("change",()=>{ structureShowXYZ=xyzSelect.value!=="hide"; saveStructureViewerState(); renderCifStructureIfVisible(); }); }
    $("structureCifSelect")?.addEventListener("click",()=>$("cifFileInput")?.click());
    $("structureCifClear")?.addEventListener("click",clearSelectedCif);
    for(const button of document.querySelectorAll("[data-cif-structure-view]")){
      button.addEventListener("click",()=>{
        cifStructureViewMode=button.dataset.cifStructureView || "a";
        const source=currentStructureForViewer();
        const basis=directLatticeBasis(source?.structure?.lattice);
        if(basis){
          // IMPORTANT: do not apply a preset view with Plotly.relayout().
          // In Plotly gl3d that can leave the live WebGL camera detached from
          // _fullLayout.scene.camera until the next Plotly.react() (for example
          // after editing x/y/z range).  The coordinate triads then see a stale
          // camera and appear frozen.  Store the requested camera and rebuild the
          // scene through the same Plotly.react() path used by normal viewer
          // redraws so the live camera and layout camera stay synchronized.
          const camera=structureCameraForView(cifStructureViewMode,basis,currentStructureCameraDistance());
          structureCameraState=copyStructureCamera(camera);
          structureCameraWatchSignature="";
          updateStructureOrientationTriads(basis,camera);
        }
        saveStructureViewerState();
        renderCifStructureView();
      });
    }
    prepareStructureViewerControls();
    $("cifAddBondRule")?.addEventListener("click",addStructureBondRule);
    // Split range controls bind themselves in createSplitRangeControls(). The
    // legacy combined inputs stay hidden and synchronized only for saved-state
    // compatibility; do not attach redraw handlers to them.
    const propagationStructureRefresh=()=>{ refreshMomentPropagationVectorSelect(); saveStructureViewerState(); renderCifStructureIfVisible(); };
    $("propagationVectors")?.addEventListener("input",propagationStructureRefresh);
    $("propagationVectors")?.addEventListener("change",propagationStructureRefresh);
    $("propagationVectors")?.addEventListener("click",()=>requestAnimationFrame(propagationStructureRefresh));
    $("addPropagationVector")?.addEventListener("click",()=>requestAnimationFrame(propagationStructureRefresh));
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
    requestAnimationFrame(renderCifStructureIfVisible);
  }catch(err){
    select.innerHTML='<option value="">Space-group data unavailable</option>';
    for(const id of ["cifLoadExisting","cifGenerate","cifDownload","cifDownloadTable","cifSet","cifSpaceGroupNumber"]){ if($(id)) $(id).disabled=true; }
    setCifGeneratorMessage(`CIF Generator could not load space-group data: ${err?.message||String(err)}`,true);
  }
}

  initMcifGeneratorActions();
  // Structure / mCIF preview tabs: $ and rendering helpers are scoped to createCifUI.
  for (const [tab, pane, otherTab, otherPane] of [
    ["mcifTabStructure", "mcifStructurePane", "mcifTabPreview", "mcifPreviewPane"],
    ["mcifTabPreview", "mcifPreviewPane", "mcifTabStructure", "mcifStructurePane"]
  ]) {
    $(tab)?.addEventListener("click", () => {
      $(tab)?.classList.add("active");
      $(tab)?.setAttribute("aria-selected", "true");
      $(otherTab)?.classList.remove("active");
      $(otherTab)?.setAttribute("aria-selected", "false");
      $(pane)?.classList.remove("hidden");
      $(otherPane)?.classList.add("hidden");
      if (tab === "mcifTabStructure") requestAnimationFrame(renderCifStructureIfVisible);
    });
  }

  return {
    updateCifUI,
    syncSfColorMaxControl,
    sfThresholdFraction,
    selectCifFile,
    clearSelectedCif,
    centeringFromSpaceGroup,
    selectedSampleSpaceGroup,
    selectedSampleCentering,
    setCifOutputTab,
    initializeCifGenerator
  };
}
