// Magnetic form factors ported from FormFactor.jl (Sunny dipole approximation).
// Q is |momentum transfer| in Å^-1; the plot is |f(Q)|², not full magnetic intensity.
import { MAGNETIC_ION_DATA } from './magnetic-form-factor-data.js';

const FOUR_PI=4*Math.PI;
const ORBITALS='SPDFGHIKLMNOQRTUVWXYZ';
const PERIODIC_SYMBOLS='H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
const atomicNumber=new Map(PERIODIC_SYMBOLS.map((symbol,i)=>[symbol,i+1]));
const ionNames=Object.keys(MAGNETIC_ION_DATA).sort((a,b)=>{
  const element=s=>s.replace(/\d+$/,'');
  return (atomicNumber.get(element(a))??999)-(atomicNumber.get(element(b))??999) ||
    Number(a.match(/\d+$/)?.[0])-Number(b.match(/\d+$/)?.[0]);
});
const GRAPH_Q_MAX=10;

export function availableMagneticIons(){return ionNames.slice();}
export function magneticIonConfigurations(label){return (MAGNETIC_ION_DATA[label]||[]).map(v=>v[0]);}
export function freeIonJ2Weight(term){
  const m=String(term).match(/^(\d+)([A-Z])(\d+(?:\/\d+)?)$/);
  if(!m) throw new Error('Cannot determine the free-ion Landé factor for '+term);
  const S=(Number(m[1])-1)/2;
  const L=ORBITALS.indexOf(m[2]);
  const J=m[3].includes('/')?Number(m[3].split('/')[0])/Number(m[3].split('/')[1]):Number(m[3]);
  if(L<0 || !Number.isFinite(J) || J===0) throw new Error('Free-ion Landé factor undefined for '+term+' (J=0). Choose another j2 setting.');
  const g=1+(J*(J+1)+S*(S+1)-L*(L+1))/(2*J*(J+1));
  if(!Number.isFinite(g) || Math.abs(g)<1e-12) throw new Error('Undefined free-ion j2 weight.');
  return (2-g)/g;
}
function gaussian(coeff,s2){
  return coeff[0]*Math.exp(-coeff[1]*s2)+coeff[2]*Math.exp(-coeff[3]*s2)+
    coeff[4]*Math.exp(-coeff[5]*s2)+coeff[6]*Math.exp(-coeff[7]*s2)+coeff[8];
}
export function computeMagneticFormFactor(label,Q,{config=null,j2Weight=0}={}){
  const variants=MAGNETIC_ION_DATA[label];
  if(!variants) throw new Error('Unknown magnetic ion: '+label);
  const entry=config==null?(variants.length===1?variants[0]:null):variants.find(v=>v[0]===config);
  if(!entry) throw new Error('Specify an electronic configuration for '+label);
  const q=Number(Q), c=Number(j2Weight);
  if(!Number.isFinite(q) || q<0) throw new Error('Q must be nonnegative.');
  if(!Number.isFinite(c)) throw new Error('j2 weight must be finite.');
  const s2=q*q/(FOUR_PI*FOUR_PI);
  const j0=gaussian(entry[2],s2);
  const j2=gaussian(entry[3],s2)*s2;
  const f=j0+c*j2;
  return {f,fSquared:f*f,j0,j2,config:entry[0],term:entry[1]};
}

// Planning-friendly defaults: largely quenched 3d/4d/5d orbital moments -> c=0;
// localized 4f/5f moments -> free-ion Landé coefficient when J != 0.
// This is a default approximation, NOT a determination of a material's electronic state.
export function automaticMagneticFormFactorWeight(config,term){
  if(/^\s*[45]f/.test(config)){
    try{return freeIonJ2Weight(term);}catch{return 0;}
  }
  return 0;
}

