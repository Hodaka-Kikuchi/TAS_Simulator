// Toolbox UI wiring extracted from app.js.
// Keeps toolbox.js focused on conversion/absorption logic while this module
// owns DOM event binding and the two-phase startup needed by restored UI state.

import {createToolbox} from "./toolbox.js";

export function createToolboxUI({
  $, num, checkedValue,
  getSelectedCifStructure,
  getSelectedCifFileName,
  selectCifFile,
  showError
}){
  const toolbox=createToolbox({
    $, num, checkedValue,
    getSelectedCifStructure,
    getSelectedCifFileName
  });

  const {
    ensureExtendedToolboxUI,
    setToolboxFrom,
    initializeS2Conversion,
    syncAbsorptionBeamFromInstrument,
    syncAbsorptionBeamFrom,
    formatAbsorptionNumber,
    setAbsorptionThicknessFromTransmissionPercent,
    updateAbsorptionCalculator
  }=toolbox;

  let bound=false;

  // Dynamic controls must exist before right-panel state is restored.
  function prepareToolboxUI(){
    ensureExtendedToolboxUI();
  }

  // Bind only after saved right-panel values have been restored. This preserves
  // the startup ordering from app.js and avoids default synchronization winning
  // over browser-local state.
  function bindToolboxUI(){
    if(bound) return;
    bound=true;

    for(const id of ['toolLambda','toolEnergy','toolK','toolTHz','toolTemp','toolCm','toolVelocity','toolMass','toolField','toolJ','toolCal']){
      $(id)?.addEventListener('input',()=>setToolboxFrom(id));
    }

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
    for(const id of ['energy','energyMode','instrument']){
      $(id)?.addEventListener('change',()=>{ syncAbsorptionBeamFromInstrument(); updateAbsorptionCalculator(); });
    }

    syncAbsorptionBeamFromInstrument();
    updateAbsorptionCalculator();
    setToolboxFrom('toolLambda');
  }

  return {
    ...toolbox,
    prepareToolboxUI,
    bindToolboxUI
  };
}
