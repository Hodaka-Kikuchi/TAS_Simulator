// Toolbox feature module extracted from app.js.
// DOM behavior is preserved; app.js injects the small UI/state boundary.

import {deg2rad, rad2deg, clamp} from "./tas-core.js";
import {initializeMagneticFormFactorUI} from "./magnetic-form-factor.js";
import {neutronAbsorptionSummary, absorptionCrossSectionBarn, scatteringCrossSectionBarn, coherentCrossSectionBarn, incoherentCrossSectionBarn, neutronDataRecord} from "./cif-structure.js";

export function createToolbox({
  $, num, checkedValue,
  getSelectedCifStructure,
  getSelectedCifFileName
}){
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
  let toolboxTabsBound=false;
  let absorptionCsvRows=[];
  function initializeToolboxSubtabs(){
    if(toolboxTabsBound) return;
    toolboxTabsBound=true;
    const renderFormFactor=initializeMagneticFormFactorUI();
    // Keep the attenuation wavevector in sync with E and wavelength.
    $('absorptionK')?.addEventListener('input',()=>{
      syncAbsorptionBeamFrom('wavevector');
      updateAbsorptionCalculator();
    });
    $('absorptionDownload')?.addEventListener('click',()=>{
      if(!absorptionCsvRows.length)return;
      const content=['sample_thickness_mm,overall_transmission_percent',
        ...absorptionCsvRows.map(row=>row.map(v=>Number(v).toPrecision(12)).join(','))].join('\n')+'\n';
      const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download='neutron_attenuation.csv';
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    const buttons=[...document.querySelectorAll('#toolboxPanel [data-toolbox-target]')];
    const panes=[...document.querySelectorAll('#toolboxPanel .toolbox-subpanel')];
    // Main navigation may hide a rendered Plotly graph; redraw upon returning.
    document.getElementById('tabToolbox')?.addEventListener('click',()=>{
      requestAnimationFrame(()=>{
        if(!document.getElementById('toolboxPanel')?.classList.contains('hidden')){
          if(document.getElementById('toolboxTabFormFactor')?.classList.contains('active')) renderFormFactor();
          if(document.getElementById('toolboxTabAttenuation')?.classList.contains('active')) updateAbsorptionCalculator();
        }
      });
    });
    const storageKey='tas_simulator_toolbox_subtab_v1';
    function activateSubtab(btn,{persist=true}={}){
      for(const b of buttons){
        const selected=b===btn;
        b.classList.toggle('active',selected);
        b.setAttribute('aria-selected',String(selected));
        b.tabIndex=selected?0:-1;
      }
      for(const pane of panes) pane.classList.toggle('hidden',pane.id!==btn.dataset.toolboxTarget);
      if(persist){
        try{localStorage.setItem(storageKey,btn.dataset.toolboxTarget);}catch(_e){}
      }
      requestAnimationFrame(()=>{
        if(btn.dataset.toolboxTarget==='toolboxFormFactorPane') renderFormFactor();
        if(btn.dataset.toolboxTarget==='toolboxAttenuationPane') updateAbsorptionCalculator();
      });
    }
    let remembered=null;
    try{remembered=localStorage.getItem(storageKey);}catch(_e){}
    const initial=buttons.find(b=>b.dataset.toolboxTarget===remembered) || buttons[0];
    if(initial)activateSubtab(initial,{persist:false});
    for(const btn of buttons)btn.addEventListener('click',()=>activateSubtab(btn));
  }


  function ensureExtendedToolboxUI(){
    initializeToolboxSubtabs();
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
    if(table && !document.getElementById('harmThirdMass')){
      const old=[...table.children];
      const oldCols=8; // row label + 7 original quantities
      const prefixes=['harmThird','harmHalf','harmDouble','harmTriple'];
      const extraHeaders=['Mass equivalent (kg)','Magnetic field (T)','Energy (J)','Heat (cal)'];
      const suffixes=['Mass','Field','J','Cal'];
      const frag=document.createDocumentFragment();
      for(let row=0;row<5;row++){
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
    ensureFlexibleS2Controls();
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
      for(const [factor,prefix] of [[1/3,'harmThird'],[1/2,'harmHalf'],[2,'harmDouble'],[3,'harmTriple']]){
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
  const S2_NEUTRON_UNITS=[
    ['lambda','Å'],
    ['energy','meV'],
    ['k','Å⁻¹'],
    ['thz','THz'],
    ['cm','cm⁻¹']
  ];
  const S2_XRAY_UNITS=[
    ['lambda','Å'],
    ['energy','meV'],
    ['k','Å⁻¹'],
    ['thz','THz'],
    ['cm','cm⁻¹']
  ];
  // Photon relations for the X-ray beam.  Keep these separate from the
  // neutron conversions above: E(lambda) and f(lambda) are different for
  // photons and massive neutrons.
  const XRAY_MEV_ANGSTROM=12398419.843320026; // E[meV] = hc/lambda
  const XRAY_THz_ANGSTROM=2997924.58;         // f[THz] = c/lambda
  const XRAY_CM1_ANGSTROM=1e8;                // wavenumber[cm^-1] = 1/lambda[cm]

  function formatS2BeamNumber(value,digits=6){
    const v=Number(value);
    if(!Number.isFinite(v)) return '';
    if(v===0) return '0';
    if(Math.abs(v)>=1e6 || Math.abs(v)<1e-5) return v.toExponential(6);
    return v.toFixed(digits).replace(/0+$/,'').replace(/\.$/,'');
  }

  function neutronLambdaFromS2Value(value,unit){
    const v=Number(value);
    if(!(v>0)) return NaN;
    if(unit==='energy') return Math.sqrt(NEUTRON_E_LAMBDA/v);
    if(unit==='k') return 2*Math.PI/v;
    if(unit==='thz') return Math.sqrt(NEUTRON_E_LAMBDA/(v*MEV_PER_THz));
    if(unit==='cm') return Math.sqrt(NEUTRON_E_LAMBDA/(v/CM1_PER_MEV));
    return v;
  }

  function neutronS2ValueFromLambda(lambda,unit){
    const l=Number(lambda);
    if(!(l>0)) return NaN;
    const v=toolboxValues(l);
    if(unit==='energy') return v.E;
    if(unit==='k') return v.k;
    if(unit==='thz') return v.thz;
    if(unit==='cm') return v.cm;
    return v.lambda;
  }

  function xrayLambdaFromS2Value(value,unit){
    const v=Number(value);
    if(!(v>0)) return NaN;
    if(unit==='energy') return XRAY_MEV_ANGSTROM/v;
    if(unit==='k') return 2*Math.PI/v;
    if(unit==='thz') return XRAY_THz_ANGSTROM/v;
    if(unit==='cm') return XRAY_CM1_ANGSTROM/v;
    return v;
  }

  function xrayS2ValueFromLambda(lambdaA,unit){
    const l=Number(lambdaA);
    if(!(l>0)) return NaN;
    if(unit==='energy') return XRAY_MEV_ANGSTROM/l;
    if(unit==='k') return 2*Math.PI/l;
    if(unit==='thz') return XRAY_THz_ANGSTROM/l;
    if(unit==='cm') return XRAY_CM1_ANGSTROM/l;
    return l;
  }

  function currentS2XrayLambdaA(){
    return xrayLambdaFromS2Value($('s2ConvXrayLambda')?.value,$('s2ConvXrayUnit')?.value||'lambda');
  }

  function currentS2NeutronLambdaA(){
    return neutronLambdaFromS2Value($('s2ConvNeutronLambda')?.value,$('s2ConvNeutronUnit')?.value||'lambda');
  }

  function setS2XrayLambdaA(lambdaA){
    const field=$('s2ConvXrayLambda'), unit=$('s2ConvXrayUnit')?.value||'lambda';
    if(field) field.value=formatS2BeamNumber(xrayS2ValueFromLambda(lambdaA,unit));
  }

  function setS2NeutronLambdaA(lambdaA){
    const field=$('s2ConvNeutronLambda'), unit=$('s2ConvNeutronUnit')?.value||'lambda';
    if(field) field.value=formatS2BeamNumber(neutronS2ValueFromLambda(lambdaA,unit));
  }

  function setS2NeutronDefaultFromInstrument(){
    const energy=num('energy');
    if(!(energy>0)) return;
    setS2NeutronLambdaA(Math.sqrt(NEUTRON_E_LAMBDA/energy));
    updateS2Conversion();
  }

  function makeS2UnitSelect(id,items,defaultValue){
    const select=document.createElement('select');
    select.id=id;
    select.className='s2-unit-select';
    select.setAttribute('aria-label','Unit');
    for(const [value,label] of items){
      const option=document.createElement('option');
      option.value=value; option.textContent=label;
      select.appendChild(option);
    }
    select.value=defaultValue;
    select.dataset.previousUnit=defaultValue;
    return select;
  }

  function ensureFlexibleS2Controls(){
    const xField=$('s2ConvXrayLambda'), nField=$('s2ConvNeutronLambda');
    if(!xField || !nField) return;

    const xLabel=xField.closest('label');
    if(xLabel && !$('s2ConvXrayUnit')){
      const unit=makeS2UnitSelect('s2ConvXrayUnit',S2_XRAY_UNITS,'lambda');
      const row=document.createElement('div'); row.className='s2-beam-entry-row s2-beam-entry-row-xray';
      xField.type='number'; xField.step='any'; xField.min='0';
      row.append(xField,unit);
      xLabel.replaceChildren(document.createTextNode('X-ray beam'),row);
    }

    const nLabel=nField.closest('label');
    if(nLabel && !$('s2ConvNeutronUnit')){
      const unit=makeS2UnitSelect('s2ConvNeutronUnit',S2_NEUTRON_UNITS,'lambda');
      const button=document.createElement('button');
      button.id='s2ConvNeutronDefault'; button.type='button'; button.textContent='Set default';
      button.className='s2-set-default';
      nField.readOnly=false; nField.type='number'; nField.step='any'; nField.min='0';
      const row=document.createElement('div'); row.className='s2-beam-entry-row s2-beam-entry-row-neutron';
      row.append(nField,unit,button);
      nLabel.replaceChildren(document.createTextNode('Neutron beam'),row);
    }

    if(!document.getElementById('s2FlexibleBeamStyle')){
      const style=document.createElement('style'); style.id='s2FlexibleBeamStyle';
      style.textContent=`
        .s2-beam-entry-row{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(66px,.55fr);gap:6px;align-items:center;margin-top:4px}
        .s2-beam-entry-row-neutron{grid-template-columns:minmax(0,1fr) minmax(66px,.52fr) auto}
        .s2-beam-entry-row input,.s2-beam-entry-row select{width:100%!important;min-width:0!important;margin:0!important}
        .s2-set-default{white-space:nowrap;width:auto!important;padding-left:10px!important;padding-right:10px!important}
        @media(max-width:1250px){.s2-beam-entry-row-neutron{grid-template-columns:minmax(105px,1fr) 66px;}.s2-set-default{grid-column:1/-1}}
      `;
      document.head.appendChild(style);
    }
  }

  function updateS2Conversion(){
    const xLambda=currentS2XrayLambdaA();
    const raw=String($("s2ConvXrayS2")?.value||"").trim();
    const nLambda=currentS2NeutronLambdaA();
    const neutronS2Field=$("s2ConvNeutronS2");
    const dField=$("s2ConvD");
    const info=$("s2ConvInfo");
    if(neutronS2Field) neutronS2Field.value="";
    if(dField) dField.value="";
    if(info){ info.textContent=""; info.classList.remove("warning"); }
    if(!(xLambda>0)){
      if(info){ info.textContent='Enter a positive X-ray beam value.'; info.classList.add('warning'); }
      return;
    }
    if(!(nLambda>0)){
      if(info){ info.textContent='Enter a positive neutron beam value or press Set default.'; info.classList.add('warning'); }
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
      info.textContent=`${blocked} entr${blocked===1?'y':'ies'} cannot satisfy the neutron Bragg condition at the current neutron beam setting.`;
      info.classList.add('warning');
    }
  }

  function initializeS2Conversion(){
    ensureFlexibleS2Controls();
    const source=$("s2ConvSource"), xField=$("s2ConvXrayLambda"), s2=$("s2ConvXrayS2");
    const xUnit=$('s2ConvXrayUnit'), nField=$('s2ConvNeutronLambda'), nUnit=$('s2ConvNeutronUnit');
    const defaultButton=$('s2ConvNeutronDefault');
    if(!source || !xField || !s2 || !xUnit || !nField || !nUnit) return;
    // Unit selects may have been restored from saved right-panel state after
    // the dynamic controls were created.  Treat the restored choice as the
    // current source unit for the first conversion.
    xUnit.dataset.previousUnit=xUnit.value;
    nUnit.dataset.previousUnit=nUnit.value;

    source.addEventListener('change',()=>{
      if(source.value!=='custom') setS2XrayLambdaA(Number(source.value));
      updateS2Conversion();
    });

    xField.addEventListener('input',()=>{
      const lambdaA=currentS2XrayLambdaA();
      const matching=[...source.options].find(o=>o.value!=='custom' && Math.abs(Number(o.value)-lambdaA)<5e-7);
      source.value=matching?matching.value:'custom';
      updateS2Conversion();
    });

    xUnit.addEventListener('change',()=>{
      const oldUnit=xUnit.dataset.previousUnit||'lambda';
      const lambdaA=xrayLambdaFromS2Value(xField.value,oldUnit);
      xUnit.dataset.previousUnit=xUnit.value;
      if(lambdaA>0) xField.value=formatS2BeamNumber(xrayS2ValueFromLambda(lambdaA,xUnit.value));
      updateS2Conversion();
    });

    nField.addEventListener('input',updateS2Conversion);
    nUnit.addEventListener('change',()=>{
      const oldUnit=nUnit.dataset.previousUnit||'lambda';
      const lambdaA=neutronLambdaFromS2Value(nField.value,oldUnit);
      nUnit.dataset.previousUnit=nUnit.value;
      if(lambdaA>0) nField.value=formatS2BeamNumber(neutronS2ValueFromLambda(lambdaA,nUnit.value));
      updateS2Conversion();
    });
    defaultButton?.addEventListener('click',setS2NeutronDefaultFromInstrument);
    s2.addEventListener('input',updateS2Conversion);

    // Backward-compatible first load: start from the current fixed instrument
    // energy only when no restored/custom neutron value exists. Afterwards the
    // field remains independent until Set default is pressed.
    if(!(Number(nField.value)>0)) setS2NeutronDefaultFromInstrument();
    else updateS2Conversion();
  }

  // ==================== Neutron attenuation ====================
  const AVOGADRO=6.02214076e23;
  const ATOMIC_MASS={
    H:1.008,He:4.002602,Li:6.94,Be:9.0121831,B:10.81,C:12.011,N:14.007,O:15.999,F:18.998403163,Ne:20.1797,
    Na:22.98976928,Mg:24.305,Al:26.9815385,Si:28.085,P:30.973761998,S:32.06,Cl:35.45,Ar:39.948,K:39.0983,Ca:40.078,
    Sc:44.955908,Ti:47.867,V:50.9415,Cr:51.9961,Mn:54.938044,Fe:55.845,Co:58.933194,Ni:58.6934,Cu:63.546,Zn:65.38,
    Ga:69.723,Ge:72.630,As:74.921595,Se:78.971,Br:79.904,Kr:83.798,Rb:85.4678,Sr:87.62,Y:88.90584,Zr:91.224,
    Nb:92.90637,Mo:95.95,Tc:98,Ru:101.07,Rh:102.90550,Pd:106.42,Ag:107.8682,Cd:112.414,In:114.818,Sn:118.710,
    Sb:121.760,Te:127.60,I:126.90447,Xe:131.293,Cs:132.90545196,Ba:137.327,La:138.90547,Ce:140.116,Pr:140.90766,
    Nd:144.242,Pm:145,Sm:150.36,Eu:151.964,Gd:157.25,Tb:158.92535,Dy:162.500,Ho:164.93033,Er:167.259,Tm:168.93422,
    Yb:173.045,Lu:174.9668,Hf:178.49,Ta:180.94788,W:183.84,Re:186.207,Os:190.23,Ir:192.217,Pt:195.084,Au:196.966569,
    Hg:200.592,Tl:204.38,Pb:207.2,Bi:208.98040,Po:209,At:210,Rn:222,Fr:223,Ra:226,Ac:227,Th:232.0377,
    Pa:231.03588,U:238.02891,Np:237,Pu:244,Am:243,Cm:247,Bk:247,Cf:251,Es:252,Fm:257,Md:258,No:259,Lr:266,
    Rf:267,Db:268,Sg:269,Bh:270,Hs:277,Mt:278,Ds:281,Rg:282,Cn:285,Nh:286,Fl:289,Mc:290,Lv:293,Ts:294,Og:294
  };

  function parseChemicalFormula(formula){
    const text=String(formula||'').replace(/\s+/g,'');
    if(!text) throw new Error('Enter a chemical formula.');
    let i=0;
    function number(){
      const m=text.slice(i).match(/^(\d+(?:\.\d+)?)/);
      if(!m) return 1;
      i+=m[1].length; return Number(m[1]);
    }
    function group(stopChar=''){
      const out=new Map();
      while(i<text.length && (!stopChar || text[i]!==stopChar)){
        if(text[i]==='('){
          i++; const sub=group(')');
          if(text[i]!==')') throw new Error('Unmatched parenthesis in chemical formula.');
          i++; const mult=number();
          for(const [el,n] of sub) out.set(el,(out.get(el)||0)+n*mult);
          continue;
        }
        const m=text.slice(i).match(/^([A-Z][a-z]?)/);
        if(!m) throw new Error(`Cannot parse chemical formula near "${text.slice(i)}".`);
        const el=m[1]; i+=el.length; const n=number();
        out.set(el,(out.get(el)||0)+n);
      }
      return out;
    }
    const result=group();
    if(i!==text.length) throw new Error('Cannot parse chemical formula.');
    return result;
  }

  function neutronManualAttenuationSummary(formula,densityGcm3,wavelengthA,thicknessCm=0){
    const composition=parseChemicalFormula(formula);
    const density=Number(densityGcm3), lambda=Number(wavelengthA), thickness=Number(thicknessCm);
    if(!(density>0)) throw new Error('Enter a positive density in g/cm³.');
    if(!(lambda>0)) throw new Error('A positive neutron wavelength is required.');
    if(!(thickness>=0)) throw new Error('Sample thickness must be zero or positive.');

    let molarMass=0, atomCount=0, sumBRe=0, sumBIm=0, sigmaAbsFU=0, sigmaScatFU=0;
    const rows=[];
    for(const [element,count] of composition){
      const mass=ATOMIC_MASS[element];
      if(!(mass>0)) throw new Error(`No atomic mass is available for ${element}.`);
      const rec=neutronDataRecord(element);
      const sigmaAbs=absorptionCrossSectionBarn(element,lambda);
      const sigmaScat=scatteringCrossSectionBarn(element);
      const sigmaCoh=coherentCrossSectionBarn(element);
      const sigmaIncoh=incoherentCrossSectionBarn(element);
      const bRe=Number(rec?.b_coherent_fm?.real), bIm=Number(rec?.b_coherent_fm?.imag||0);
      if(!Number.isFinite(sigmaAbs)) throw new Error(`No absorption cross section is available for ${element}.`);
      if(!Number.isFinite(sigmaScat)) throw new Error(`No total scattering cross section is available for ${element}.`);
      if(!Number.isFinite(bRe)) throw new Error(`No coherent scattering length is available for ${element}.`);
      molarMass+=count*mass; atomCount+=count;
      sigmaAbsFU+=count*sigmaAbs; sigmaScatFU+=count*sigmaScat;
      sumBRe+=count*bRe; sumBIm+=count*bIm;
      rows.push({element,count,sigmaAbsBarn:sigmaAbs,sigmaCohBarn:sigmaCoh,sigmaIncohBarn:sigmaIncoh,sigmaScatBarn:sigmaScat,
        absContributionBarn:count*sigmaAbs,scatContributionBarn:count*sigmaScat});
    }
    if(!(molarMass>0) || !(atomCount>0)) throw new Error('Chemical formula contains no atoms.');
    const meanBRe=sumBRe/atomCount, meanBIm=sumBIm/atomCount;
    const sigmaCohPerAtom=4*Math.PI*(meanBRe*meanBRe+meanBIm*meanBIm)/100;
    const sigmaCohFU=atomCount*sigmaCohPerAtom;
    const sigmaIncohFU=Math.max(0,sigmaScatFU-sigmaCohFU);
    const sigmaAttFU=sigmaAbsFU+sigmaIncohFU;
    const numberDensityFU=density/molarMass*AVOGADRO;
    const barnToCm2=1e-24;
    const muAbsCmInv=numberDensityFU*sigmaAbsFU*barnToCm2;
    const muCohCmInv=numberDensityFU*sigmaCohFU*barnToCm2;
    const muIncohCmInv=numberDensityFU*sigmaIncohFU*barnToCm2;
    const muScatCmInv=numberDensityFU*sigmaScatFU*barnToCm2;
    const muAttenuationCmInv=muAbsCmInv+muIncohCmInv;
    const muFullCmInv=muAttenuationCmInv+muCohCmInv;
    for(const row of rows){
      row.absMuCmInv=numberDensityFU*row.absContributionBarn*barnToCm2;
      row.scatMuCmInv=numberDensityFU*row.scatContributionBarn*barnToCm2;
    }
    return {
      mode:'manual',formula:String(formula).trim(),densityGcm3:density,molarMassGmol:molarMass,numberDensityFU,
      wavelengthA:lambda,thicknessCm:thickness,atomCount,
      muAbsCmInv,muCohCmInv,muIncohCmInv,muScatCmInv,muAttenuationCmInv,muFullCmInv,muTotalCmInv:muAttenuationCmInv,
      absorptionLengthCm:muAbsCmInv>0?1/muAbsCmInv:Infinity,
      attenuationLengthCm:muAttenuationCmInv>0?1/muAttenuationCmInv:Infinity,
      fullLengthCm:muFullCmInv>0?1/muFullCmInv:Infinity,
      transmissionAbsorptionOnly:Math.exp(-muAbsCmInv*thickness),
      transmission:Math.exp(-muAttenuationCmInv*thickness),
      elements:rows.sort((a,b)=>(b.absMuCmInv+b.scatMuCmInv)-(a.absMuCmInv+a.scatMuCmInv))
    };
  }

  function absorptionInputMode(){ return $('absorptionInputMode')?.value==='cif' ? 'cif' : 'manual'; }
  function currentAbsorptionSummary(lambda,thicknessCm){
    if(absorptionInputMode()==='cif'){
      const structure=getSelectedCifStructure();
      if(!structure) throw new Error('Select a CIF/mCIF for attenuation calculation.');
      return neutronAbsorptionSummary(structure,lambda,thicknessCm);
    }
    return neutronManualAttenuationSummary($('absorptionFormula')?.value,$('absorptionDensity')?.value,lambda,thicknessCm);
  }

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
      const lambda=Math.sqrt(NEUTRON_E_LAMBDA/energy);
      if($('absorptionEnergy')) $('absorptionEnergy').value=formatAbsorptionNumber(energy,6);
      if($('absorptionLambda')) $('absorptionLambda').value=formatAbsorptionNumber(lambda,6);
      if($('absorptionK')) $('absorptionK').value=formatAbsorptionNumber(2*Math.PI/lambda,6);
    }finally{ absorptionBeamUpdating=false; }
  }

  function syncAbsorptionBeamFrom(kind){
    if(absorptionBeamUpdating) return;
    const energyField=$('absorptionEnergy'),lambdaField=$('absorptionLambda'),kField=$('absorptionK');
    if(!energyField || !lambdaField) return;
    let lambda;
    if(kind==='energy'){
      const E=Number(energyField.value);
      if(!(E>0)) return;
      lambda=Math.sqrt(NEUTRON_E_LAMBDA/E);
    }else if(kind==='wavevector'){
      const k=Number(kField?.value);
      if(!(k>0)) return;
      lambda=2*Math.PI/k;
    }else{
      lambda=Number(lambdaField.value);
      if(!(lambda>0))return;
    }
    absorptionBeamUpdating=true;
    try{
      if(kind!=='energy')energyField.value=formatAbsorptionNumber(NEUTRON_E_LAMBDA/(lambda*lambda),6);
      if(kind!=='lambda')lambdaField.value=formatAbsorptionNumber(lambda,6);
      if(kField && kind!=='wavevector')kField.value=formatAbsorptionNumber(2*Math.PI/lambda,6);
    }finally{absorptionBeamUpdating=false;}
    // Attenuation and Reflections are two editors of the Instrument's fixed
    // Ei/Ef energy. Propagate only a valid completed numerical value; never
    // dispatch while writing the calculated wavelength/wavevector fields.
    const energy=NEUTRON_E_LAMBDA/(lambda*lambda);
    const fixedField=$('energy');
    if(fixedField && Number.isFinite(energy) && energy>0 &&
       Math.abs(Number(fixedField.value)-energy)>1e-9*Math.max(1,energy)){
      fixedField.value=String(Number(energy.toPrecision(12)));
      fixedField.dispatchEvent(new Event('input',{bubbles:true}));
      fixedField.dispatchEvent(new Event('change',{bubbles:true}));
    }
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
    const seField=$('absorptionSETransmission');
    let sePct=Number(seField?.value);
    if(!Number.isFinite(sePct)) sePct=100;
    sePct=Math.min(100,Math.max(0,sePct));
    if(!(sePct>0)) throw new Error('Overall transmission cannot be solved when SE transmission is 0%.');
    if(overallPct>sePct+1e-9) throw new Error(`Overall transmission cannot exceed the SE transmission (${formatAbsorptionNumber(sePct,3)}%).`);
    const samplePct=overallPct/sePct*100;
    const lambda=attenuationWavelengthA();
    const base=currentAbsorptionSummary(lambda,0);
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
    const selectedCifStructure=getSelectedCifStructure();
    const selectedCifFileName=getSelectedCifFileName();
    const inputMode=absorptionInputMode();
    const host=$('absorptionResults');
    const status=$('absorptionCifStatus');
    const energyField=$('absorptionEnergy');
    const lambdaField=$('absorptionLambda');
    const thicknessEntry=$('absorptionThickness');
    const thicknessSlider=$('absorptionThicknessSlider');
    const transmissionOut=$('absorptionTransmission');
    const seTransmissionField=$('absorptionSETransmission');
    const plot=$('absorptionPlot');
    const download=$('absorptionDownload');
    absorptionCsvRows=[];
    if(download)download.disabled=true;
    if(!host || !status || !energyField || !lambdaField || !thicknessEntry || !thicknessSlider || !transmissionOut) return;

    const lambda=attenuationWavelengthA();
    const energyMeV=attenuationEnergyMeV();
    status.value=selectedCifFileName || selectedCifStructure?.name || 'No CIF/mCIF selected';

    if(inputMode==='cif' && !selectedCifStructure){
      transmissionOut.value='';
      host.innerHTML='';
      if(plot && window.Plotly) Plotly.purge(plot);
      return;
    }

    let thicknessMm=Math.max(0,Number(thicknessEntry.value)||0);
    if(document.activeElement!==thicknessEntry) thicknessEntry.value=formatAbsorptionNumber(thicknessMm,2);
    try{
      const r=currentAbsorptionSummary(lambda,thicknessMm/10);
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
        const absMu=r.mode==='manual' ? Number(e.absMuCmInv)||0 : (Number(e.absContributionBarn)||0)/r.volumeA3;
        const scatMu=r.mode==='manual' ? Number(e.scatMuCmInv)||0 : (Number(e.scatContributionBarn)||0)/r.volumeA3;
        const ratioDen=(r.muAbsCmInv+r.muScatCmInv) || 1;
        return `<tr><td>${e.element}</td><td>${formatAbsorptionNumber(e.count,4)}</td><td>${formatAbsorptionNumber(absMu,5)}</td><td>${formatAbsorptionNumber(scatMu,5)}</td><td>${formatAbsorptionNumber(100*(absMu+scatMu)/ratioDen,2)}%</td></tr>`;
      }).join('');

      const lengthText=v=>Number.isFinite(v)?`${formatAbsorptionNumber(v,4)} cm`:'∞';
      host.innerHTML=`
        <div class="absorption-summary-cards">
          ${r.mode==='manual'
            ? `<div class="absorption-summary-card"><div class="absorption-summary-label">Density / molar mass</div><div class="absorption-summary-value">${formatAbsorptionNumber(r.densityGcm3,4)} g/cm³ · ${formatAbsorptionNumber(r.molarMassGmol,4)} g/mol</div></div>`
            : `<div class="absorption-summary-card"><div class="absorption-summary-label">Cell volume</div><div class="absorption-summary-value">${formatAbsorptionNumber(r.volumeA3,4)} Å³</div></div>`}
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
        <div class="absorption-table-wrap"><table class="absorption-table absorption-atom-table"><thead><tr><th>Element</th><th>${r.mode==='manual'?'Atoms / formula':'Atoms / cell'}</th><th>Abs (cm⁻¹)</th><th>Scat total (cm⁻¹)</th><th>Ratio</th></tr></thead><tbody>${rows}</tbody></table></div>`;

      const n=241;
      const x=Array.from({length:n},(_,i)=>sliderMax*i/(n-1));
      const y=x.map(mm=>seTransPct*Math.exp(-muAtt*mm/10));
      absorptionCsvRows=x.map((mm,i)=>[mm,y[i]]);
      if(download)download.disabled=false;
      if(plot && window.Plotly){
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

  return {
    ensureExtendedToolboxUI,
    setToolboxFrom,
    initializeS2Conversion,
    syncAbsorptionBeamFromInstrument,
    syncAbsorptionBeamFrom,
    formatAbsorptionNumber,
    setAbsorptionThicknessFromTransmissionPercent,
    updateAbsorptionCalculator
  };
}
