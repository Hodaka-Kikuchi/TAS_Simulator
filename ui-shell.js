// Extracted from app.js without changing calculation/display behavior.
// Dependencies are injected by app.js to keep module boundaries explicit.
export function createUIShell(deps){
  const {
    $,
    BACKGROUND_SLOTS,
    GEOMETRY_CALC_MODE_STORAGE_KEY,
    GEOMETRY_SCAN_OUTPUT_STORAGE_KEY,
    add,
    applyInstrumentDefaults,
    applySampleEnvironmentDefaults,
    backgroundRowValues,
    buildResolutionLattice,
    checkedValue,
    currentGeometryCardTab,
    currentGeometryScanOutputTab,
    darkAssetIds,
    darkAssetSlots,
    darkAssetValues,
    geometryCalculationMode,
    markResolutionScanDirty,
    mountTimeEstimateForScript,
    propagationVectorValues,
    refreshDarkEnvironmentSelect,
    renderGeometry,
    renderQEVectorMap,
    renderResolutionScan,
    renderSingle,
    replaceBackgroundRows,
    replaceDarkAssets,
    replacePropagationVectors,
    resolutionPanelIsVisible,
    scheduleRecalc,
    selectedS1Sign,
    setBackgroundCount,
    setCifOutputTab,
    setDarkAssetCount,
    setDarkRangeCount,
    setGeometryCalculationMode,
    setGeometryCardTab,
    setGeometryScanOutputTab,
    setPropagationVectorCount,
    setQEMapTab,
    setupTasConventionUI,
    sub,
    updateAutoW,
    updateBackgroundSelectAvailability,
    updateDarkReferenceUI,
    updateEnergyLabel,
    updateModeVisibility,
    updateOrientationReferenceUI,
    updateResolutionPlaneWarning,
    updateS2MaxDisplay,
    updateSupermirrorUI,
    getSingleCache,
    getPowderCache,
    hasScanResults
  }=deps;

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

function plotHasLayout(el){
  return !!(el && (el._fullLayout || el.classList?.contains('js-plotly-plot')));
}

function ensureVisiblePrimaryPlots(){
  if(typeof Plotly === "undefined") return;

  const qePanel=$('qePanel');
  if(qePanel && !qePanel.classList.contains('hidden')){
    const vector=!$('qeVectorMapPane')?.classList.contains('hidden');
    if(vector){
      if(getSingleCache()) renderQEVectorMap(getSingleCache());
    }else if(checkedValue('sampleMode')==='single'){
      if(getSingleCache()) renderSingle(getSingleCache(),Number($('hwSlider')?.value)||0);
    }else{
      const powderPlot=$('powderPlot');
      if(plotHasLayout(powderPlot)) safeResizePlot(powderPlot);
      else scheduleRecalc(0);
    }

    // renderSingle() also refreshes geometry.  If Time estimate is selected it
    // intentionally remains hidden; otherwise guarantee the currently selected
    // Single/Scan TAS geometry after the pane is measurable.
    if(currentGeometryCardTab()==='angles'){
      if(checkedValue('sampleMode')==='powder' && getPowderCache()) renderGeometry(getPowderCache(),0);
      else if(getSingleCache()) renderGeometry(getSingleCache(),Number($('hwSlider')?.value)||0);
    }
  }

  const resolutionPanel=$('resolutionPanel');
  if(resolutionPanel && !resolutionPanel.classList.contains('hidden')){
    if($('calcMode')?.value==='single'){
      // Single Resolution is automatic; render only after the panel is visible.
      scheduleRecalc(0);
    }else if(hasScanResults() && !$('result')?.classList.contains('hidden')){
      // Never launch the expensive scan calculation here.  Repaint only an
      // already-calculated result when returning to the tab.
      renderResolutionScan(Number($('scanSlider')?.value)||1);
    }else{
      ['plotUE','plotVE','plotUV','plotWE'].forEach(id=>safeResizePlot($(id)));
    }
  }
}

function scheduleVisiblePrimaryPlotRecovery(){
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    ensureVisiblePrimaryPlots();
    resizeVisiblePlots();
  }));
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
  const isQE=name==='qe', isResolution=name==='resolution', isToolbox=name==='toolbox', isCifGenerator=name==='cif-generator', isStructure=name==='structure', isScript=name==='script';
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
  $('structurePanel')?.classList.toggle('hidden',!isStructure);
  $('scriptPanel')?.classList.toggle('hidden',!isScript);
  for(const [id,on] of [['tabQe',isQE],['tabResolution',isResolution],['tabToolbox',isToolbox],['tabCifGenerator',isCifGenerator],['tabStructure',isStructure],['tabScript',isScript]]){
    $(id).classList.toggle('active',on);
    $(id).setAttribute('aria-selected',String(on));
  }
  if(isResolution){
    // Scan remains Calculate-driven.  Single is recovered after the visible
    // panel has completed layout by scheduleVisiblePrimaryPlotRecovery().
    if($("calcMode")?.value==="scan" && !hasScanResults()) markResolutionScanDirty();
  }else if(isQE){
    // Q-E may have been intentionally left stale while the heavy Resolution
    // tab was active; rebuild it only when the user actually returns here.
    scheduleRecalc(0);
  }
  try{ localStorage.setItem(ACTIVE_TAB_STORAGE_KEY,name); }catch(_e){}
  scheduleVisiblePrimaryPlotRecovery();
}
function updateCalcMode(){
  const scan=$('calcMode').value==='scan';
  $('singleInputs').classList.toggle('hidden',scan);
  $('scanInputs').classList.toggle('hidden',!scan);
  updateResolutionPlaneWarning();
  if(scan) markResolutionScanDirty();
  else if(resolutionPanelIsVisible()) scheduleVisiblePrimaryPlotRecovery();
}

