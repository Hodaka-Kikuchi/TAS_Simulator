import {
  PI, EPS, deg2rad, rad2deg, clamp,
  add, sub, scale, dot, norm, cross, normalize,
  RL_calc, UB_calc, makeSpiceScatteringPlaneBasis, reciprocalVectors,
  linspace, arange, interpExtrap
} from "./tas-core.js";
import {RL_calc as RLRes, inferOutOfPlaneHKL, calcResolution} from "./resolution-core.js";
import {
  parseCifStructure, nuclearStructureFactorSquared, setNeutronData
} from "./cif-structure.js";
import {
  normalizeTasSense, normalizeS1Sign, tasConvention,
  wrap180, angleDiffDeg,
  tasPhiLabDegForConvention,
  tasCrystalPhiDegForConvention, tasPlotPhiFromCrystalPhiForConvention,
  calcQ0
} from "./tas-conventions.js";
import {
  isGitHubPages, isLocalDirectoryListingHost,
  loadJsonDirectory, loadCifDirectory
} from "./data-loader.js";
import {
  reciprocalSymmetryMatrices, hklKey, compareHkl,
  canonicalReflectionHkl, reflectionStar
} from "./cif-symmetry.js";
import {createToolboxUI} from "./toolbox-ui.js";
import {createScriptUI} from "./script-ui.js";
import {createCifUI} from "./cif-ui.js";
import {createTasGeometryView} from "./tas-geometry-view.js";
import {createResolutionUI} from "./resolution-ui.js";
import {createUIShell} from "./ui-shell.js";
import {createDarkAngle} from "./dark-angle.js";
import {createQESingleCrystal} from "./qe-single-crystal.js";
import {createTasAngleCalculation} from "./tas-angle-calculation.js";

const $ = id => document.getElementById(id);
const instruments = new Map();
const backgroundMaterials = new Map();
const sampleEnvironments = new Map();

// Feature modules are wired near the end of this file after their dependencies are defined.
let updateCifUI, syncSfColorMaxControl, sfThresholdFraction, selectCifFile, clearSelectedCif, centeringFromSpaceGroup, selectedSampleSpaceGroup, selectedSampleCentering, setCifOutputTab, initializeCifGenerator, formatAutoHKL, buildResolutionLattice, updateAutoW, flipScatteringPlaneUV, collectResolutionBase, tasMotorAngles, calcOne, matrixText, traceEllipse, baseLayout, resolutionPlotLimitsFromEntries, formatAngle, renderResolution, resolutionScanPoints, updateResolutionPlaneWarning, doSingleResolution, doScanResolution, renderResolutionScan, bindResolutionManualCalculation, updatePropagationVectorLabels, powderWavevectors, powderQFromS2AtHW, powderSignedS2FromQAtHW, powderLinkDriver, setPowderLinkDriver, syncPowderLinkedInputs, powderGeometryTarget, geometryCalculationMode, geometryScanPoints, syncGeometryScanPointSlider, geometryDisplayedMotorAngles, geometryScanStatusWarnings, geometryScanErrorStatus, updateGeometryPlaneWarning, renderGeometryScanTable, currentGeometryScanOutputTab, setGeometryScanOutputTab, moveGeometryPlotForMode, setGeometryCalculationMode, updateGeometryAnglesVisibility, updateGeometryCalculationModeVisibility, geometryResultSummaryHtml, renderGeometry, safeResizePlot, plotHasLayout, ensureVisiblePrimaryPlots, scheduleVisiblePrimaryPlotRecovery, resizeVisiblePlots, scheduleVisiblePlotResize, initializeResponsivePlotResize, setActiveTab, updateCalcMode, setupAppHeader, rightPanelControls, saveRightPanelState, restoreRightPanelState, savedActiveTab, restoreGeometrySubTabsFromStorage, enableRightPanelPersistence, globalUIPersistentControls, currentCifOutputTab, saveGlobalUIState, restoreGlobalUIState, enableGlobalUIPersistence, leftPanelControls, resolutionInstrumentDetailControls, saveLeftPanelState, setSavedControl, restoreLeftPanelState, hasScanResults;
let getDarkAssets, darkSampleRangeForConvention, directBeamOrientationCorrection, rebuildGeometryMatchedDarkPolygons, qeDarkBlockWarningsForHKLE;
let canonicalOrientationMode, effectiveOrientationReference;
let calculateSingleCrystal, calculateSingleCrystalCore;

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
  saveLeftPanelState();
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
  saveLeftPanelState();
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
let selectedCifText = "";


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

// TAS convention routing.
//
// SPICE/TAKIN scattering Sense and the sample-axis motor sign are independent
// instrument properties.  The UI therefore exposes them separately:
//
// Legacy four-state values are accepted only while importing older settings.
//
// The legacy four-state branch remains internal only so the already-validated
// Q-E, Angle calculation, TAS geometry and Dark-angle paths can be reused
// without changing their numerical behavior.  Resolution receives only the
// physical SPICE Sense and is intentionally independent of S1 motor polarity.
function tasConventionFromLegacyUiSense(value){
  // Backward-compatibility parser for pre-refactor saved settings / instrument
  // files.  Legacy four-state labels are converted once at the input boundary.
  if(value==="+++") return {sense:"+-+",s1sign:"ccw"};
  if(value==="+-+") return {sense:"+-+",s1sign:"cw"};
  if(value==="---") return {sense:"-+-",s1sign:"cw"};
  return {sense:"-+-",s1sign:"ccw"};
}
function selectedTasSense(){ return normalizeTasSense(checkedValue("sense")); }
function selectedS1Sign(){ return normalizeS1Sign(checkedValue("s1sign")); }

