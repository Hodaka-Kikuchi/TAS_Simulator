export function createInstrumentConfig(deps){
  const {$, add, sub, scale, dot, norm, normalize, clamp, rad2deg, wrap180, interpExtrap, normalizeTasSense, normalizeS1Sign, tasConvention, instruments, backgroundMaterials, getSingleCache, updateEnergyLabel, updateAutoW}=deps;
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
function effectiveOrientationReference(rl, fixedEnergyMeV=null, conventionOverride=null){
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

  // The virtual Bragg reference follows the selected physical Sense and encoder polarity.
  let convention;
  if(conventionOverride && typeof conventionOverride==="object" && "sense" in conventionOverride){
    convention=tasConvention(conventionOverride.sense,conventionOverride.s1sign);
  }else if(typeof conventionOverride==="string"){
    const legacy=tasConventionFromLegacyUiSense(conventionOverride);
    convention=tasConvention(legacy.sense,legacy.s1sign);
  }else{
    convention=tasConvention(selectedTasSense(),selectedS1Sign());
  }
  // The virtual Bragg reference follows the same S2 motor polarity as the
  // selected instrument convention.  Keep the reference zero and motor sign
  // separate instead of routing through the historical four-state labels.
  const c2Sign=-convention.s2EncoderSign;
  let s1Ref=-c2Sign*0.5*s2Ref;
  // ki ∥ U/V uses the same virtual elastic Bragg reference as ki ⟂ U/V,
  // but moves the S1=0 sample orientation by +90 degrees about the plane normal.
  if(isParallel) s1Ref+=c2Sign*90;
  return {mode,hkl,s1:wrap180(s1Ref),s2Ref};
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
  const singleCache=getSingleCache();
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


function latticeParams(){
  return {
    a:num("a"), b:num("b"), c:num("c"),
    alpha:num("alpha"), beta:num("beta"), gamma:num("gamma")
  };
}


  return {
    parseNumericValue,
    num,
    tasConventionFromLegacyUiSense,
    selectedTasSense,
    selectedS1Sign,
    setupTasConventionUI,
    checkedValue,
    setRadio,
    userFacingTasMessage,
    showError,
    clearError,
    setStatus,
    hklToQ,
    canonicalOrientationMode,
    effectiveOrientationReference,
    formatHKL,
    isAllowedByCentering,
    maxArray,
    refreshBackgroundSelect,
    refreshSelect,
    currentInstrument,
    rangeTable,
    instrumentInterp,
    s2DependsOnEi,
    configuredConstantS2Max,
    s2ElasticIncidentEnergy,
    baseS2MaxAtEi,
    effectiveS2MaxAtEi,
    formatS2ControlValue,
    initializeS2MaxControl,
    currentS2DisplayContext,
    updateS2MaxDisplay,
    syncS2DeltaFromEffective,
    updateS2MaxDisplayForQERange,
    validateEffectiveS2Max,
    normalizeCrystalName,
    setIf,
    setBool,
    setSelect,
    fillCrystal,
    updateSupermirrorUI,
    applyInstrumentDefaults,
    latticeParams,
  };
}