// ==================== App chrome + right-panel persistence ====================
const RIGHT_PANEL_STORAGE_KEY='tas-simulator-right-panel-v1';
const ACTIVE_TAB_STORAGE_KEY='tas-simulator-active-tab-v1';
let restoringRightPanel=false;

function setupAppHeader(){
  document.title='TAS Simulator';
  const header=document.querySelector('header');
  const h1=header?.querySelector('h1');
  if(h1) h1.textContent='TAS Simulator';
  if(!header) return;

  // Keep the user manual next to the repository link in the top status bar.
  // Both are ordinary static links so they work on localhost and GitHub Pages.
  if(!document.getElementById('manualLink')){
    const manual=document.createElement('a');
    manual.id='manualLink';
    manual.href='TAS_Simulator_Manual.html';
    manual.target='_blank';
    manual.rel='noopener noreferrer';
    manual.textContent='Manual';
    manual.title='Open the PLANE-TAS user manual';
    Object.assign(manual.style,{whiteSpace:'nowrap',fontWeight:'600'});
    header.appendChild(manual);
  }

  if(!document.getElementById('githubLink')){
    // Project repository: fixed URL so the GitHub link works identically on
    // localhost, GitHub Pages, and custom-domain deployments.
    const repoUrl='https://github.com/Hodaka-Kikuchi/TAS_Simulator';
    const github=document.createElement('a');
    github.id='githubLink';
    github.href=repoUrl;
    github.target='_blank';
    github.rel='noopener noreferrer';
    github.textContent='GitHub';
    github.title='Open this project on GitHub';
    Object.assign(github.style,{whiteSpace:'nowrap',fontWeight:'600'});
    header.appendChild(github);
  }

  // Keep status, Manual, and GitHub together at the right side of the header.
  header.style.display='flex';
  header.style.alignItems='center';
  header.style.gap='14px';
  const status=header.querySelector('#status');
  if(status) status.style.marginLeft='auto';
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
    // Keep the tab state alongside the right-panel values as well as in its
    // dedicated keys.  This makes Single/Scan and Table/TAS geometry survive
    // reloads even if initialization later rebuilds or re-renders the panel.
    values.__geometryCalculationMode=geometryCalculationMode();
    values.__geometryScanOutputTab=currentGeometryScanOutputTab();
    localStorage.setItem(RIGHT_PANEL_STORAGE_KEY,JSON.stringify({version:2,values}));
    localStorage.setItem(GEOMETRY_CALC_MODE_STORAGE_KEY,values.__geometryCalculationMode);
    localStorage.setItem(GEOMETRY_SCAN_OUTPUT_STORAGE_KEY,values.__geometryScanOutputTab);
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
    // Restore the geometry sub-tabs after every right-panel value has been
    // applied.  Applying this last prevents later UI refreshes from leaving the
    // HTML-default Single/Table tabs selected.
    const savedGeometryMode=saved.values.__geometryCalculationMode;
    const savedGeometryOutput=saved.values.__geometryScanOutputTab;
    if(savedGeometryMode==='single' || savedGeometryMode==='scan') setGeometryCalculationMode(savedGeometryMode);
    if(savedGeometryOutput==='table' || savedGeometryOutput==='plot') setGeometryScanOutputTab(savedGeometryOutput);
    return true;
  }finally{restoringRightPanel=false;}
}

function savedActiveTab(){
  try{
    const name=localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    return ['qe','resolution','toolbox','cif-generator','structure','script'].includes(name) ? name : 'qe';
  }catch(_e){ return 'qe'; }
}