export function magneticFormFactorIntensityRoots(label,target,opts={},maxQ=GRAPH_Q_MAX){
  if(!Number.isFinite(target)||target<0||!Number.isFinite(maxQ)||maxQ<=0)return [];
  const intensity=q=>computeMagneticFormFactor(label,q,opts).fSquared;
  const steps=1000, eps=1e-9;
  const roots=[];
  let lo=0, flo=intensity(0)-target;
  if(Math.abs(flo)<eps)roots.push(0);
  for(let i=1;i<=steps;i++){
    const hi=maxQ*i/steps;
    const fhi=intensity(hi)-target;
    if(Math.abs(fhi)<eps)roots.push(hi);
    else if(flo*fhi<0){
      let l=lo,r=hi,a=flo;
      for(let iter=0;iter<42;iter++){
        const mid=(l+r)/2, fm=intensity(mid)-target;
        if(a*fm<=0)r=mid; else{l=mid;a=fm;}
      }
      roots.push((l+r)/2);
    }
    lo=hi;flo=fhi;
  }
  return roots.filter((v,i)=>roots.findIndex(r=>Math.abs(v-r)<1e-5)===i);
}

function displayIon(label){
  const m=label.match(/^([A-Za-z]+)(\d+)$/);
  return m?`${m[1]}${m[2]}${Number(m[2])===0?'':'+'}`:label;
}