function setupTasConventionUI(){
  const senseSelect=$("sense"), senseRow=$("senseRow"), geometryRow=$("geometryRow");
  if(!senseSelect || !senseRow || !geometryRow) return;

  // Preserve the HTML default while migrating the old four-choice selector.
  const initial=tasConventionFromLegacyUiSense(senseSelect.value);
  senseSelect.replaceChildren();
  for(const value of ["+-+","-+-"]){
    const option=document.createElement("option");
    option.value=value; option.textContent=value; senseSelect.appendChild(option);
  }
  senseSelect.value=initial.sense;
  for(const node of senseRow.childNodes){
    if(node.nodeType===Node.TEXT_NODE && node.nodeValue.trim()){ node.nodeValue="Sense"; break; }
  }

  let s1Select=$("s1sign");
  let s1Row=$("s1SignRow");
  if(!s1Select){
    s1Row=document.createElement("label");
    s1Row.id="s1SignRow";
    s1Row.append("S1 sign");
    s1Select=document.createElement("select");
    s1Select.id="s1sign";
    for(const [value,label] of [["ccw","CCW"],["cw","CW"]]){
      const option=document.createElement("option");
      option.value=value; option.textContent=label; s1Select.appendChild(option);
    }
    s1Select.value=initial.s1sign;
    s1Row.appendChild(s1Select);
  }

  // Put Geometry / Sense / S1 sign on one dedicated three-column row.
  let row=$("tasConventionRow");
  if(!row){
    row=document.createElement("div");
    row.id="tasConventionRow"; row.className="grid3";
    const oldParent=senseRow.parentElement;
    oldParent?.after(row);
  }
  row.appendChild(geometryRow);
  row.appendChild(senseRow);
  row.appendChild(s1Row);
}
setupTasConventionUI();

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


let prepareToolboxUI, bindToolboxUI, updateAbsorptionCalculator;

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

// Static JSON/CIF directory loading is implemented in data-loader.js.

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
  const hasNewSense=cfg.sense!==undefined || (cfg.sign===undefined && (qr.sense!==undefined || inst.sense!==undefined));
  const rawSense=cfg.sense ?? cfg.sign ?? qr.sense ?? inst.sense ?? "-+-";
  const rawS1Sign=cfg.s1sign ?? qr.s1sign ?? inst.s1sign;
  let tasConvention;
  if(rawS1Sign!==undefined){
    tasConvention={sense:normalizeTasSense(rawSense),s1sign:normalizeS1Sign(rawS1Sign)};
  }else if(hasNewSense && (rawSense==="+-+" || rawSense==="-+-")){
    // New-format Sense without an explicit motor sign defaults to CCW.
    tasConvention={sense:normalizeTasSense(rawSense),s1sign:"ccw"};
  }else{
    // Backward compatibility for old JSON files whose `sign` stored one of the
    // pre-refactor combined Sense/S1 labels.
    tasConvention=tasConventionFromLegacyUiSense(rawSense);
  }
  setSelect("sense",tasConvention.sense);
  setSelect("s1sign",tasConvention.s1sign);
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
  saveLeftPanelState();
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
  saveLeftPanelState();
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
  saveLeftPanelState();
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
    saveLeftPanelState();
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
    saveLeftPanelState();
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
        saveLeftPanelState();
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
    saveLeftPanelState();
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


// Dark-angle Rotation/Offset follows the sample S1 sign convention for
// sample-attached references.  The validated legacy -+- dark-polygon mapping
// was historically parameterized with the opposite angular sign, so convert
// only its user-entered angular interval before using that mapping.  This keeps
// the zero/reference calibration unchanged while making +Rotation/+Offset mean
// the same physical (CCW-positive) rotation as +S1 for -+-.
//
// Fixed-reference dark angles are laboratory-fixed directions compared against
// signed S2, not sample rotations, and therefore must not be transformed here.

// TAS S1/Q sign-convention math is implemented in tas-conventions.js.


// Direct-beam dark-angle zero is tied to the currently selected
// ki-perpendicular orientation reference.  For perpU use U; for perpV use V.
// The elastic Bragg condition for that reference lies theta=S2/2 away from the
// ki-perpendicular condition, so the same +theta correction must be used by
// both the Q-E dark-angle calculation and the TAS geometry overlay.
//
// The Direct-beam geometric axis is mirrored separately in the TAS drawing.
// The orientation-reference calibration itself uses the same +theta=S2/2
// correction for both user-facing configurations.






// Rebuild every sample-attached Q-E Dark-angle polygon from the same physical
// geometry used by TAS Geometry.  Sense and S1 polarity enter only as fields of
// one convention object; there is no four-state calculation branch.





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


