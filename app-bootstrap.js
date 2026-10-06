export function createAppBootstrap(deps){
  const {$, setNeutronData, isGitHubPages, isLocalDirectoryListingHost, loadJsonDirectory, loadCifDirectory, instruments, backgroundMaterials, sampleEnvironments, legacyRangeInstruments, clearError, fillCrystal, updateModeVisibility, updateEnergyLabel, updateCalcMode, updateSupermirrorUI, updateAutoW, initializeTimeEstimateUI, initializeScriptUI, setQEMapTab, restoreGeometrySubTabsFromStorage, setActiveTab, setStatus, refreshSelect, refreshBackgroundSelect, BACKGROUND_SLOTS, updateBackgroundSelectAvailability, refreshDarkEnvironmentSelect, darkAssetSlots, applySampleEnvironmentDefaults, updateDarkReferenceUI, setupAppHeader, initializeResponsivePlotResize, ensureExtendedToolboxUI, initializeS2Conversion, syncAbsorptionBeamFromInstrument, syncAbsorptionBeamFrom, updateAbsorptionCalculator, initializeCifGenerator, ensureNuclearLabelControl, ensureQESliderControls, bindResolutionManualCalculation, restoreLeftPanelState, restoreRightPanelState, savedActiveTab, saveLeftPanelState, saveRightPanelState, saveGlobalUIState, restoreGlobalUIState, enableGlobalUIPersistence, enableRightPanelPersistence, updateResolutionPlaneWarning, updateBraggOrientationPlaneWarning, flipScatteringPlaneUV, updateOrientationReferenceUI, applyDarkAngleSlotColors, updateGeometryQuickTargetButtons, syncGeometryTargetToOrientationReference, scheduleRecalc, recalculate, showError, currentInstrument, applyInstrumentDefaults, setBackgroundCount, setPropagationVectorCount, setDarkAssetCount, bindDynamicSidebarUI, updatePropagationVectorLabels, setGeometryCalculationMode, setGeometryScanOutputTab, currentGeometryCardTab, setGeometryCardTab, setScatteringPlaneWarning, validateAllTimeScanRows, mountTimeEstimateForScript, rightPanelControls, leftPanelControls, resolutionInstrumentDetailControls, setSavedControl, globalUIPersistentControls, currentCifOutputTab, setCifOutputTab, updateS2MaxDisplay, syncPowderLinkedInputs, selectedS1Sign, selectedTasSense, setupTasConventionUI, updateCifUI, backgroundRowIndices, checkedValue, darkAssetIds, doScanResolution, nearestHWIndex, num, propagationVectorIndices, renderResolutionScan, renderSingle, setGeometryTargetHKL, setPowderLinkDriver, getSingleCache, syncSfColorMaxControl, setToolboxFrom, setAbsorptionThicknessFromTransmissionPercent, selectCifFile, formatAbsorptionNumber, sfThresholdFraction, clearSelectedCif}=deps;
async function initializeNeutronData(){
  const response=await fetch("neutron-data.json",{cache:"no-store"});
  if(!response.ok) throw new Error(`Failed to load neutron-data.json: HTTP ${response.status}`);
  const payload=await response.json();
  setNeutronData(payload);
  return Object.keys(payload?.elements||{}).length;
}

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
  initializeTimeEstimateUI();
  initializeScriptUI();
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
  // Re-apply the geometry tab state at the end of right-panel restoration.
  // This is deliberately late: dynamic controls and saved numeric values are
  // already in place, so no subsequent initialization step can overwrite the
  // selected Single/Scan or Table/TAS geometry tab.
  restoreGeometrySubTabsFromStorage();
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
  for(const id of ['energy','energyMode','sense','s1sign']) $(id)?.addEventListener('change',()=>{
    if(checkedValue('sampleMode')==='powder') syncPowderLinkedInputs();
  });
  $('hwEntry').addEventListener('change',()=>{const singleCache=getSingleCache();if(singleCache){const i=nearestHWIndex(singleCache,Number($('hwEntry').value));renderSingle(singleCache,i);saveRightPanelState();}});
  $('s2Slider').addEventListener('input',()=>{$('s2Entry').value=Number($('s2Slider').value).toFixed(1);const singleCache=getSingleCache();if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));});
  $('s2Entry').addEventListener('change',()=>{const singleCache=getSingleCache();if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));});
  $('displayNuclearLabels').addEventListener('change',()=>{const singleCache=getSingleCache();if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));saveRightPanelState();});
  $('sfColorMaxSlider')?.addEventListener('input',()=>{
    syncSfColorMaxControl("slider");
    { const singleCache=getSingleCache(); if(singleCache) renderSingle(singleCache,Number($('hwSlider').value)); }
  });
  $('sfColorMaxEntry')?.addEventListener('change',()=>{
    syncSfColorMaxControl("entry");
    { const singleCache=getSingleCache(); if(singleCache) renderSingle(singleCache,Number($('hwSlider').value)); }
    saveRightPanelState();
  });
  $('sfThresholdEntry')?.addEventListener('change',()=>{
    sfThresholdFraction();
    { const singleCache=getSingleCache(); if(singleCache) renderSingle(singleCache,Number($('hwSlider').value)); }
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

  return {
    initializeNeutronData,
    tryLoadDir,
    tryLoadCifDir,
    mergeLegacyRangeData,
    initialize,
  };
}
