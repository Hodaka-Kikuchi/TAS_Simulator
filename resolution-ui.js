// Extracted from app.js without changing calculation/display behavior.
// Dependencies are injected by app.js to keep module boundaries explicit.
export function createResolutionUI(deps){
  const {
    $,
    tasMotorAngles,
    PI,
    RLRes,
    add,
    calcResolution,
    checkedValue,
    clamp,
    clearError,
    deg2rad,
    hklInCurrentScatteringPlane,
    hklToQ,
    inferOutOfPlaneHKL,
    latticeParams,
    linspace,
    markResolutionScanDirty,
    norm,
    num,
    parseNumericValue,
    powderS2ForQAtHW,
    propagationVectorIndices,
    rad2deg,
    scatteringPlaneWarningMessage,
    scheduleRecalc,
    selectedS1Sign,
    selectedTasSense,
    setScatteringPlaneWarning,
    showError,
    tasConvention,
    tasConventionFromLegacyUiSense,
    userFacingTasMessage,
  }=deps;

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
  const convention=tasConvention(selectedTasSense(),selectedS1Sign());
  const config={
    energy_mode:em,Ei:em==='Ei fixed'?E:null,Ef:em==='Ef fixed'?E:null,
    geometry:$('geometry').value,
    sense:convention.sense,s1sign:convention.s1sign,
    // Retained only for compatibility with untouched peripheral code.
    sign_config:convention.sense
  };
  const approximation={method:$('method').value};
  const focusing={monochromator:{horizontal:{enabled:$('monoHF').checked,blades:num('monoHB')},vertical:{enabled:$('monoVF').checked,blades:num('monoVB')}},analyzer:{horizontal:{enabled:$('anaHF').checked,blades:num('anaHB')},vertical:{enabled:$('anaVF').checked,blades:num('anaVB')}}};
  const col={gm_1st:$('gm1').checked,div_1st_m:num('div1m'),div_1st_h:num('div1h'),div_1st_v:num('div1v'),div_2nd_h:num('div2h'),div_2nd_v:num('div2v'),div_3rd_h:num('div3h'),div_3rd_v:num('div3v'),div_4th_h:num('div4h'),div_4th_v:num('div4v')};
  const mos={d_mono:num('dMono'),mos_mono_h:num('mosMonoH'),mos_mono_v:num('mosMonoV'),mos_sam_h:num('mosSamH'),mos_sam_v:num('mosSamV'),d_ana:num('dAna'),mos_ana_h:num('mosAnaH'),mos_ana_v:num('mosAnaV')};
  const geom={L0:num('L0'),L1:num('L1'),L2:num('L2'),L3:num('L3'),beam_width:num('beamW'),beam_height:num('beamH'),mono_width:num('monoW'),mono_height:num('monoH'),mono_thickness:num('monoT'),ana_width:num('anaW'),ana_height:num('anaH'),ana_thickness:num('anaT'),det_width:num('detW'),det_height:num('detH')};
  return {lc,rl,col,mos,config,approximation,focusing,geom,unitMode:$('unit').value};
}
// wrap180() / angleDiffDeg() are provided by tas-conventions.js.