// Unified Q-E Range calculation.


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
  const plane=`(${cache.U.join(",")})-(${cache.V.join(",")})`;
  const spaceGroup=`#${cache.sampleSpaceGroup?.number ?? 1} ${cache.sampleSpaceGroup?.hm ?? "P1"}`;
  const lattice=`a=${cache.lc.a.toFixed(3)}, b=${cache.lc.b.toFixed(3)}, c=${cache.lc.c.toFixed(3)} Å, `+
    `α=${cache.lc.alpha.toFixed(1)}, β=${cache.lc.beta.toFixed(1)}, γ=${cache.lc.gamma.toFixed(1)}°`;
  return `${cache.inst.name||"Instrument"} | ${energyText}${lam} | Scattering plane: ${plane}<br>`+
    `${spaceGroup} | ${lattice}`;
}

function renderQEVectorMap(cache){
  const plot=$('qeVectorPlot'), msg=$('qeVectorMessage');
  if(!plot || !cache || cache.powder) return;
  try{
    const a=qeVectorHKL(0), b=qeVectorHKL(1), dh=b.map((v,i)=>v-a[i]);
    const planeWarnings=[];
    const w0=scatteringPlaneWarningMessage(a,'HKL 1');
    const w1=scatteringPlaneWarningMessage(b,'HKL 2');
    if(w0) planeWarnings.push(w0.replace(/^Warning:\s*/,''));
    if(w1) planeWarnings.push(w1.replace(/^Warning:\s*/,''));
    setScatteringPlaneWarning('qeVectorPlaneWarning',planeWarnings.length?`Warning: ${planeWarnings.join(' / ')}`:'');
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
      colorscale:[[0,'rgba(255,255,255,0)'],[0.499,'rgba(255,255,255,0)'],[0.5,'rgba(255,222,105,0.72)'],[1,'rgba(255,222,105,0.72)']],
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

    // Plotly's native axis grid is rendered behind data traces, so colored
    // heatmap overlays can obscure it.  Build a matching set of grid lines as
    // top-layer shapes so the grid stays readable over Accessible-Q, BG and
    // dark-angle colors as well as the white background.
    const hwMax=Math.max(0,...cache.hwList);
    const niceGridStep=max=>{
      if(!(max>0)) return 1;
      const raw=max/8, power=Math.pow(10,Math.floor(Math.log10(raw)));
      const scaled=raw/power;
      const candidates=[1,2,5,10];
      const nice=candidates.reduce((best,value)=>
        Math.abs(value-scaled)<Math.abs(best-scaled)?value:best
      ,candidates[0]);
      return nice*power;
    };
    const yGridStep=niceGridStep(hwMax);
    const yGridVals=[];
    for(let y=0;y<=hwMax+1e-9;y+=yGridStep) yGridVals.push(Number(y.toFixed(12)));
    if(hwMax>0 && !yGridVals.some(y=>Math.abs(y-hwMax)<1e-9)) yGridVals.push(hwMax);
    const frontGridShapes=[
      ...tickVals.map(x=>({type:'line',xref:'x',yref:'paper',x0:x,x1:x,y0:0,y1:1,layer:'above',line:{color:'rgba(105,115,125,0.50)',width:1}})),
      ...yGridVals.map(y=>({type:'line',xref:'paper',yref:'y',x0:0,x1:1,y0:y,y1:y,layer:'above',line:{color:'rgba(105,115,125,0.50)',width:1}}))
    ];

    Plotly.react(plot,traces,{
      uirevision:'qeVector-hkl',
      plot_bgcolor:'#fff',paper_bgcolor:'#fff',
      title:{text:qeMapHeaderTitle(cache),x:0.5,xanchor:'center',font:{size:16}},
      xaxis:{title:{text:'HKL along selected Q vector',font:{size:15}},tickmode:'array',tickvals:tickVals,ticktext:tickText,tickangle:0,zeroline:false,showgrid:false,showline:true,linecolor:'#555',linewidth:1.2,mirror:true},
      yaxis:{title:{text:'ℏω (meV)',font:{size:15}},range:[0,hwMax],tickmode:'array',tickvals:yGridVals,zeroline:false,showgrid:false,showline:true,linecolor:'#555',linewidth:1.2,mirror:true},
      shapes:[
        ...frontGridShapes,
        {type:'line',x0:0,x1:0,y0:0,y1:1,yref:'paper',layer:'above',line:{color:'black',width:1,dash:'dot'}},
        {type:'line',x0:endX,x1:endX,y0:0,y1:1,yref:'paper',layer:'above',line:{color:'black',width:1,dash:'dot'}}
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
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    // Re-render the newly visible Q-E plot rather than relying on resize.
    // Plotly cannot resize a graph that was intentionally skipped while its
    // pane was hidden.  Reusing the current cache keeps this display-only.
    if(vector){
      if(singleCache) renderQEVectorMap(singleCache);
    }else if(checkedValue('sampleMode')==='single'){
      if(singleCache) renderSingle(singleCache,Number($('hwSlider')?.value)||0);
    }else if(powderCache){
      // Powder Constant-E has no separate render-only function; its cached plot
      // should already exist, so resize it once visible.  If it does not, the
      // common visible-plot recovery below will request one recalculation.
      safeResizePlot($('powderPlot'));
    }
  }));
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
  let convention=tasConvention(selectedTasSense(),selectedS1Sign());
  if(uiSenseOverride && typeof uiSenseOverride==="object" && "sense" in uiSenseOverride){
    convention=tasConvention(uiSenseOverride.sense,uiSenseOverride.s1sign);
  }else if(uiSenseOverride){
    const legacy=tasConventionFromLegacyUiSense(uiSenseOverride);
    convention=tasConvention(legacy.sense,legacy.s1sign);
  }
  b.config.sense=convention.sense;
  b.config.s1sign=convention.s1sign;
  b.config.sign_config=convention.sense;
  void senseOverride; // legacy argument retained for call-site compatibility
  const angles=tasMotorAngles(calc,b);
  const Ei=cache.energyMode==="Ei fixed" ? cache.Ei : cache.Ef+calc.hw;
  const Ef=cache.energyMode==="Ei fixed" ? cache.Ei-calc.hw : cache.Ef;
  return {calc,angles,Ei,Ef,ki:Math.sqrt(Ei/2.072),kf:Math.sqrt(Ef/2.072)};
}



const GEOMETRY_CALC_MODE_STORAGE_KEY='tas-geometry-calc-mode-v1';
const GEOMETRY_SCAN_OUTPUT_STORAGE_KEY='tas-geometry-scan-output-tab-v1';

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
function resolutionPanelIsVisible(){
  const panel=$("resolutionPanel");
  return !!panel && !panel.classList.contains("hidden");
}
function markResolutionSingleDirty(){
  if(!resolutionPanelIsVisible() || $("calcMode")?.value!=="single") return;
  $("result")?.classList.add("hidden");
  const btn=$("calcSingleResolution");
  if(btn) btn.classList.add("needs-calc");
}
function markResolutionScanDirty(){
  if(!resolutionPanelIsVisible() || $("calcMode")?.value!=="scan") return;
  $("result")?.classList.add("hidden");
  const btn=$("calcScanResolution");
  if(btn) btn.classList.add("needs-calc");
}
function markCurrentResolutionDirty(){
  if($("calcMode")?.value==="scan") markResolutionScanDirty();
  else markResolutionSingleDirty();
}
function runScheduledRecalc(){
  timer=null;
  // Resolution Single is inexpensive enough to update automatically, but only
  // while its panel is actually visible.  Resolution Scan stays explicit via
  // Calculate so common edits never trigger the heavy multi-point calculation.
  if(resolutionPanelIsVisible()){
    clearError();
    updateEnergyLabel();
    updateS2MaxDisplay();
    updateModeVisibility();
    updateAutoW();
    updateResolutionPlaneWarning();
    if($("calcMode")?.value==="single") doSingleResolution();
    else markResolutionScanDirty();
    return;
  }
  recalculate();
}
function scheduleRecalc(delayOrEvent=50){
  let delay=50;
  if(typeof delayOrEvent==="number"){
    delay=Math.max(0,delayOrEvent);
  }else if(delayOrEvent?.type){
    const el=delayOrEvent.target;
    if(delayOrEvent.type==="change") delay=0;
    else if(el?.tagName==="INPUT" && !["range","checkbox","radio","button"].includes(String(el.type||"").toLowerCase())) delay=180;
    else delay=60;
  }
  clearTimeout(timer);
  timer=setTimeout(runScheduledRecalc,delay);
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
      const convention=tasConvention(b.config.sense ?? selectedTasSense(),b.config.s1sign ?? selectedS1Sign());
      const orientationRef=effectiveOrientationReference(b.rl,fixedE,convention);
      const c2Sign=convention.c2ToOmegaSign;

      if(convention.sense==="+-+"){
        // The physical Sense selects the crystal-azimuth handedness.
        // Solve the S1=0 condition in crystal-azimuth space first, then map
        // it back to the displayed U/V reciprocal-space coordinates.  Using
        // phiAxis directly here mirrors the generated HKL to the wrong side.
        const qAxis=usesV ? qV : qU;
        const phiAxisCrystal=tasCrystalPhiDegForConvention(qAxis,ex,ey,convention.sense,convention.s1sign);
        const phiTargetCrystal=wrap180(phiAxisCrystal+c2Sign*orientationRef.s1);
        phiTargetDeg=tasPlotPhiFromCrystalPhiForConvention(phiTargetCrystal,convention.sense,convention.s1sign);
      }else{
        phiTargetDeg=wrap180(phiAxis+c2Sign*orientationRef.s1);
      }
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
    const exactTargetHKL=[
      aa*U[0]+bb*V[0],
      aa*U[1]+bb*V[1],
      aa*U[2]+bb*V[2]
    ];

    // Some encoder/sense combinations need extra HKL precision to round-trip to S1=0.
    // Rounding their generated HKL to three decimals before Angle calculation
    // can move the target slightly away from that condition (typically a few
    // hundredths of a degree).  Keep the shortest HKL precision that still
    // round-trips through the *same* tasMotorAngles() path to S1=0.000 deg.
    // This changes only the quick-target HKL written by Set; orientation
    // calibration and all Dark-angle zero/reference calculations are untouched.
    const setConvention=tasConvention(
      b.config.sense ?? selectedTasSense(),
      b.config.s1sign ?? selectedS1Sign()
    );
    let targetHKL;
    if(setConvention.s2EncoderSign<0){
      targetHKL=exactTargetHKL.slice();
      for(let digits=3;digits<=10;digits++){
        const candidate=exactTargetHKL.map(x=>Number(x.toFixed(digits)));
        targetHKL=candidate;
        try{
          const check=tasMotorAngles({h:candidate[0],k:candidate[1],l:candidate[2],hw:0},b);
          if(Number.isFinite(check.s1) && Math.abs(Number(check.s1))<5e-4) break;
        }catch(_err){
          // Keep increasing precision; the normal recalculation path will
          // surface any genuine accessibility/configuration error afterwards.
        }
      }
    }else{
      // Preserve the already-validated +-+ / -+- quick-target behavior exactly.
      targetHKL=exactTargetHKL.map(x=>Number(x.toFixed(3)));
    }
    setGeometryTargetHKL(targetHKL);
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
// Q vector–E HKL editing is display-only: changing HKL1/HKL2 does not
// require rebuilding the full Q-E/geometry cache.  Debounce the relatively
// expensive Plotly map redraw while the user is typing, and redraw
// immediately when the edit is committed.
let qeVectorInputTimer=null;
const QE_VECTOR_HKL_INPUT_IDS=['qeVecH0','qeVecK0','qeVecL0','qeVecH1','qeVecK1','qeVecL1'];
function qeVectorHKLInputsAreComplete(){
  return QE_VECTOR_HKL_INPUT_IDS.every(id=>{
    const raw=String($(id)?.value??'').trim();
    return raw!=='' && Number.isFinite(parseNumericValue(raw));
  });
}
function scheduleQEVectorMapRender(delay=350){
  clearTimeout(qeVectorInputTimer);
  if(!qeVectorHKLInputsAreComplete()) return;
  qeVectorInputTimer=setTimeout(()=>{
    qeVectorInputTimer=null;
    if(singleCache && !$('qeVectorMapPane')?.classList.contains('hidden')) renderQEVectorMap(singleCache);
  },Math.max(0,Number(delay)||0));
}
function renderQEVectorMapImmediately(){
  clearTimeout(qeVectorInputTimer);
  qeVectorInputTimer=null;
  if(!qeVectorHKLInputsAreComplete()) return;
  if(singleCache && !$('qeVectorMapPane')?.classList.contains('hidden')) renderQEVectorMap(singleCache);
}
for(const id of QE_VECTOR_HKL_INPUT_IDS){
  $(id)?.addEventListener('input',()=>scheduleQEVectorMapRender(350));
  $(id)?.addEventListener('change',renderQEVectorMapImmediately);
  $(id)?.addEventListener('keydown',event=>{
    if(event.key==='Enter') renderQEVectorMapImmediately();
  });
}

// Angle calculation Scan inputs are display-only.  Rebuilding the complete
// single-crystal Q-E cache on every keypress made H/K/L/hw editing sluggish,
// especially when the scan table contains many points.  Reuse the current
// cache and debounce only the Angle/TAS geometry redraw while typing.
let geometryScanInputTimer=null;
const GEOMETRY_SCAN_INPUT_IDS=[
  'geomScanH0','geomScanK0','geomScanL0','geomScanHW0',
  'geomScanH1','geomScanK1','geomScanL1','geomScanHW1','geomScanNpts'
];
function renderGeometryScanFromCurrentCache(){
  clearTimeout(geometryScanInputTimer);
  geometryScanInputTimer=null;
  if(singleCache && checkedValue('sampleMode')==='single' && geometryCalculationMode()==='scan'){
    renderGeometry(singleCache,Number($('hwSlider')?.value)||0);
  }
}
function scheduleGeometryScanRender(delay=180){
  clearTimeout(geometryScanInputTimer);
  geometryScanInputTimer=setTimeout(renderGeometryScanFromCurrentCache,Math.max(0,Number(delay)||0));
}
for(const id of GEOMETRY_SCAN_INPUT_IDS){
  $(id)?.addEventListener('input',()=>scheduleGeometryScanRender(180));
  $(id)?.addEventListener('change',renderGeometryScanFromCurrentCache);
}

$('geometryModeSingle')?.addEventListener('click',()=>{setGeometryCalculationMode('single');saveRightPanelState();});
$('geometryModeScan')?.addEventListener('click',()=>{setGeometryCalculationMode('scan');saveRightPanelState();});
$('geometryScanTabTable')?.addEventListener('click',()=>{setGeometryScanOutputTab('table');saveRightPanelState();});
$('geometryScanTabPlot')?.addEventListener('click',()=>{setGeometryScanOutputTab('plot');saveRightPanelState();});
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
    "geomScanPointSlider",
    "scanSlider",
    ...QE_VECTOR_HKL_INPUT_IDS,
    ...GEOMETRY_SCAN_INPUT_IDS
  ].includes(el.id)) return;

  el.addEventListener("input",scheduleRecalc);
  el.addEventListener("change",scheduleRecalc);
});