function restoreGeometrySubTabsFromStorage(){
  try{
    const mode=localStorage.getItem(GEOMETRY_CALC_MODE_STORAGE_KEY);
    const output=localStorage.getItem(GEOMETRY_SCAN_OUTPUT_STORAGE_KEY);
    setGeometryCalculationMode(mode==='scan'?'scan':'single');
    setGeometryScanOutputTab(output==='plot'?'plot':'table');
  }catch(_e){
    setGeometryCalculationMode('single');
    setGeometryScanOutputTab('table');
  }
}

function enableRightPanelPersistence(){
  for(const panelId of ['qePanel','resolutionPanel','toolboxPanel']){
    const panel=$(panelId); if(!panel) continue;
    panel.addEventListener('input',saveRightPanelState);
    panel.addEventListener('change',saveRightPanelState);
  }
}

// Catch-all UI persistence.  Dedicated serializers above remain authoritative
// for dynamic/complex widgets (Dark angle, BG, Time estimate, Script, etc.),
// while this layer prevents ordinary stable-ID controls or tab choices from
// silently falling through the cracks as the UI evolves.
const APP_UI_STORAGE_KEY='tas-simulator-ui-state-v1';
let restoringGlobalUI=false;
let globalUIPersistenceEnabled=false;

function globalUIPersistentControls(){
  return [...document.querySelectorAll('input[id], select[id], textarea[id]')].filter(el=>{
    const type=String(el.type||'').toLowerCase();
    if(['button','submit','file'].includes(type)) return false;
    if(el.readOnly) return false; // derived outputs are recomputed, not restored
    return true;
  });
}

function currentCifOutputTab(){
  return $('cifOutputTabReflections')?.classList.contains('active') ? 'reflections' : 'preview';
}

function saveGlobalUIState(){
  if(restoringGlobalUI || !globalUIPersistenceEnabled) return;
  try{
    const controls={};
    for(const el of globalUIPersistentControls()){
      controls[el.id]=(el.type==='checkbox'||el.type==='radio') ? !!el.checked : el.value;
    }
    const tabs={
      main:['qe','resolution','toolbox','cif-generator','structure','script'].find(name=>{
        const id={qe:'tabQe',resolution:'tabResolution',toolbox:'tabToolbox','cif-generator':'tabCifGenerator',structure:'tabStructure',script:'tabScript'}[name];
        return $(id)?.classList.contains('active');
      }) || 'qe',
      qeMap:$('qeMapTabVector')?.classList.contains('active') ? 'vector' : 'constant',
      geometryCard:currentGeometryCardTab(),
      geometryMode:geometryCalculationMode(),
      geometryOutput:currentGeometryScanOutputTab(),
      cifOutput:currentCifOutputTab()
    };
    localStorage.setItem(APP_UI_STORAGE_KEY,JSON.stringify({version:1,controls,tabs}));
  }catch(_e){}
}

function restoreGlobalUIState(){
  let saved;
  try{ saved=JSON.parse(localStorage.getItem(APP_UI_STORAGE_KEY)||'null'); }catch(_e){ return false; }
  if(!saved || saved.version!==1 || !saved.controls || typeof saved.controls!=='object') return false;
  restoringGlobalUI=true;
  try{
    for(const el of globalUIPersistentControls()){
      const value=saved.controls[el.id];
      if(value===undefined) continue;
      if(el.type==='checkbox'||el.type==='radio') el.checked=!!value;
      else if(el.tagName==='SELECT'){
        if([...el.options].some(o=>o.value===String(value))) el.value=String(value);
      }else el.value=String(value);
    }
    const tabs=saved.tabs||{};
    if(['constant','vector'].includes(tabs.qeMap)) setQEMapTab(tabs.qeMap);
    if(['angles','time'].includes(tabs.geometryCard)) setGeometryCardTab(tabs.geometryCard);
    if(['single','scan'].includes(tabs.geometryMode)) setGeometryCalculationMode(tabs.geometryMode);
    if(['table','plot'].includes(tabs.geometryOutput)) setGeometryScanOutputTab(tabs.geometryOutput);
    if(['preview','reflections'].includes(tabs.cifOutput)) setCifOutputTab(tabs.cifOutput);
    if(['qe','resolution','toolbox','cif-generator','structure','script'].includes(tabs.main)) setActiveTab(tabs.main);
    updateCalcMode(); updateModeVisibility(); updateOrientationReferenceUI();
    for(const slot of darkAssetSlots()) updateDarkReferenceUI(slot);
    updateBackgroundSelectAvailability();
    return true;
  }finally{ restoringGlobalUI=false; }
}

