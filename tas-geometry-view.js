// Extracted from app.js without changing calculation/display behavior.
// Dependencies are injected by app.js to keep module boundaries explicit.
export function createTasGeometryView(deps){
  const {
    $,
    GEOMETRY_CALC_MODE_STORAGE_KEY,
    GEOMETRY_SCAN_OUTPUT_STORAGE_KEY,
    PI,
    add,
    angleDiffDeg,
    checkedValue,
    clamp,
    currentInstrument,
    deg2rad,
    directBeamOrientationCorrection,
    dot,
    effectiveOrientationReference,
    effectiveS2MaxAtEi,
    formatAngle,
    hklInCurrentScatteringPlane,
    hklToQ,
    linspace,
    makeSpiceScatteringPlaneBasis,
    norm,
    num,
    parseNumericValue,
    powderGeometryTarget,
    qeDarkBlockWarningsForHKLE,
    qeGeometryAngles,
    rad2deg,
    scale,
    scatteringPlaneWarningMessage,
    selectedS1Sign,
    selectedTasSense,
    setScatteringPlaneWarning,
    tasConvention,
    updateGeometrySpurionWarning,
    userFacingTasMessage,
    getSingleCache
  }=deps;

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
  void sense; void displaySense;
  const a=target.angles;
  return {
    m1:-Number(a.m1), m2:-Number(a.m2),
    s1:isPowder ? 0 : Number(a.s1), s2:Number(a.s2),
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

function updateGeometryPlaneWarning(points=null){
  if(checkedValue('sampleMode')!=='single'){
    setScatteringPlaneWarning('geometryPlaneWarning','');
    return;
  }
  const scan=geometryCalculationMode()==='scan';
  if(!scan){
    const hkl=[num('geomH'),num('geomK'),num('geomL')];
    setScatteringPlaneWarning('geometryPlaneWarning',scatteringPlaneWarningMessage(hkl));
    return;
  }
  const list=Array.isArray(points)?points:geometryScanPoints();
  if(!list.length){ setScatteringPlaneWarning('geometryPlaneWarning',''); return; }
  let outside=0, firstError='';
  for(const p of list){
    const result=hklInCurrentScatteringPlane([p.h,p.k,p.l]);
    if(!result.ok){ outside++; if(result.error && !firstError) firstError=result.error; }
  }
  const message=firstError
    ? `Warning: ${firstError}`
    : (outside ? `Warning: ${outside} of ${list.length} scan point(s) are outside the current U-V scattering plane.` : '');
  setScatteringPlaneWarning('geometryPlaneWarning',message);
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
      const plane=hklInCurrentScatteringPlane([calc.h,calc.k,calc.l]);
      if(!plane.ok) warnings.push(plane.error || 'Outside scattering plane');
      if(target.angles?.warning) warnings.push(target.angles.warning);
      warnings.push(...geometryScanStatusWarnings(target,a));
      warnings.push(...qeDarkBlockWarningsForHKLE(cache,[calc.h,calc.k,calc.l],calc.hw));
      const f=v=>Number.isFinite(v)?formatAngle(v):'—';
      const status=warnings.length?warnings.join(' / '):'';
      const rowClasses=[];
      if(i===selectedIndex) rowClasses.push('geometry-scan-selected-row');
      if(status) rowClasses.push('geometry-scan-warning-row');
      const rowClass=rowClasses.length?` class="${rowClasses.join(' ')}"`:'';
      return `<tr data-geometry-scan-row="${i}"${rowClass}><td class="geometry-scan-point-cell">${i+1}</td><td class="geometry-scan-hkl-cell">${calc.h.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.k.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.l.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.hw.toFixed(3)}</td><td>${f(a.m1)}</td><td>${f(a.m2)}</td><td>${f(a.s1)}</td><td>${f(a.s2)}</td><td>${f(a.a1)}</td><td>${f(a.a2)}</td><td>${status}</td></tr>`;
    }catch(err){
      const status=geometryScanErrorStatus(err);
      const rowClasses=['geometry-scan-warning-row'];
      if(i===selectedIndex) rowClasses.push('geometry-scan-selected-row');
      const rowClass=` class="${rowClasses.join(' ')}"`;
      return `<tr data-geometry-scan-row="${i}"${rowClass}><td class="geometry-scan-point-cell">${i+1}</td><td class="geometry-scan-hkl-cell">${calc.h.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.k.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.l.toFixed(3)}</td><td class="geometry-scan-hkl-cell">${calc.hw.toFixed(3)}</td><td colspan="6">—</td><td>${status}</td></tr>`;
    }
  }).join('');
  box.innerHTML=`<div class="geometry-scan-table-wrap"><table class="geometry-scan-table"><thead><tr><th>No.</th><th class="geometry-scan-hkl-head">H</th><th class="geometry-scan-hkl-head">K</th><th class="geometry-scan-hkl-head">L</th><th class="geometry-scan-hkl-head">ħω</th><th>M1</th><th>M2</th><th>S1</th><th>S2</th><th>A1</th><th>A2</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  box.querySelectorAll('tbody tr[data-geometry-scan-row]').forEach(row=>{
    row.addEventListener('click',()=>{
      const i=Number(row.dataset.geometryScanRow);
      const slider=$('geomScanPointSlider');
      if(slider && Number.isInteger(i)) slider.value=String(i+1);
      syncGeometryScanPointSlider(points.length);
      if(getSingleCache() && checkedValue('sampleMode')==='single') renderGeometry(getSingleCache(),Number($('hwSlider')?.value)||0);
    });
  });
}

function currentGeometryScanOutputTab(){
  return $('geometryScanTabPlot')?.classList.contains('active') ? 'plot' : 'table';
}

function setGeometryScanOutputTab(name){
  const plot=name==='plot';
  try{ localStorage.setItem(GEOMETRY_SCAN_OUTPUT_STORAGE_KEY,plot?'plot':'table'); }catch(_e){}
  $('geometryScanTabTable')?.classList.toggle('active',!plot);
  $('geometryScanTabPlot')?.classList.toggle('active',plot);
  $('geometryScanTabTable')?.setAttribute('aria-selected',String(!plot));
  $('geometryScanTabPlot')?.setAttribute('aria-selected',String(plot));
  $('geometryScanTablePane')?.classList.toggle('hidden',plot);
  $('geometryScanPlotPane')?.classList.toggle('hidden',!plot);
  updateGeometryAnglesVisibility();
  if(plot && getSingleCache() && checkedValue('sampleMode')==='single'){
    requestAnimationFrame(()=>requestAnimationFrame(()=>renderGeometry(getSingleCache(),Number($('hwSlider')?.value)||0)));
  }
}

function moveGeometryPlotForMode(scan){
  const plot=$('geometryPlot');
  const mount=$(scan?'geometryScanPlotMount':'geometryDefaultPlotMount');
  if(plot && mount && plot.parentNode!==mount) mount.appendChild(plot);
}

function setGeometryCalculationMode(mode){
  const scan=mode==='scan';
  try{ localStorage.setItem(GEOMETRY_CALC_MODE_STORAGE_KEY,scan?'scan':'single'); }catch(_e){}
  $('geometryModeSingle')?.classList.toggle('active',!scan);
  $('geometryModeScan')?.classList.toggle('active',scan);
  $('geometryModeSingle')?.setAttribute('aria-selected',String(!scan));
  $('geometryModeScan')?.setAttribute('aria-selected',String(scan));
  updateGeometryCalculationModeVisibility();
  if(getSingleCache() && checkedValue('sampleMode')==='single'){
    requestAnimationFrame(()=>requestAnimationFrame(()=>renderGeometry(getSingleCache(),Number($('hwSlider')?.value)||0)));
  }
}

function updateGeometryAnglesVisibility(){
  const singleSample=checkedValue('sampleMode')==='single';
  const scan=singleSample && geometryCalculationMode()==='scan';
  // In Scan mode the compact TAS summary belongs to the TAS geometry view,
  // while the Table tab keeps its existing table-only layout. Single/Powder
  // continue to show the summary exactly where they did before.
  const show=!scan || currentGeometryScanOutputTab()==='plot';
  $('geometryAngles')?.classList.toggle('hidden',!show);
}

function updateGeometryCalculationModeVisibility(){
  const singleSample=checkedValue('sampleMode')==='single';
  const scan=singleSample && geometryCalculationMode()==='scan';
  $('geometryCalcModeTabs')?.classList.toggle('hidden',!singleSample);
  $('singleGeometryTarget')?.classList.toggle('hidden',!singleSample || scan);
  $('scanGeometryTarget')?.classList.toggle('hidden',!scan);
  $('powderGeometryTarget')?.classList.toggle('hidden',singleSample);
  $('geometryScanOutput')?.classList.toggle('hidden',!scan);
  updateGeometryAnglesVisibility();
  $('geometryDefaultPlotMount')?.classList.toggle('hidden',scan);
  moveGeometryPlotForMode(scan);
}

function geometryResultSummaryHtml(cache,target,isPowder,sense,displaySense){
  const a=target.angles;
  const shown=geometryDisplayedMotorAngles(target,isPowder,sense,displaySense);
  const qValue=isPowder
    ? target.q
    : norm(hklToQ(cache.rl,[target.calc.h,target.calc.k,target.calc.l]));
  const hklLine=!isPowder
    ? `<div class="geometry-result-line geometry-hkl-line">(h,k,l)=(${[target.calc.h,target.calc.k,target.calc.l].map(v=>Number(v).toFixed(3)).join(', ')})</div>`
    : '';
  const energyLine=`Ei=${target.Ei.toFixed(3)} meV, Ef=${target.Ef.toFixed(3)} meV, Q=${qValue.toFixed(4)} Å⁻¹`;
  const angleLine=`M1=${formatAngle(shown.m1)}°, M2=${formatAngle(shown.m2)}°, S1=${formatAngle(shown.s1)}°, S2=${formatAngle(shown.s2)}°, A1=${formatAngle(shown.a1)}°, A2=${formatAngle(shown.a2)}°`+
    (!isPowder && a.warning?` &nbsp; | &nbsp; ${a.warning}`:'');
  const darkWarnings=!isPowder
    ? qeDarkBlockWarningsForHKLE(cache,[target.calc.h,target.calc.k,target.calc.l],target.calc.hw)
    : [];
  // Keep a dedicated warning row even when there is no current Dark-angle
  // warning.  Single and Scan TAS geometry therefore keep exactly the same
  // vertical footprint while the selected point changes.
  const darkWarningText=darkWarnings.length
    ? `Warning: ${darkWarnings.join(' / ')}`
    : '&nbsp;';
  const darkWarningLine=!isPowder
    ? `<div class="geometry-result-line geometry-warning-line warning-text">${darkWarningText}</div>`
    : '';
  return `${hklLine}<div class="geometry-result-line geometry-energy-line">${energyLine}</div><div class="geometry-result-line geometry-angle-line">${angleLine}</div>${darkWarningLine}`;
}

function renderGeometry(cache,index=0){
  const isPowder=checkedValue("sampleMode")==="powder" || !!cache?.powder;
  const i=Math.max(0,Math.min(index,Math.max(0,(cache.hwList?.length||1)-1)));
  // Powder has no crystallographic sample orientation, but the TAS scattering
  // sign still determines the displayed motor-angle branch exactly as it does
  // for Single crystal.
  const convention=tasConvention(selectedTasSense(),selectedS1Sign());
  const sense=convention.sense;
  // Schematic placement depends on physical scattering Sense only.
  const displaySense=convention.sense;
  const scanMode=!isPowder && geometryCalculationMode()==='scan';
  const scanPoints=scanMode ? geometryScanPoints() : [];
  updateGeometryPlaneWarning(scanPoints);
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
    // Always build one canonical physical +-+ / CCW-positive geometry here.
    // The selected physical Sense is applied exactly once by the display mirror
    // below.  Previously -+- was already selected inside qeGeometryAngles() and
    // then mirrored again here, so +-+ and -+- collapsed to the same schematic.
    const canonicalConvention=tasConvention("+-+","ccw");
    const drawTarget=isPowder
      ? powderGeometryTarget(canonicalConvention,true)
      : qeGeometryAngles(cache,null,canonicalConvention,scanCalc);
    const {angles,ki,kf}=drawTarget;
    source=[-L,0];
    mono=[0,0];
    thetaKi=deg2rad(angles.m2);
    sample=[mono[0]+L*Math.cos(thetaKi),mono[1]+L*Math.sin(thetaKi)];
    // Build the detector arm in the canonical +-+ drawing frame. In that
    // frame the physical S2 arm is clockwise. The -+- schematic is produced
    // by the single display reflection below, which turns this same physical
    // arm into the required counter-clockwise S2 geometry. Do not apply the
    // Sense sign here as well, or -+- is reflected twice and appears clockwise.
    const s2Draw=-Math.abs(Number(angles.s2));
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

  if(displaySense==="-+-") {
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
      // Sample-attached directions follow the physical S1 rotation sense.
      // Sample-attached Dark directions use the same crystallographic azimuth as U/V.
      // Use exactly the same relative crystallographic azimuth as the U/V guides
      // below. qAngle already contains the TAS-sense mirror, so applying another
      // handedness factor here makes the -+- Dark overlay rotate opposite to U/V.
      referenceBase=qAngle+crystalDelta;
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
        // Keep the Reference-Q Dark-angle direction locked to the same
        // crystallographic rotation used by the displayed U/V guides.
        base=qAngle+crystalDelta;
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

      // TAS Geometry display only: keep the Direct-beam zero in the physical frame.
      const geometryDirectBeamCorrection=asset.ref==="Direct beam"
        ? -directBeamCorrection
        : directBeamCorrection;

      // Keep the reference zero/calibration exactly where it is, but make the
      // user-entered Rotation/Offset follow the sample S1 sign convention.
      // For -+- that means +dark angle is counter-clockwise, while the existing
      // Direct-beam correction remains on its validated (clockwise) calibration
      // side.  Fixed-reference angles are laboratory-fixed and stay unchanged.
      // Unwrap the entered motor interval *before* applying its sign.  Applying
      // CW polarity first turns [-15,+15] into [+15,-15]; the old a1<a0 rule
      // then interpreted that as an almost-full 360-degree sector.
      let motorFrom=offset+from;
      let motorTo=offset+to;
      if(motorTo<motorFrom) motorTo+=360;

      // Dark-angle input is an S1 motor coordinate.  Use the same encoder polarity
      // as the validated S1-range display.  Sense changes the base geometry, but
      // must not swap CW and CCW here.  Fixed remains laboratory-fixed.
      const inputSign=asset.ref==="Fixed" ? +1 : convention.s1EncoderSign;
      const a0=inputSign*motorFrom+geometryDirectBeamCorrection;
      const a1=inputSign*motorTo+geometryDirectBeamCorrection;
      const aa=linspace(a0,a1,120).map(d=>base+deg2rad(d));
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
      // qAngle already contains the selected TAS geometry mirror.  Keep the
      // entered reciprocal-space U->V handedness relative to that mirrored Q;
      // reflecting the relative azimuth a second time makes -+- appear
      // left-handed.  The crystallographic plane itself remains right-handed.
      uArrowAngle=qAngle+(phiU-phiT);
      vArrowAngle=qAngle+(phiV-phiT);
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
  if(scanMode){
    renderGeometryScanTable(cache,scanPoints,sense,displaySense,scanIndex);
  }
  if(angleBox){
    if(target){
      angleBox.classList.remove("error-text");
      angleBox.innerHTML=geometryResultSummaryHtml(cache,target,isPowder,sense,displaySense);
    }else{
      angleBox.classList.add("error-text");
      angleBox.textContent=`Angle calculation unavailable: ${targetError}`;
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


  return {
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
  };
}