export function initializeMagneticFormFactorUI(){
  const $=id=>document.getElementById(id);
  const ion=$('magffIon');
  if(!ion || ion.dataset.initialized==='true') return ()=>{};
  ion.dataset.initialized='true';
  const config=$('magffConfig'),configLabel=$('magffConfigLabel');
  const mode=$('magffWeightMode'),weight=$('magffWeight'),weightLabel=$('magffWeightLabel');
  const qField=$('magffQPoint'),qSlider=$('magffQSlider');
  const intensityField=$('magffIntensity');
  const info=$('magffInfo'),plot=$('magffPlot'),download=$('magffDownload');
  for(const label of ionNames)ion.add(new Option(displayIon(label),label));
  ion.value='Fe3';
  let exportRows=[];
  const fmt=n=>Number(n).toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
  const curvePoints=301;
  const grid=Array.from({length:curvePoints},(_,i)=>GRAPH_Q_MAX*i/(curvePoints-1));

  function syncConfig(){
    const variants=MAGNETIC_ION_DATA[ion.value]||[];
    config.replaceChildren();
    for(const entry of variants)config.add(new Option(entry[0],entry[0]));
    configLabel.classList.toggle('hidden',variants.length<=1);
    if(variants.length)config.value=variants[0][0];
    syncFreeIonAvailability();
  }
  function syncFreeIonAvailability(){
    const selected=MAGNETIC_ION_DATA[ion.value]?.find(v=>v[0]===config.value);
    const freeOption=mode.querySelector('option[value="free"]');
    let supported=false;
    if(selected){
      try{supported=Number.isFinite(freeIonJ2Weight(selected[1]));}catch(_e){supported=false;}
    }
    if(freeOption){
      freeOption.disabled=!supported;
      freeOption.title=supported?'':'Free-ion Landé factor is undefined for this electronic state.';
    }
    // Free-ion c is mathematically undefined for J=0 (and some other terms).
    // Avoid leaving the calculator in a broken state when the ion changes.
    if(!supported && mode.value==='free'){
      mode.value='auto';
      weightLabel.classList.add('hidden');
    }
  }
  function currentOptions(){
    const chosen=MAGNETIC_ION_DATA[ion.value]?.find(v=>v[0]===config.value);
    if(!chosen)throw new Error('Select an ion and electronic configuration.');
    let c=0;
    if(mode.value==='auto')c=automaticMagneticFormFactorWeight(chosen[0],chosen[1]);
    if(mode.value==='free')c=freeIonJ2Weight(chosen[1]);
    if(mode.value==='custom'){
      if(weight.value.trim()==='')throw new Error('Enter a custom j2 weight.');
      c=Number(weight.value);
    }
    if(!Number.isFinite(c))throw new Error('Invalid j2 weight.');
    return {config:config.value,j2Weight:c};
  }
  function setError(error){
    info.textContent=String(error?.message||error);
    info.classList.add('error');
  }
  function clearError(){info.textContent='';info.classList.remove('error');}
  function render(){
    clearError();download.disabled=true;
    try{
      const opts=currentOptions();
      const q=Number(qField.value);
      if(qField.value.trim()===''||!Number.isFinite(q)||q<0||q>GRAPH_Q_MAX)
        throw new Error(`Q must be between 0 and ${GRAPH_Q_MAX} Å⁻¹.`);
      const curve=grid.map(x=>computeMagneticFormFactor(ion.value,x,opts));
      const values=curve.map(point=>point.fSquared);
      if(values.some(v=>!Number.isFinite(v)))throw new Error('Cannot calculate form factor for this ion.');
      const {f,fSquared}=computeMagneticFormFactor(ion.value,q,opts);
      qSlider.value=String(q);
      intensityField.value=fmt(fSquared);
      exportRows=grid.map((x,i)=>[x,curve[i].f,values[i]]);
      download.disabled=false;
      if(window.Plotly && plot && !plot.closest('.hidden')){
        window.Plotly.react(plot,[
          {x:grid,y:values,customdata:curve.map(point=>point.f),type:'scatter',mode:'lines',name:'|f(Q)|²',
           hovertemplate:'Q = %{x:.3f} Å⁻¹<br>|f(Q)|² = %{y:.5f}<br>f(Q) = %{customdata:.5f}<extra></extra>'},
          {x:[q],y:[fSquared],customdata:[f],type:'scatter',mode:'markers',name:'Selected Q',
           marker:{size:10},hovertemplate:'Q = %{x:.3f} Å⁻¹<br>|f(Q)|² = %{y:.5f}<br>f(Q) = %{customdata:.5f}<extra></extra>'}
        ],{autosize:true,margin:{l:65,r:22,t:18,b:57},
            xaxis:{title:'Q (Å⁻¹)',range:[0,GRAPH_Q_MAX],zeroline:false},
            yaxis:{title:'|f(Q)|²',rangemode:'tozero',zeroline:false},
            showlegend:false,uirevision:'magff-v40'
        },{responsive:true,displaylogo:false});
      }
    }catch(error){
      exportRows=[];setError(error);
      if(window.Plotly&&plot&&!plot.closest('.hidden'))window.Plotly.purge(plot);
    }
  }
  function setQFromIntensity(raw){
    clearError();
    try{
      if(String(raw).trim()==='')throw new Error('Enter |f(Q)|².');
      const target=Number(raw),opts=currentOptions();
      if(!Number.isFinite(target)||target<0)throw new Error('|f(Q)|² must be nonnegative.');
      const roots=magneticFormFactorIntensityRoots(ion.value,target,opts,GRAPH_Q_MAX);
      if(!roots.length)throw new Error('No Q in 0–10 Å⁻¹ gives that value.');
      // Empirical fits need not be monotonic: choose the Q closest to the current one.
      const previous=Number(qField.value);
      roots.sort((a,b)=>Math.abs(a-previous)-Math.abs(b-previous));
      qField.value=Number(roots[0].toFixed(4)).toString();
      render();
    }catch(error){setError(error);}
  }
  ion.addEventListener('change',()=>{syncConfig();render();});
  config.addEventListener('change',()=>{syncFreeIonAvailability();render();});
  mode.addEventListener('change',()=>{syncFreeIonAvailability();weightLabel.classList.toggle('hidden',mode.value!=='custom');render();});
  weight.addEventListener('input',render);
  qField.addEventListener('input',render);
  qSlider.addEventListener('input',()=>{qField.value=qSlider.value;render();});
  intensityField.addEventListener('change',()=>setQFromIntensity(intensityField.value));
  intensityField.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();intensityField.blur();}});
  download.addEventListener('click',()=>{
    if(!exportRows.length)return;
    const rows=['Q_A^-1,f(Q),abs_f(Q)^2',...exportRows.map(row=>row.map(v=>v.toPrecision(12)).join(','))];
    const blob=new Blob([rows.join('\n')+'\n'],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`magnetic_form_factor_${ion.value}.csv`;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  syncConfig();render();
  // Restore the selected plot on the first visible frame after a page reload.
  // The Toolbox main tab is often initially hidden while saved UI state loads.
  const panel=$('toolboxPanel'),pane=$('toolboxFormFactorPane');
  let visibilityRedrawQueued=false;
  const redrawOnReveal=()=>{
    if(visibilityRedrawQueued || !panel || panel.classList.contains('hidden') || pane?.classList.contains('hidden'))return;
    visibilityRedrawQueued=true;
    requestAnimationFrame(()=>{visibilityRedrawQueued=false;render();});
  };
  if(panel && pane){
    const observer=new MutationObserver(redrawOnReveal);
    observer.observe(panel,{attributes:true,attributeFilter:['class']});
    observer.observe(pane,{attributes:true,attributeFilter:['class']});
  }
  return render;
}