function enableGlobalUIPersistence(){
  if(globalUIPersistenceEnabled) return;
  globalUIPersistenceEnabled=true;
  document.addEventListener('input',saveGlobalUIState);
  document.addEventListener('change',saveGlobalUIState);
  document.addEventListener('click',event=>{
    if(event.target.closest?.('[role="tab"]')) setTimeout(saveGlobalUIState,0);
  });
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
    // Background-material rows are dynamic.  Persist their ordered selections
    // explicitly so add/remove/rebuild operations cannot lose the user's BG
    // choices even if a dynamic <select> is temporarily absent from the DOM.
    values.__backgroundRows=backgroundRowValues();
    values.backgroundCount=values.__backgroundRows.length;
    // Dynamic sidebar groups need an explicit structural snapshot as well as
    // per-control values. Add/remove operations do not emit input/change events,
    // and recreating the DOM from only fixed IDs can otherwise lose row counts.
    values.__propagationVectors=propagationVectorValues();
    values.propagationCount=values.__propagationVectors.length;
    values.__darkAssets=darkAssetValues();
    values.darkAssetCount=values.__darkAssets.length;
    // S1 sign is dynamically injected by setupTasConventionUI(); keep an explicit
    // snapshot so future layout changes cannot accidentally omit it.
    values.s1sign=selectedS1Sign();
    localStorage.setItem(LEFT_PANEL_STORAGE_KEY,JSON.stringify({version:3,values}));
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
    const savedPropagationVectors=Array.isArray(v.__propagationVectors)
      ? v.__propagationVectors.map(row=>({
          enabled:!!row?.enabled,
          h:String(row?.h ?? "0"), k:String(row?.k ?? "0"), l:String(row?.l ?? "0")
        }))
      : null;
    let propagationCount=savedPropagationVectors?.length || Number(v.propagationCount);
    if(!(propagationCount>=1)){
      propagationCount=1;
      for(let i=2;i<=3;i++){
        if(v[`q_enable${i}`] || ["h","k","l"].some(c=>nonzero(v[`q${i}_${c}`]))) propagationCount=i;
      }
    }
    if(savedPropagationVectors?.length) replacePropagationVectors(savedPropagationVectors,{recalc:false});
    else setPropagationVectorCount(propagationCount);

    const savedBackgroundRows=Array.isArray(v.__backgroundRows)
      ? v.__backgroundRows.map(row=>({key:String(row?.key||"")}))
      : null;
    let backgroundCount=savedBackgroundRows?.length || Number(v.backgroundCount);
    if(!(backgroundCount>=1)){
      backgroundCount=1;
      for(let i=2;i<=BACKGROUND_SLOTS.length;i++) if(v[`backgroundSelect${i}`]) backgroundCount=i;
    }
    if(savedBackgroundRows?.length) replaceBackgroundRows(savedBackgroundRows,{recalc:false});
    else setBackgroundCount(backgroundCount);

    const savedDarkAssets=Array.isArray(v.__darkAssets)
      ? v.__darkAssets.map(card=>({
          enabled:card?.enabled!==undefined ? !!card.enabled : true,
          se:String(card?.se||""), ref:String(card?.ref||"Reference Q"),
          rotation:Number(card?.rotation), refH:Number(card?.refH), refK:Number(card?.refK), refL:Number(card?.refL),
          ranges:Array.isArray(card?.ranges) ? card.ranges.map(r=>({from:Number(r?.from),to:Number(r?.to),offset:Number(r?.offset)})) : [{}]
        }))
      : null;
    if(savedDarkAssets?.length){
      // Exact snapshot: preserve asset count, range count, checkbox state,
      // sample-environment selection and all user-entered values.
      replaceDarkAssets(savedDarkAssets,{recalc:false});
    }else{
      // Backward-compatible restore for pre-v113 localStorage.
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

      // Legacy saves relied on the selected sample-environment JSON to seed
      // the rest of each dark-angle card before individual controls were restored.
      for(const slot of darkAssetSlots()){ const ids=darkAssetIds(slot); if(setSavedControl(ids.se,v[ids.se])) applySampleEnvironmentDefaults(slot); }
    }

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
    const explicitBackgroundRows=!!savedBackgroundRows?.length;
    // The Resolution-only instrument details used to live in the permanent
    // sidebar. Include them here only for migration of the old left-panel
    // localStorage values; subsequent edits are persisted by resolutionPanel.
    const legacyRestoreControls=[...leftPanelControls(),...resolutionInstrumentDetailControls()];
    for(const el of legacyRestoreControls){
      if(el.id==='instrument'||darkSeIds.has(el.id)) continue;
      if(explicitBackgroundRows && /^backgroundSelect\d+$/.test(el.id)) continue;
      setSavedControl(el.id,v[el.id],{dispatchChange:el.id==='monoCrystal'||el.id==='anaCrystal'});
    }

    updateModeVisibility(); updateEnergyLabel(); updateS2MaxDisplay(); updateSupermirrorUI(); updateAutoW();
    return true;
  }finally{restoringLeftPanel=false;}
}


  return {
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
  };
}
