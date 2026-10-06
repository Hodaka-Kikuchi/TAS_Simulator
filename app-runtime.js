export function createAppRuntime(deps){
  const {$, num, checkedValue, formatHKL, canonicalOrientationMode, collectResolutionBase, tasMotorAngles, makeSpiceScatteringPlaneBasis, dot, deg2rad, wrap180, angleDiffDeg, tasCrystalPhiDegForConvention, tasPlotPhiFromCrystalPhiForConvention, showError, hklInCurrentScatteringPlane, darkAssetSlots, darkAssetIds, clearError, updateEnergyLabel, updateS2MaxDisplay, updateModeVisibility, updateAutoW, updateResolutionPlaneWarning, doSingleResolution, calculateSingleCrystal, calculatePowder, renderSingle, renderGeometry, renderQEVectorMap, setQEMapTab, geometryCalculationMode, setGeometryCalculationMode, setGeometryScanOutputTab, saveRightPanelState, selectedTasSense, selectedS1Sign, tasConvention, effectiveOrientationReference, hklToQ, norm, clamp, rad2deg, effectiveS2MaxAtEi, parseNumericValue, BACKGROUND_SLOTS, applyInstrumentDefaults, bindDynamicSidebarUI, syncS2DeltaFromEffective, markResolutionScanDirtyExternal, getSingleCache, setSingleCache, setPowderCache}=deps;
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
      setSingleCache(calculateSingleCrystal());
      const singleCache=getSingleCache();
      $("hwSlider").min=0;
      $("hwSlider").max=Math.max(0,getSingleCache().regions.length-1);
      $("hwSlider").step=1;
      const idx=Math.min(Number($("hwSlider").value)||0,getSingleCache().regions.length-1);
      $("hwSlider").value=idx;
      renderSingle(getSingleCache(),idx);
    } else {
      setPowderCache(calculatePowder());
      const powderCache=deps.getPowderCache();
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


$("hwSlider").addEventListener("input",()=>{ if(getSingleCache()) renderSingle(getSingleCache(),Number($("hwSlider").value)); });
$('qeMapTabConstant')?.addEventListener('click',()=>setQEMapTab('constant'));
$('qeMapTabVector')?.addEventListener('click',()=>setQEMapTab('vector'));
$('qeMapUnit')?.addEventListener('change',()=>{
  try{localStorage.setItem('tas-qe-map-unit-v1',$('qeMapUnit').value);}catch(_e){}
  if(getSingleCache()){
    renderSingle(getSingleCache(),Number($('hwSlider')?.value)||0);
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
    if(getSingleCache() && !$('qeVectorMapPane')?.classList.contains('hidden')) renderQEVectorMap(getSingleCache());
  },Math.max(0,Number(delay)||0));
}
function renderQEVectorMapImmediately(){
  clearTimeout(qeVectorInputTimer);
  qeVectorInputTimer=null;
  if(!qeVectorHKLInputsAreComplete()) return;
  if(getSingleCache() && !$('qeVectorMapPane')?.classList.contains('hidden')) renderQEVectorMap(getSingleCache());
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
  if(getSingleCache() && checkedValue('sampleMode')==='single' && geometryCalculationMode()==='scan'){
    renderGeometry(getSingleCache(),Number($('hwSlider')?.value)||0);
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
  if(getSingleCache() && checkedValue('sampleMode')==='single') renderGeometry(getSingleCache(),Number($('hwSlider')?.value)||0);
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

  return {
    updateOrientationReferenceUI,
    updateBraggOrientationPlaneWarning,
    applyDarkAngleSlotColors,
    updateGeometryQuickTargetButtons,
    resolutionPanelIsVisible,
    markResolutionSingleDirty,
    markResolutionScanDirty,
    markCurrentResolutionDirty,
    runScheduledRecalc,
    scheduleRecalc,
    setGeometryTargetHKL,
    setGeometryTargetFromU,
    setGeometryTargetFromV,
    setGeometryKiOrientationCondition,
    setGeometryKiPerpU,
    setGeometryKiPerpV,
    setGeometryKiParallelU,
    setGeometryKiParallelV,
    setGeometryTargetFromBragg,
    syncGeometryTargetToOrientationReference,
    setGeometryTargetFromDarkRef,
    ensureNuclearLabelControl,
    ensureQESliderControls,
    nearestHWIndex,
    syncSingleNavigation,
    selectedQAtS2,
    recalculate,
    qeVectorHKLInputsAreComplete,
    scheduleQEVectorMapRender,
    renderQEVectorMapImmediately,
    renderGeometryScanFromCurrentCache,
    scheduleGeometryScanRender,
  };
}