// ==================== Time estimate / Script workspace ====================
// The implementation lives in script-workspace.js. Bindings are assigned once
// all app-level helpers have been initialized, immediately before initialize().
let currentGeometryCardTab;
let hklInCurrentScatteringPlane;
let initializeScriptWorkspaceUI;
let mountTimeEstimateForScript;
let scatteringPlaneWarningMessage;
let setGeometryCardTab;
let setScatteringPlaneWarning;
let validateAllTimeScanRows;

// ==================== Resolution calculator ====================
document.querySelector('.sidebar').addEventListener('input',()=>saveLeftPanelState());
document.querySelector('.sidebar').addEventListener('change',()=>saveLeftPanelState());

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
  initializeScriptWorkspaceUI();
  try{
    const savedUnit=localStorage.getItem('tas-qe-map-unit-v1');
    if($('qeMapUnit') && (savedUnit==='ainv'||savedUnit==='rlu')) $('qeMapUnit').value=savedUnit;
    const savedMapTab=localStorage.getItem('tas-qe-map-tab-v1');
    setQEMapTab(savedMapTab==='vector'?'vector':'constant');
  }catch(_e){ setQEMapTab('constant'); }
  restoreGeometrySubTabsFromStorage();

  // Register the main tabs before any optional async data source is loaded.
  // A missing optional directory or CIF-generator asset must never leave the
  // application stuck with only the initially visible Q-E panel.
  $('tabQe')?.addEventListener('click',()=>setActiveTab('qe'));
  $('tabResolution')?.addEventListener('click',()=>setActiveTab('resolution'));
  $('tabToolbox')?.addEventListener('click',()=>setActiveTab('toolbox'));
  $('tabCifGenerator')?.addEventListener('click',()=>setActiveTab('cif-generator'));
  $('tabStructure')?.addEventListener('click',()=>setActiveTab('structure'));
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
  setPropagationVectorCount(propagationVectorIndices().length); setDarkAssetCount(darkAssetSlots().length); updatePropagationVectorLabels(); prepareToolboxUI(); ensureNuclearLabelControl(); ensureQESliderControls(); updateCifUI();
  try{ await initializeCifGenerator(); }
  catch(err){ console.warn('CIF Generator initialization warning:',err); }
  // Right-side controls are restored only after dynamic Toolbox controls exist and
  // after the default geometry target has been initialized, so saved values win.
  const restoredRightState=restoreRightPanelState();
  // Re-apply the geometry tab state at the end of right-panel restoration.
  // This is deliberately late: dynamic controls and saved numeric values are
  // already in place, so no subsequent initialization step can overwrite the
  // selected Single/Scan or Table/TAS geometry tab.
  restoreGeometrySubTabsFromStorage();
  syncSfColorMaxControl("restore");
  enableRightPanelPersistence();
  bindToolboxUI();
  $('powderGeomS2')?.addEventListener('input',()=>{ setPowderLinkDriver('s2'); syncPowderLinkedInputs('s2'); });
  $('powderGeomQ')?.addEventListener('input',()=>{ setPowderLinkDriver('q'); syncPowderLinkedInputs('q'); });
  $('powderGeomHW')?.addEventListener('input',()=>syncPowderLinkedInputs());
  for(const id of ['energy','energyMode','sense','s1sign']) $(id)?.addEventListener('change',()=>{
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
  syncPowderLinkedInputs();
  initializeResponsivePlotResize();
  setActiveTab(savedActiveTab());
  $('gm1').addEventListener('change',updateSupermirrorUI);$('calcMode').addEventListener('change',updateCalcMode);bindResolutionManualCalculation();$('calcScanResolution')?.addEventListener('click',doScanResolution);$('scanSlider').addEventListener('input',()=>renderResolutionScan(num('scanSlider')));$('prev').addEventListener('click',()=>renderResolutionScan(num('scanSlider')-1));$('next').addEventListener('click',()=>renderResolutionScan(num('scanSlider')+1));
  for(const id of ['h','k','l','h0','k0','l0','h1','k1','l1','npts','Uh','Uk','Ul','Vh','Vk','Vl','a','b','c','alpha','beta','gamma']){
    $(id)?.addEventListener('input',updateResolutionPlaneWarning);
    $(id)?.addEventListener('change',updateResolutionPlaneWarning);
  }
  updateResolutionPlaneWarning();
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
  // Restore any ordinary controls/tabs that are not owned by a specialized
  // serializer, then start the catch-all listener only after initialization so
  // defaults cannot overwrite the user's previous browser-local state.
  const restoredGlobalState=restoreGlobalUIState();
  enableGlobalUIPersistence();
  saveLeftPanelState();
  saveRightPanelState();
  saveGlobalUIState();
  setStatus(`${nInstrument} instrument(s), ${nBG} BG CIF material(s), ${nSE} sample environment(s), ${nNeutron} neutron-data record(s) loaded${(restoredLocalState||restoredRightState||restoredGlobalState) ? ' / local parameters restored' : ''}`);recalculate();
}

// ---- Feature-module wiring -------------------------------------------------
({
  prepareToolboxUI,
  bindToolboxUI,
  updateAbsorptionCalculator
}=createToolboxUI({
  $, num, checkedValue,
  getSelectedCifStructure:()=>selectedCifStructure,
  getSelectedCifFileName:()=>selectedCifFileName,
  selectCifFile:(...args)=>selectCifFile(...args),
  showError
}));

// TAS angle calculation is the shared physics core for Resolution, Q-E and TAS Geometry.
({
  canonicalOrientationMode,
  effectiveOrientationReference,
  tasMotorAngles
}=createTasAngleCalculation({
  $, PI, angleDiffDeg, clamp, dot, hklToQ, makeSpiceScatteringPlaneBasis, norm, normalize, num, rad2deg,
  scale, selectedS1Sign, selectedTasSense, sub, tasConvention, tasConventionFromLegacyUiSense,
  tasCrystalPhiDegForConvention, tasPhiLabDegForConvention, wrap180
}));

// Dark-angle physics and Q-E single-crystal range are isolated first because
// TAS Geometry and Script Workspace consume their public helpers.
({
  getDarkAssets,
  darkSampleRangeForConvention,
  directBeamOrientationCorrection,
  rebuildGeometryMatchedDarkPolygons,
  qeDarkBlockWarningsForHKLE
}=createDarkAngle({
  $, canonicalOrientationMode, checkedValue, clamp, currentDarkRangeCount, darkAssetIds, darkAssetSlots,
  deg2rad, dot, effectiveOrientationReference, hklToQ, linspace, norm, num, qePointInPolygon, rad2deg,
  selectedS1Sign, selectedTasSense, tasConvention
}));

({
  calculateSingleCrystal,
  calculateSingleCrystalCore
}=createQESingleCrystal({
  $, PI, RL_calc, UB_calc, add, arange, backgroundColor, backgroundMaterials, backgroundPowderPeaks,
  calcQ0, centeringFromSpaceGroup:(...args)=>centeringFromSpaceGroup(...args), checkedValue, clamp, currentInstrument,
  deg2rad, dot, effectiveOrientationReference, effectiveS2MaxAtEi, enabledPropagationVectors, formatHKL,
  getDarkAssets, getSelectedCifFileName:()=>selectedCifFileName, getSelectedCifStructure:()=>selectedCifStructure,
  hklToQ, isAllowedByCentering, latticeParams, linspace, makeSpiceScatteringPlaneBasis, maxArray, norm,
  nuclearStructureFactorSquared, num, rad2deg, rangeTable, rebuildGeometryMatchedDarkPolygons,
  representativePowderHklText, scale, selectedBackgrounds, selectedS1Sign,
  selectedSampleSpaceGroup:(...args)=>selectedSampleSpaceGroup(...args), selectedTasSense, tasConvention,
  tasPhiLabDegForConvention, tasPlotPhiFromCrystalPhiForConvention, validateEffectiveS2Max, wrap180
}));

({
  formatAutoHKL,
  buildResolutionLattice,
  updateAutoW,
  flipScatteringPlaneUV,
  collectResolutionBase,
  calcOne,
  matrixText,
  traceEllipse,
  baseLayout,
  resolutionPlotLimitsFromEntries,
  formatAngle,
  renderResolution,
  resolutionScanPoints,
  updateResolutionPlaneWarning,
  doSingleResolution,
  doScanResolution,
  renderResolutionScan,
  bindResolutionManualCalculation,
  updatePropagationVectorLabels,
  powderWavevectors,
  powderQFromS2AtHW,
  powderSignedS2FromQAtHW,
  powderLinkDriver,
  setPowderLinkDriver,
  syncPowderLinkedInputs,
  powderGeometryTarget,
  hasScanResults
}=createResolutionUI({
  $, tasMotorAngles, PI, RLRes, add, calcResolution, checkedValue, clamp, clearError, deg2rad,
  hklInCurrentScatteringPlane:(...args)=>hklInCurrentScatteringPlane(...args), hklToQ, inferOutOfPlaneHKL, latticeParams,
  linspace, markResolutionScanDirty, norm, num, parseNumericValue, powderS2ForQAtHW,
  propagationVectorIndices, rad2deg, scatteringPlaneWarningMessage:(...args)=>scatteringPlaneWarningMessage(...args),
  scheduleRecalc, selectedS1Sign, selectedTasSense, setScatteringPlaneWarning:(...args)=>setScatteringPlaneWarning(...args),
  showError, tasConvention, tasConventionFromLegacyUiSense, userFacingTasMessage
}));

({
  geometryCalculationMode,
  geometryScanPoints,
  syncGeometryScanPointSlider,
  geometryDisplayedMotorAngles,
  geometryScanStatusWarnings,
  geometryScanErrorStatus,
  updateGeometryPlaneWarning,
  renderGeometryScanTable,
  currentGeometryScanOutputTab,
  setGeometryScanOutputTab,
  moveGeometryPlotForMode,
  setGeometryCalculationMode,
  updateGeometryAnglesVisibility,
  updateGeometryCalculationModeVisibility,
  geometryResultSummaryHtml,
  renderGeometry
}=createTasGeometryView({
  $, GEOMETRY_CALC_MODE_STORAGE_KEY, GEOMETRY_SCAN_OUTPUT_STORAGE_KEY, PI, add, angleDiffDeg, checkedValue, clamp,
  currentInstrument, deg2rad, directBeamOrientationCorrection, dot, effectiveOrientationReference, effectiveS2MaxAtEi,
  formatAngle, hklInCurrentScatteringPlane:(...args)=>hklInCurrentScatteringPlane(...args), hklToQ, linspace,
  makeSpiceScatteringPlaneBasis, norm, num, parseNumericValue, powderGeometryTarget, qeDarkBlockWarningsForHKLE,
  qeGeometryAngles, rad2deg, scale, scatteringPlaneWarningMessage:(...args)=>scatteringPlaneWarningMessage(...args),
  selectedS1Sign, selectedTasSense, setScatteringPlaneWarning:(...args)=>setScatteringPlaneWarning(...args),
  tasConvention, updateGeometrySpurionWarning, userFacingTasMessage, getSingleCache:()=>singleCache
}));

({
  currentGeometryCardTab,
  hklInCurrentScatteringPlane,
  initializeScriptWorkspaceUI,
  mountTimeEstimateForScript,
  scatteringPlaneWarningMessage,
  setGeometryCardTab,
  setScatteringPlaneWarning,
  validateAllTimeScanRows
}=createScriptUI({
  $, add, buildResolutionLattice, calculateSingleCrystal, checkedValue, clamp, cross,
  currentInstrument, dot, effectiveS2MaxAtEi, hklToQ, tasConvention, norm, num,
  parseNumericValue, qeDarkBlockWarningsForHKLE, rad2deg, renderGeometry,
  resizeVisiblePlots:(...args)=>resizeVisiblePlots(...args), safeResizePlot:(...args)=>safeResizePlot(...args), scale, userFacingTasMessage,
  get singleCache(){ return singleCache; },
  get powderCache(){ return powderCache; }
}));

({
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
}=createCifUI({
  $, PI, RL_calc, add, canonicalReflectionHkl, checkedValue, clamp, clearError, compareHkl, cross,
  currentInstrument, dot, effectiveS2MaxAtEi, hklKey, hklToQ, makeSpiceScatteringPlaneBasis, norm,
  nuclearStructureFactorSquared, num, parseCifStructure, parseNumericValue, rad2deg, reciprocalSymmetryMatrices, reflectionStar,
  saveLeftPanelState:(...args)=>saveLeftPanelState(...args), scheduleRecalc, updateAutoW, updateModeVisibility, updateAbsorptionCalculator,
  getPropagationVectors:()=>propagationVectorValues(),
  setPropagationVectorsFromFile:(values)=>replacePropagationVectors(values,{recalc:false}),
  getSelectedCifStructure:()=>selectedCifStructure, getSelectedCifFileName:()=>selectedCifFileName,
  getSelectedCifText:()=>selectedCifText,
  setSelectedCifState:(structure,fileName,text)=>{ selectedCifStructure=structure; selectedCifFileName=fileName; selectedCifText=text; }
}));

({
  safeResizePlot,
  plotHasLayout,
  ensureVisiblePrimaryPlots,
  scheduleVisiblePrimaryPlotRecovery,
  resizeVisiblePlots,
  scheduleVisiblePlotResize,
  initializeResponsivePlotResize,
  setActiveTab,
  updateCalcMode,
  setupAppHeader,
  rightPanelControls,
  saveRightPanelState,
  restoreRightPanelState,
  savedActiveTab,
  restoreGeometrySubTabsFromStorage,
  enableRightPanelPersistence,
  globalUIPersistentControls,
  currentCifOutputTab,
  saveGlobalUIState,
  restoreGlobalUIState,
  enableGlobalUIPersistence,
  leftPanelControls,
  resolutionInstrumentDetailControls,
  saveLeftPanelState,
  setSavedControl,
  restoreLeftPanelState
}=createUIShell({
  $, BACKGROUND_SLOTS, GEOMETRY_CALC_MODE_STORAGE_KEY,
  GEOMETRY_SCAN_OUTPUT_STORAGE_KEY, add, applyInstrumentDefaults,
  applySampleEnvironmentDefaults, backgroundRowValues, buildResolutionLattice, checkedValue, currentGeometryCardTab,
  currentGeometryScanOutputTab, darkAssetIds, darkAssetSlots, darkAssetValues, geometryCalculationMode, markResolutionScanDirty,
  mountTimeEstimateForScript, propagationVectorValues, refreshDarkEnvironmentSelect, renderGeometry, renderQEVectorMap,
  renderResolutionScan, renderSingle, replaceBackgroundRows, replaceDarkAssets, replacePropagationVectors,
  resolutionPanelIsVisible, scheduleRecalc, selectedS1Sign, setBackgroundCount, setCifOutputTab, setDarkAssetCount,
  setDarkRangeCount, setGeometryCalculationMode, setGeometryCardTab, setGeometryScanOutputTab, setPropagationVectorCount,
  setQEMapTab, setupTasConventionUI, sub, updateAutoW, updateBackgroundSelectAvailability, updateDarkReferenceUI,
  updateEnergyLabel, updateModeVisibility, updateOrientationReferenceUI, updateResolutionPlaneWarning, updateS2MaxDisplay,
  updateSupermirrorUI, getSingleCache:()=>singleCache, getPowderCache:()=>powderCache, hasScanResults
}));

initialize().catch(err=>{showError(err);setStatus('Configuration loading failed. Open the project through an HTTP server.');});