function calcOne(calc){
  const b=collectResolutionBase();

  // Resolution sense convention:
  // The resolution core already defines the physical +-+ / -+- branches.
  // Pass the physical Sense directly. Angle/Q-E/TAS geometry now use the same
  // Sense + S1-sign convention object instead of a legacy calculation label.
  // Resolution depends on physical scattering Sense, not on the sample motor
  // encoder polarity.  Deliberately omit s1sign from the resolution config.
  const {s1sign:_s1signForMotorOnly,...resolutionBaseConfig}=b.config;
  const resolutionConfig={...resolutionBaseConfig,sense:selectedTasSense(),sign_config:selectedTasSense()};
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

  // Display the signed S2 motor angle produced by the common convention.
  const s2Display=angles.s2;

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
function resolutionScanPoints(){
  const nRaw=Math.round(num('npts'));
  const n=Number.isFinite(nRaw)?Math.max(2,nRaw):2;
  const hs=linspace(num('h0'),num('h1'),n), ks=linspace(num('k0'),num('k1'),n), ls=linspace(num('l0'),num('l1'),n);
  return Array.from({length:n},(_,i)=>[hs[i],ks[i],ls[i]]);
}

function updateResolutionPlaneWarning(){
  const scan=$('calcMode')?.value==='scan';
  if(!scan){
    setScatteringPlaneWarning('resolutionPlaneWarning',scatteringPlaneWarningMessage([num('h'),num('k'),num('l')]));
    return;
  }
  const points=resolutionScanPoints();
  let outside=0, firstError='';
  for(const hkl of points){
    const result=hklInCurrentScatteringPlane(hkl);
    if(!result.ok){ outside++; if(result.error && !firstError) firstError=result.error; }
  }
  const message=firstError
    ? `Warning: ${firstError}`
    : (outside ? `Warning: ${outside} of ${points.length} scan point(s) are outside the current U-V scattering plane.` : '');
  setScatteringPlaneWarning('resolutionPlaneWarning',message);
}

function doSingleResolution(){
  clearError();
  updateResolutionPlaneWarning();
  try{
    const e=calcOne({hw:num('hw'),h:num('h'),k:num('k'),l:num('l')});
    scanResolutionPlotLimits=null;
    $('scanNav').classList.add('hidden');
    // Single-point Calc: always fit to this calculation's resolution ellipse.
    renderResolution(e,'',e.result.lim);
    $('calcSingleResolution')?.classList.remove('needs-calc');
  }catch(e){showError(e);}
}
function doScanResolution(){
  clearError();
  updateResolutionPlaneWarning();
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
    $('calcScanResolution')?.classList.remove('needs-calc');
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

function bindResolutionManualCalculation(){
  const panel=$('resolutionPanel');
  if(!panel || panel.dataset.manualResolutionBound==='1') return;
  panel.dataset.manualResolutionBound='1';
  for(const control of panel.querySelectorAll('input, select')){
    if(control.id==='scanSlider') continue;
    const markCurrent=()=>{
      if($("calcMode")?.value==="scan") markResolutionScanDirty();
    };
    control.addEventListener('input',markCurrent);
    control.addEventListener('change',markCurrent);
  }
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

// Toolbox unit conversion / S2 conversion / attenuation UI is implemented in toolbox.js.

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
  const convention=tasConvention(selectedTasSense(),selectedS1Sign());
  return convention.s2EncoderSign*Math.abs(s2abs);
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

  // Powder has no sample orientation, but its motor signs follow the same
  // Sense/S1-sign convention as Single-crystal Angle calculation.
  let convention=tasConvention(selectedTasSense(),selectedS1Sign());
  if(uiSenseOverride && typeof uiSenseOverride==="object" && "sense" in uiSenseOverride){
    convention=tasConvention(uiSenseOverride.sense,uiSenseOverride.s1sign);
  }else if(uiSenseOverride){
    const legacy=tasConventionFromLegacyUiSense(uiSenseOverride);
    convention=tasConvention(legacy.sense,legacy.s1sign);
  }
  if(rawSenseForDrawing){
    convention=tasConvention(convention.sense,"ccw");
  }

  const angles={
    m1:convention.monoSign*m1abs,
    m2:2*convention.monoSign*m1abs,
    s1:0,
    s2:convention.s2EncoderSign*s2abs,
    a1:convention.analyzerSign*a1abs,
    a2:2*convention.analyzerSign*a1abs,
    warning:''
  };
  return {calc:{q,hw,s2:s2abs},q,s2:s2abs,angles,Ei,Ef,ki,kf};
}


  return {
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
    hasScanResults:()=>scanResults.length>0
  };
}
