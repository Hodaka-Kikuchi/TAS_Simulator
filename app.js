import {
  PI, EPS, deg2rad, rad2deg, clamp,
  add, sub, scale, dot, norm, cross, normalize,
  RL_calc, UB_calc, makeSpiceScatteringPlaneBasis, reciprocalVectors,
  linspace, arange, interpExtrap
} from "./tas-core.js";
import {RL_calc as RLRes, inferOutOfPlaneHKL, normalizeScatteringPlaneHKL, calcResolution} from "./resolution-core.js";

const $ = id => document.getElementById(id);
const instruments = new Map();
const samples = new Map();
const sampleEnvironments = new Map();

// Four fixed background-scattering slots keep the sidebar compact.  Each slot
// reuses the existing sample JSON data and is assigned a stable display color.
const BACKGROUND_SLOTS=[
  {id:"backgroundSelect1",rgb:[0,0,128]},      // navy
  {id:"backgroundSelect2",rgb:[165,42,42]},    // brown
  {id:"backgroundSelect3",rgb:[44,160,44]},    // green
  {id:"backgroundSelect4",rgb:[148,103,189]}   // purple
];
function selectedBackgrounds(){
  return BACKGROUND_SLOTS.map((slot,index)=>({slot,index,key:$(slot.id)?.value||""}))
    .filter(x=>x.key && samples.has(x.key));
}

function enabledPropagationVectors(){
  // Global display switch: keep q1/q2/q3 values/enables intact while hiding
  // all magnetic Bragg peaks when Propagation vectors > show is off.
  if($("showPropagation") && !$("showPropagation").checked) return [];
  const out=[];
  for(let i=1;i<=3;i++){
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

function num(id){ return Number($(id).value); }
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
function showError(err){
  $("errorBox").textContent = err instanceof Error ? err.message : String(err);
  $("errorBox").classList.remove("hidden");
}
function clearError(){ $("errorBox").classList.add("hidden"); $("errorBox").textContent=""; }
function setStatus(text){ $("status").textContent=text; }

function hklToQ(rl,hkl){
  return add(add(scale(rl.astar,hkl[0]),scale(rl.bstar,hkl[1])),scale(rl.cstar,hkl[2]));
}

// Convert every orientation-reference mode into the original Reference-Q
// calibration pair {HKL, S1}.  Downstream geometry intentionally stays on the
// validated Reference-Q pipeline.
//
// For ki perpendicular U/V, imagine observing the elastic U/V Bragg peak.  In
// the usual theta--2theta geometry the sample is theta=S2/2 away from the
// ki-perpendicular condition.  Therefore, if ki perpendicular U/V is defined as
// the new S1=0, that virtual Bragg observation has S1_ref = -S2_ref/2.
function effectiveOrientationReference(rl, fixedEnergyMeV=null){
  const mode=$('orientationReference')?.value || 'bragg';
  if(mode==='bragg'){
    return {mode,hkl:[num('refh'),num('refk'),num('refl')],s1:num('refs1')};
  }
  const hkl=mode==='perpV'
    ? [num('Vh'),num('Vk'),num('Vl')]
    : [num('Uh'),num('Uk'),num('Ul')];
  const qNorm=norm(hklToQ(rl,hkl));
  const E=Number(fixedEnergyMeV);
  if(!(qNorm>1e-12)) throw new Error(`${mode==='perpV'?'V':'U'} must define a non-zero reciprocal-space vector.`);
  if(!(E>0)) throw new Error('A positive reference energy is required for ki perpendicular U/V orientation.');
  const k=Math.sqrt(E/2.072);
  const arg=qNorm/(2*k);
  if(arg>1+1e-10) throw new Error(`${mode==='perpV'?'V':'U'} Bragg peak is inaccessible at the selected reference energy.`);
  const s2Ref=2*rad2deg(Math.asin(clamp(arg,-1,1)));
  return {mode,hkl,s1:-0.5*s2Ref,s2Ref};
}

function updateOrientationReferenceUI(){
  const mode=$('orientationReference')?.value || 'bragg';
  $('braggReferenceInputs')?.classList.toggle('hidden',mode!=='bragg');
}

function updateGeometryQuickTargetButtons(){
  const mode=$('orientationReference')?.value || 'perpU';
  const bragg=mode==='bragg';
  $('geomPerpU')?.classList.toggle('hidden',bragg);
  $('geomPerpV')?.classList.toggle('hidden',bragg);
  $('geomSetBragg')?.classList.toggle('hidden',!bragg);

  const showDark=!!$('addDark')?.checked;
  for(let slot=1;slot<=3;slot++){
    const ids=darkAssetIds(slot);
    const visible=showDark && !!$(ids.enable)?.checked && checkedValue(ids.ref)==='Reference Q';
    $(`geomSetRefQ${slot}`)?.classList.toggle('hidden',!visible);
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

async function fetchJson(url){
  const response = await fetch(url, {cache: "no-store"});

  if(!response.ok){
    throw new Error(`${url} を読み込めませんでした (HTTP ${response.status})。`);
  }

  return await response.json();
}

function normalizeJsonFileList(value){
  if(Array.isArray(value)){
    return value.map(String);
  }

  // Optional alternative manifest format:
  // { "files": ["a.json", "b.json"] }
  if(value && Array.isArray(value.files)){
    return value.files.map(String);
  }

  throw new Error("index.json は JSON ファイル名の配列、または {files:[...]} である必要があります。");
}

function isGitHubPages(){ return window.location.hostname.endsWith("github.io"); }

async function discoverJsonFilesFromGitHub(directory){
  const owner=window.location.hostname.split('.')[0];
  const parts=window.location.pathname.split('/').filter(Boolean);
  const repo=parts[0];
  if(!repo) throw new Error("GitHub Pages repository name could not be inferred. Add directory/index.json.");
  const apiUrl=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${directory}?ref=main`;
  const response=await fetch(apiUrl,{cache:"no-store",headers:{"Accept":"application/vnd.github+json"}});
  if(!response.ok) throw new Error(`GitHub API: ${directory}/ (HTTP ${response.status})`);
  const items=await response.json();
  return items.filter(x=>x&&x.type==="file").map(x=>x.name).filter(x=>/\.json$/i.test(x)&&x.toLowerCase()!=="index.json").sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}

async function discoverJsonFilesFromDirectoryListing(directory){
  const response = await fetch(`${directory}/`, {cache: "no-store"});

  if(!response.ok){
    throw new Error(
      `${directory}/ を読み込めませんでした。` +
      ` ディレクトリがプロジェクト内にあるか確認してください。`
    );
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const files = [...doc.querySelectorAll("a[href]")]
    .map(a => a.getAttribute("href"))
    .filter(Boolean)
    .map(href => {
      try{
        const url = new URL(href, window.location.href);
        return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      }catch(_err){
        return null;
      }
    })
    .filter(Boolean)
    .filter(name => /\.json$/i.test(name))
    .filter(name => name.toLowerCase() !== "index.json");

  return [...new Set(files)].sort((a,b)=>a.localeCompare(b));
}

async function discoverJsonFiles(directory){
  // 1) If an index.json exists, use it. This remains supported for
  //    compatibility with other static hosting services.
  try{
    const manifestResponse = await fetch(
      `${directory}/index.json`,
      {cache: "no-store"}
    );

    if(manifestResponse.ok){
      const manifest = await manifestResponse.json();

      const files = normalizeJsonFileList(manifest)
        .filter(name => /\.json$/i.test(name))
        .filter(name => name.toLowerCase() !== "index.json");

      if(files.length > 0){
        return files.sort((a,b)=>a.localeCompare(b));
      }
    }
  }catch(_err){
    // Continue to automatic discovery.
  }

  // 2) On GitHub Pages, GitHub does not expose an HTML directory listing.
  //    Query the public GitHub Contents API instead. This means that adding
  //    a new JSON file to the repository is enough; index.json does not need
  //    to be maintained manually.
  if(isGitHubPages()){
    const files = await discoverJsonFilesFromGitHub(directory);

    if(files.length === 0){
      throw new Error(`${directory}/ に JSON ファイルがありません。`);
    }

    return files;
  }

  // 3) Local development with e.g. "python -m http.server 8888".
  //    Python exposes a directory listing, so parse that automatically.
  const files = await discoverJsonFilesFromDirectoryListing(directory);

  if(files.length === 0){
    throw new Error(
      `${directory}/ に JSON ファイルを見つけられませんでした。`
    );
  }

  return files;
}

async function loadJsonDirectory(directory, targetMap){
  targetMap.clear();

  const files = await discoverJsonFiles(directory);

  for(const filename of files){
    const obj = await fetchJson(`${directory}/${filename}`);
    const key = filename.replace(/\.json$/i, "");
    targetMap.set(key, obj);
  }

  return files.length;
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

function normalizeCrystalName(name){ const aliases={PG002:"PG(002)",PG004:"PG(004)"}; return aliases[name]||name; }
function setIf(id,x){ if($(id)&&x!==undefined&&x!==null&&Number.isFinite(Number(x))) $(id).value=x; }
function setBool(id,x){ if($(id)&&x!==undefined&&x!==null) $(id).checked=!!x; }
function setSelect(id,x){ if(!$(id)||x===undefined||x===null) return; if([...$(id).options].some(o=>o.value===String(x))) $(id).value=String(x); }
const CRYSTALS={'PG(002)':3.355,'PG(004)':1.677,'Heusler':3.437,'CoFe':1.771,'Ge(111)':3.266,'Ge(311)':1.714,'Ge(511)':1.089,'Ge(533)':0.863,'Si(111)':3.135,'Cu(111)':2.087,'Cu(002)':1.807,'Cu(220)':1.278,'Other':null};
function fillCrystal(selectId,dId){ const s=$(selectId); s.innerHTML=''; for(const k of Object.keys(CRYSTALS)){const o=document.createElement('option');o.value=k;o.textContent=k;s.appendChild(o);} s.value='PG(002)'; s.addEventListener('change',()=>{const d=CRYSTALS[s.value];if(d!=null){$(dId).value=d;$(dId).disabled=true;}else $(dId).disabled=false;}); $(dId).disabled=true; }
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
  setSelect("sense",cfg.sign || qr.sense || inst.sense || "-+-");
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
  return {
    enable:`darkEnable${slot}`, se:`seSelect${suffix}`, ref:`darkRef${suffix}`, rotation:`darkRotation${suffix}`,
    refH:`darkRefH${slot}`, refK:`darkRefK${slot}`, refL:`darkRefL${slot}`, refRow:`darkRefQRow${slot}`,
    from:i=>`darkFrom${suffix}${i}`, to:i=>`darkTo${suffix}${i}`, offset:i=>`darkOffset${suffix}${i}`
  };
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
  const key=$(ids.se).value;
  if(!key || !sampleEnvironments.has(key)){
    setRadio(ids.ref,"Reference Q");
    updateDarkReferenceUI(slot);
    for(let i=0;i<4;i++){
      $(ids.from(i)).value=0; $(ids.to(i)).value=0; $(ids.offset(i)).value=0;
    }
    scheduleRecalc();
    return;
  }
  const se=sampleEnvironments.get(key);
  setRadio(ids.ref,se.dark_angle_reference || "Reference Q");
  const rq=Array.isArray(se.dark_angle_reference_q)?se.dark_angle_reference_q:(Array.isArray(se.reference_q)?se.reference_q:null);
  if(rq&&rq.length>=3){ $(ids.refH).value=rq[0]; $(ids.refK).value=rq[1]; $(ids.refL).value=rq[2]; }
  updateDarkReferenceUI(slot);
  const ranges=Array.isArray(se.dark_angle_ranges)?se.dark_angle_ranges:[];
  for(let i=0;i<4;i++){
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
  $("geometryRow").classList.toggle("hidden",!single);
  $("senseRow").classList.toggle("hidden",!single);
  $("s1minWrap").classList.toggle("hidden",!single);
  $("s1maxWrap").classList.toggle("hidden",!single);
  $("lambdaHalf").closest("label").classList.toggle("hidden",!single);
  $("singleMain").classList.toggle("hidden",!single);
  $("powderMain").classList.toggle("hidden",single);
  $("s2Label").childNodes[0].nodeValue = single ? "S2 min (deg)" : "minimum 2θ (deg)";
}

function latticeParams(){
  return {
    a:num("a"), b:num("b"), c:num("c"),
    alpha:num("alpha"), beta:num("beta"), gamma:num("gamma")
  };
}

function getDarkAssets(){
  const assets=[];
  for(let slot=1;slot<=3;slot++){
    const ids=darkAssetIds(slot);
    if(!$(ids.enable)?.checked) continue;
    const rotation=num(ids.rotation);
    const ranges=[];
    for(let i=0;i<4;i++) ranges.push([num(ids.from(i)),num(ids.to(i)),num(ids.offset(i))+rotation]);
    assets.push({slot,key:$(ids.se)?.value||"",ref:checkedValue(ids.ref)||"Reference Q",refHkl:[num(ids.refH),num(ids.refK),num(ids.refL)],ranges});
  }
  return assets;
}

function calcQ0(s1,s2,ki,kf,s1Offset,refS1,QrefXY,sense){
  const kiAngle=deg2rad(-s1+s1Offset+refS1);
  const kfAngle=deg2rad(s2-s1+s1Offset+refS1);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];
  // The two TAS sign conventions are mirror images about the Reference-Q axis.
  // Keep the motor limits themselves unchanged; only the reciprocal-space
  // handedness changes.  This also reverses the S2-sweep arc direction for a
  // fixed S1, as required physically.
  if(sense==="+-+" && norm(QrefXY)>1e-10){
    const eQ=normalize(QrefXY);
    q=sub(scale(eQ,2*dot(q,eQ)),q);
  }
  return q;
}

function calcQDark(s1,s2,ki,kf,s1Offset,QrefXY,sense,energyMode=null){
  const kiAngle=deg2rad(-s1+s1Offset);
  const kfAngle=deg2rad(s2-s1+s1Offset);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];

  // Keep the already-validated elastic handedness mapping first.  For +-+ this
  // is the existing reflection about Reference Q; -+- uses the raw geometry.
  // Apply exactly the same mapping to the corresponding elastic-Q vector so it
  // can serve as the local angular reference for the inelastic correction.
  const kElastic=energyMode ? ((energyMode==="Ef fixed") ? kf : ki) : null;
  let qElastic=energyMode ? [kElastic*(Math.sin(kiAngle)-Math.sin(kfAngle)),
                             kElastic*(Math.cos(kiAngle)-Math.cos(kfAngle))] : null;

  if(sense==="+-+" && norm(QrefXY)>1e-10){
    const eQ=normalize(QrefXY);
    q=sub(scale(eQ,2*dot(q,eQ)),q);
    if(qElastic) qElastic=sub(scale(eQ,2*dot(qElastic,eQ)),qElastic);
  }

  // The elastic dark regions are correct for both senses.  Away from hw=0 the
  // ki-kf triangle's azimuthal displacement has the opposite sign to the TAS
  // geometry in BOTH senses.  Reflect only that inelastic displacement about
  // the sense-correct elastic-Q direction.  At hw=0 q==qElastic, so this is an
  // exact identity and cannot move the validated elastic boundaries.
  if(qElastic && norm(qElastic)>1e-10){
    const e0=normalize(qElastic);
    q=sub(scale(e0,2*dot(q,e0)),q);
  }
  return q;
}

// Direct-beam dark-angle zero is defined at the sample orientation where
// ki is perpendicular to U.  The orientation calibration itself remains the
// validated Reference-Q pipeline.  Observing the elastic U Bragg peak puts the
// sample theta=S2/2 away from ki-perpendicular-U, so compensate the dark-angle
// rotation by that amount.  The laboratory mirror between +-+ and -+- reverses
// only the sign of this display/range correction.
function directBeamPerpUCorrection(rl,energyMode,Ei,Ef,sense){
  // Bragg-peak-position orientation already carries the original Reference-Q
  // calibration, so no extra S2(U)/2 rebasing is needed there.  The direct-beam
  // correction is only for the ki-perpendicular U/V orientation modes.
  if(($('orientationReference')?.value || 'bragg') === 'bragg') return 0;
  const Uhkl=[num("Uh"),num("Uk"),num("Ul")];
  const qU=norm(hklToQ(rl,Uhkl));
  const E0=energyMode==="Ef fixed"?Ef:Ei;
  if(!(qU>1e-12) || !(E0>0)) return 0;
  const k0=Math.sqrt(E0/2.072);
  const arg=qU/(2*k0);
  if(arg>1+1e-10) return 0;
  const halfS2=rad2deg(Math.asin(clamp(arg,-1,1)));
  return sense==="+-+" ? +halfS2 : -halfS2;
}

function darkReferenceCalibration(asset,rl,ex,ey,energyMode,Ei,Ef){
  // Dark-angle Reference Q uses the original Reference-Q convention: the
  // entered (h,k,l) defines the crystal-space direction about which the
  // accessible dark-angle region is symmetric.  It is NOT a second S1
  // calibration and therefore must not inherit or solve an S1 value from the
  // Orientation reference.  The Bragg-peak-position S1 remains relevant only
  // to the orientation / angle-calculation calibration.
  const qhkl=asset.refHkl||[0,0,0], q=hklToQ(rl,qhkl), qn=norm(q);
  if(qn<=1e-10) return null;
  const qxy=[dot(q,ex),dot(q,ey)];
  const phi=rad2deg(Math.atan2(qxy[1],qxy[0]));
  const wavelength=9.044/Math.sqrt(energyMode==="Ef fixed"?Ef:Ei);
  const arg=wavelength*qn/(4*PI);
  if(arg>1+1e-12) return null;
  const theta=rad2deg(Math.asin(clamp(arg,-1,1)));

  // Reproduce the original Reference-Q Q-E mapping, but using the Dark-angle
  // Reference-Q HKL as its own independent reference.  No Orientation-reference
  // HKL, S1, or orientation offset enters this calibration.
  const s1Offset=-theta+180-phi;
  return {qxy,theta,Qoffset:90+theta,s1Offset};
}

function calculateSingleCrystal(){
  const inst=currentInstrument();
  const lc=latticeParams();
  const latticeCentering=$("latticeCentering").value || "P";
  const U=[num("Uh"),num("Uk"),num("Ul")];
  const V=[num("Vh"),num("Vk"),num("Vl")];
  const rl=RL_calc({...lc,sv1:U,sv2:V});
  // Keep the same UB construction as the Python implementation, even though
  // plotting below uses the explicit scattering-plane basis.
  UB_calc({...lc,sv1:U,sv2:V},rl);
  const {ex,ey,ez}=makeSpiceScatteringPlaneBasis(rl,U,V);

  const energyMode=checkedValue("energyMode");
  const lambdaHalf=$("lambdaHalf").checked;
  const energyInput=num("energy");
  let Ei,Ef;
  if(energyMode==="Ef fixed") Ef=lambdaHalf?4*energyInput:energyInput;
  else Ei=lambdaHalf?4*energyInput:energyInput;

  const fixedReferenceEnergy=(energyMode==="Ef fixed"?Ef:Ei);
  const orientationRef=effectiveOrientationReference(rl,fixedReferenceEnergy);
  const ref=orientationRef.hkl;
  const refS1=orientationRef.s1;
  const Qref=hklToQ(rl,ref);
  const QrefNorm=norm(Qref);
  const QrefXY=[dot(Qref,ex),dot(Qref,ey)];
  const phiRef=QrefNorm>1e-10?rad2deg(Math.atan2(QrefXY[1],QrefXY[0])):0;
  const wavelength=9.044/Math.sqrt(energyMode==="Ef fixed"?Ef:Ei);
  let thetaRef=0;
  if(QrefNorm>1e-10){
    const dRef=2*PI/QrefNorm;
    const arg=wavelength/(2*dRef);
    if(arg>1+1e-12) throw new Error("Reference Q is not accessible at the selected reference energy.");
    thetaRef=rad2deg(Math.asin(clamp(arg,-1,1)));
  }
  const darkAssets=getDarkAssets();
  // Each enabled asset keeps its own reference convention. Existing single-asset
  // formulas are reused independently, then their blocked regions are overlaid.
  const s1Offset=-thetaRef+180-phiRef;

  const S2min=num("S2min"), S1min=num("S1min"), S1max=num("S1max");
  const interp=instrumentInterp(inst,lambdaHalf);
  let hwList;
  if(lambdaHalf) hwList=[0];
  else if(energyMode==="Ef fixed"){
    const EiMax=maxArray(rangeTable(inst).map(x=>Number(x.Ei)));
    hwList=arange(0,EiMax-Ef,0.1);
  } else {
    hwList=arange(0,Ei,0.1);
  }
  if(hwList.length===0) hwList=[0];

  const regions=[], S2list=[], QmaxList=[];
  const darkKF=[],darkKI=[],darkFixed=[];
  const addDark=$("addDark").checked && darkAssets.length>0;
  const sense=checkedValue("sense");

  for(const hw of hwList){
    let EiHw,EfHw;
    if(energyMode==="Ef fixed"){ EiHw=Ef+hw; EfHw=Ef; }
    else { EiHw=Ei; EfHw=Ei-hw; }
    if(EiHw<=0 || EfHw<=0) continue;
    const ki=0.6947*Math.sqrt(EiHw), kf=0.6947*Math.sqrt(EfHw);
    const S2max=Number(interp(EiHw));

    // S1min/S1max are motor limits and remain the same for both senses.
    // The sign convention changes the reciprocal-space handedness, not the
    // numerical motor interval.  calcQ0() applies that mirror about Reference Q.
    const s1range=linspace(S1min,S1max,200);
    const s2range=linspace(S2min,S2max,200);

    const p1=s1range.map(s1=>calcQ0(s1,S2min,ki,kf,s1Offset,refS1,QrefXY,sense));
    const p2=s2range.map(s2=>calcQ0(S1max,s2,ki,kf,s1Offset,refS1,QrefXY,sense));
    const p3=[...s1range].reverse().map(s1=>calcQ0(s1,S2max,ki,kf,s1Offset,refS1,QrefXY,sense));
    const p4=[...s2range].reverse().map(s2=>calcQ0(S1min,s2,ki,kf,s1Offset,refS1,QrefXY,sense));
    const boundary=[...p1,...p2,...p3,...p4];
    regions.push(boundary); S2list.push(S2max);
    QmaxList.push(Math.max(...boundary.map(norm)));

    const hwKF=[],hwKI=[],hwFixed=[];
    if(addDark){
      for(const asset of darkAssets){
        const darkRef=asset.ref;
        const darkCal=darkRef==="Reference Q" ? darkReferenceCalibration(asset,rl,ex,ey,energyMode,Ei,Ef) : null;
        if(darkRef==="Reference Q" && !darkCal) continue;
        if(darkRef!=="Fixed" && darkRef!=="Reference Q" && QrefNorm<=1e-10) continue;
        const Qoffset=darkRef==="Reference Q" ? darkCal.Qoffset : 2*thetaRef;
        if(darkRef==="Fixed"){
          // Laboratory-fixed obstacle: compare the SIGNED physical S2 motor angle
          // directly with the fixed angular interval.  Do not use abs(S2): a
          // stopper at +30 deg must not block a -30 deg scattering arm (and vice
          // versa).  The Q-E simulation currently scans the physical S2 branch
          // from S2min to S2max, so a fixed interval on the unused negative branch
          // naturally produces no blocked region.
          for(const rawRange of asset.ranges){
            let [from,to,offset]=rawRange;
            if(from===0 && to===0) continue;
            let a=offset+from, b=offset+to;
            if(b<a) b+=360;

            // Treat the fixed direction periodically, but intersect only with the
            // actually scanned signed S2 interval.  This also handles ranges that
            // cross 0 deg without mirroring the negative side onto the positive side.
            // A laboratory-fixed obstacle can intercept either the outgoing kf
            // arm or the incident ki beam.  The fixed-angle drawing uses the
            // sample as the origin: rotation = 0 deg points along the direct
            // (outgoing) beam, while the incident ki source direction is the
            // opposite ray, 180 deg.  Therefore a range around 0 deg is handled
            // below as an ordinary kf/S2 block; only a range containing 180 deg
            // (modulo 360 deg) blocks ki and makes every Q geometry inaccessible.
            const blocksKi=[-360,0,360].some(shift=>{
              const aa=a+shift, bb=b+shift;
              return aa<=180 && 180<=bb;
            });
            if(blocksKi){
              hwFixed.push(boundary.slice());
              continue;
            }

            // Otherwise the obstacle only blocks the outgoing kf arm.  Intersect
            // its signed angular interval with the actually scanned S2 range.
            for(const shift of [-360,0,360]){
              const lo=Math.max(a+shift,S2min);
              const hi=Math.min(b+shift,S2max);
              if(!(hi>lo)) continue;
              const qRadius=s2=>Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(deg2rad(s2))));
              const r0=qRadius(lo), r1=qRadius(hi), aa=linspace(0,2*Math.PI,241);
              hwFixed.push([...aa.map(t=>[r1*Math.cos(t),r1*Math.sin(t)]),...[...aa].reverse().map(t=>[r0*Math.cos(t),r0*Math.sin(t)])]);
            }
          }
          continue;
        }
        const s2dark=linspace(S2min,S2max,200);
        for(const rawRange of asset.ranges){
          const [from,to,offset]=rawRange; if(from===0 && to===0) continue;
          const directBeamCorrection=darkRef==="Direct beam"
            ? directBeamPerpUCorrection(rl,energyMode,Ei,Ef,sense) : 0;
          const correctedOffset=offset+directBeamCorrection;
          const s1from=correctedOffset+from-Qoffset, s1to=correctedOffset+to-Qoffset;

          // Reference-Q dark angles use exactly the old Reference-Q Q-E mapping,
          // rebased on the HKL entered in this dark-angle slot.  In particular,
          // Orientation reference (including Bragg-position S1) is deliberately
          // excluded.  Direct-beam keeps the existing orientation-based mapping.
          const darkS1Offset=darkRef==="Reference Q" ? darkCal.s1Offset : s1Offset;
          const darkQrefXY=darkRef==="Reference Q" ? darkCal.qxy : QrefXY;
          const fromKF=s2dark.map(s2=>calcQDark(s1from,s2,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
          const toKF=s2dark.map(s2=>calcQDark(s1to,s2,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
          const topKF=linspace(s1from,s1to,100).map(s1=>calcQDark(s1,S2max,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
          const bottomKF=linspace(s1to,s1from,100).map(s1=>calcQDark(s1,S2min,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
          hwKF.push([...fromKF,...topKF,...[...toKF].reverse(),...bottomKF]);
          const kiShift=s2=>(180-s2);
          const fromKI=s2dark.map(s2=>calcQDark(s1from-kiShift(s2),s2,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
          const toKI=s2dark.map(s2=>calcQDark(s1to-kiShift(s2),s2,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
          const topKI=linspace(s1from-kiShift(S2max),s1to-kiShift(S2max),100).map(s1=>calcQDark(s1,S2max,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
          const bottomKI=linspace(s1to-kiShift(S2min),s1from-kiShift(S2min),100).map(s1=>calcQDark(s1,S2min,ki,kf,darkS1Offset,darkQrefXY,sense,energyMode));
          hwKI.push([...fromKI,...topKI,...[...toKI].reverse(),...bottomKI]);
        }
      }
    }
    darkKF.push(hwKF); darkKI.push(hwKI); darkFixed.push(hwFixed);
  }

  if(regions.length===0) throw new Error("No accessible energy-transfer points were generated.");

  // Generate Bragg peaks over the same radial range shown by the Single Crystal plot.
  // Using QmaxList[0] here made the index search depend on the first energy point
  // and could truncate one reciprocal-space direction.  Search out to 1.2 times
  // the instrument's maximum reachable Q over the full calculated energy range.
  const instrumentQmax=Math.max(...QmaxList);
  const QplotLattice=1.2*instrumentQmax;
  const Uq=hklToQ(rl,U), Vq=hklToQ(rl,V);
  const Ulen=norm(Uq), Vlen=norm(Vq);
  const Mmax=Math.ceil(QplotLattice/Ulen)+2, Nmax=Math.ceil(QplotLattice/Vlen)+2;
  const Gpoints=[], magPoints=[];
  // Magnetic satellites are observable in this 2D TAS view only when their
  // propagation vector itself lies in the selected scattering plane.
  const propagationVectors=enabledPropagationVectors().filter(q=>{
    const qCart=hklToQ(rl,q.hkl);
    const scaleQ=Math.max(norm(qCart),1);
    return Math.abs(dot(qCart,ez)) <= 1e-8*scaleQ;
  });

  for(let m=-Mmax;m<=Mmax;m++){
    for(let n=-Nmax;n<=Nmax;n++){
      const hkl=add(scale(U,m),scale(V,n));
      const G=hklToQ(rl,hkl);

      if(norm(G)>QplotLattice) continue;
      if(!isAllowedByCentering(hkl,latticeCentering)) continue;

      const h = Math.round(hkl[0]);
      const k = Math.round(hkl[1]);
      const l = Math.round(hkl[2]);

      Gpoints.push({x:dot(G,ex),y:dot(G,ey),label:(h===0&&k===0&&l===0)?"":`(${formatHKL(hkl)})`});

      for(const q of propagationVectors){
        const kvec=q.hkl;
        for(const s of [1,-1]){
          const hm=add(hkl,scale(kvec,s));
          const Gm=hklToQ(rl,hm);

          if(norm(Gm)<=QplotLattice){
            magPoints.push({
              x:dot(Gm,ex),
              y:dot(Gm,ey),
              qIndex:q.index,
              label:`k${q.index}: (${hm.map(x=>x.toFixed(2)).join(",")})`
            });
          }
        }
      }
    }
  }

  const ringData=[];
  const qlimit=Math.max(...QmaxList);
  for(const bg of selectedBackgrounds()){
    const sample=samples.get(bg.key);
    const peaks=Array.isArray(sample.peaks)?sample.peaks:[];
    const maxI=peaks.length?Math.max(...peaks.map(p=>Number(p.intensity)||0)):0;
    for(const p of peaks){
      const q=2*PI/Number(p.d);
      if(!Number.isFinite(q) || q>qlimit) continue;
      const phi=linspace(0,2*PI,361);
      const ratio=maxI>0?(Number(p.intensity)||0)/maxI:0;
      ringData.push({
        x:phi.map(t=>q*Math.cos(t)), y:phi.map(t=>q*Math.sin(t)),
        color:backgroundColor(bg.slot,0.20+0.75*ratio),
        hover:`BG${bg.index+1}: ${sample.name||bg.key} (${p.h}${p.k}${p.l})<br>Q = ${q.toFixed(3)} Å⁻¹<br>I = ${Number(p.intensity).toFixed(1)}`
      });
    }
  }

  return {
    inst,lc,latticeCentering,U,V,rl,ex,ey,ez,
    energyMode,Ei,Ef,lambdaHalf,hwList,
    regions,S2list,QmaxList,darkKF,darkKI,darkFixed,addDark,
    Gpoints,magPoints,ringData,darkAssets,QrefXY,sense
  };
}

function singleMarkerSizes(fullSpan,visibleSpan,peakCount){
  // Keep dense thermal maps readable at the full view, then grow markers smoothly
  // as the user zooms in. Sizes remain bounded so neither view becomes extreme.
  const density=Math.max(0.50,Math.min(1,Math.sqrt(90/Math.max(90,peakCount||0))));
  const zoom=Math.max(1,Math.sqrt(Math.max(1,fullSpan/Math.max(visibleSpan,1e-9))));
  const scale=Math.min(1.55,density*zoom);
  return {nuclear:Math.max(2.5,6*scale),magnetic:Math.max(3.0,7*scale),star:Math.max(3.5,9*scale)};
}

function singleNuclearLabelStyle(fullSpan,visibleSpan){
  // Scale both font size and marker-to-label clearance with zoom.  A fixed
  // fraction of the visible Q span looks progressively tighter in screen pixels
  // once the text/markers grow, so increase that fraction as we zoom in.
  const span=Math.min(fullSpan,Math.max(1e-9,Number(visibleSpan)||fullSpan));
  const zoom=Math.max(1,fullSpan/span);
  const logZoom=Math.max(0,Math.log2(zoom));
  const fontSize=Math.min(16,8+2.5*logZoom);
  const offsetFraction=Math.min(0.055,0.022+0.006*logZoom);
  const offset=Math.max(span*offsetFraction,fullSpan*0.0015);
  return {offset,fontSize};
}

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
    const pts=cache.Gpoints.filter(p=>p.label!=="");
    Plotly.restyle(gd,{
      x:[pts.map(p=>p.x)],
      y:[pts.map(p=>p.y+style.offset)],
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
      const xr=gd?._fullLayout?.xaxis?.range, yr=gd?._fullLayout?.yaxis?.range;
      if(Array.isArray(xr)&&xr.length===2&&xr.every(Number.isFinite)) applyOffset(Math.abs(xr[1]-xr[0]));
      else if(Array.isArray(yr)&&yr.length===2&&yr.every(Number.isFinite)) applyOffset(Math.abs(yr[1]-yr[0]));
      else applyOffset(fullSpan);
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
      else if(/^Magnetic Bragg peaks: k[123]$/.test(tr.name||"")){
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

function renderSingle(cache,index=0){
  const keptView=currentPlotRanges("singlePlot");
  const i=Math.max(0,Math.min(index,cache.regions.length-1));
  const boundary=cache.regions[i];
  const qMax = Math.max(
    ...cache.Gpoints.map(p => Math.hypot(p.x, p.y))
  );

  const s2Min = num("S2min");
  const s2Max = cache.S2list[i];
  const Qplot=1.2*Math.max(...cache.QmaxList);
  const initialMarkerSizes=singleMarkerSizes(2*Qplot,2*Qplot,cache.Gpoints.length+cache.magPoints.length);

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
      x:cache.Gpoints.map(p=>p.x),
      y:cache.Gpoints.map(p=>p.y),
      mode:"markers",
      name:"Nuclear Bragg peaks",
      marker:{color:"black",size:initialMarkerSizes.nuclear},
      hovertext:cache.Gpoints.map(p=>p.label),
      hovertemplate:"%{hovertext}<extra></extra>"
    },
  ];
  if($("displayNuclearLabels")?.checked){
    const labelPts=cache.Gpoints.filter(p=>p.label!=="");
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
      meta:"nuclear-labels"
    });
  }
  // Keep k1/k2/k3 visually distinct while retaining one magnetic-peak color.
  const magneticSymbols={1:"circle",2:"x",3:"star"};
  for(let qIndex=1;qIndex<=3;qIndex++){
    const pts=cache.magPoints.filter(p=>p.qIndex===qIndex);
    if(!pts.length) continue;
    traces.push({
      x:pts.map(p=>p.x),y:pts.map(p=>p.y),mode:"markers",name:`Magnetic Bragg peaks: k${qIndex}`,
      marker:{color:"red",size:qIndex===3?initialMarkerSizes.star:initialMarkerSizes.magnetic,symbol:magneticSymbols[qIndex]},
      hovertext:pts.map(p=>p.label),hovertemplate:"%{hovertext}<extra></extra>"
    });
  }
  const selectedS2=syncSingleNavigation(cache,i);
  const selectedQ=selectedQAtS2(cache,i,selectedS2);
  if(Number.isFinite(selectedQ)){
    const phi=linspace(0,2*PI,361);
    traces.push({x:phi.map(t=>selectedQ*Math.cos(t)),y:phi.map(t=>selectedQ*Math.sin(t)),mode:"lines",name:`S2 = ${selectedS2.toFixed(1)}°`,line:{color:"black",width:1.2,dash:"solid"},hovertemplate:`S2 = ${selectedS2.toFixed(1)}°<br>Q = ${selectedQ.toFixed(3)} Å⁻¹<extra></extra>`});
  }
  for(const ring of cache.ringData){
    traces.push({
      x:ring.x,y:ring.y,mode:"lines",showlegend:false,
      line:{color:ring.color,width:1.5},hovertemplate:ring.hover+"<extra></extra>"
    });
  }
  // Match the Powder view: show one legend entry for each selected BG slot
  // without duplicating a legend item for every individual powder ring.
  for(const bg of selectedBackgrounds()){
    const sample=samples.get(bg.key);
    traces.push({
      x:[null],y:[null],mode:"lines",
      name:`BG${bg.index+1}: ${sample.name||bg.key}`,
      line:{color:backgroundColor(bg.slot,1),width:1.5},
      hoverinfo:"skip",showlegend:true
    });
  }
  if(cache.addDark){
    let fixedLegend=false, kfLegend=false, kiLegend=false;
    for(const r of (cache.darkKI[i]||[])){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (ki side)",showlegend:!kiLegend,legendgroup:"dark-ki",mode:"lines",line:{width:0},fillcolor:"rgba(0,255,0,0.15)"});
      kiLegend=true;
    }
    for(const r of (cache.darkKF[i]||[])){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (kf side)",showlegend:!kfLegend,legendgroup:"dark-kf",mode:"lines",line:{width:0},fillcolor:"rgba(80,190,255,0.25)"});
      kfLegend=true;
    }
    for(const r of (cache.darkFixed[i]||[])){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (fixed)",showlegend:!fixedLegend,legendgroup:"dark-fixed",mode:"lines",line:{width:0},fillcolor:"rgba(0,0,255,0.15)",hoverinfo:"skip"});
      fixedLegend=true;
    }
  }

  const energyText=cache.energyMode==="Ef fixed"?`Ef=${cache.Ef.toFixed(2)} meV`:`Ei=${cache.Ei.toFixed(2)} meV`;
  const lam=cache.lambdaHalf?" | λ/2":"";
  const title=`${cache.inst.name||"Instrument"} | ${energyText}${lam}<br>`+
    `a=${cache.lc.a.toFixed(3)}, b=${cache.lc.b.toFixed(3)}, c=${cache.lc.c.toFixed(3)} Å<br>`+
    `α=${cache.lc.alpha.toFixed(1)}, β=${cache.lc.beta.toFixed(1)}, γ=${cache.lc.gamma.toFixed(1)}° | `+
    `Centering: ${cache.latticeCentering} | Plane: (${cache.U.join(",")})-(${cache.V.join(",")})`;

  Plotly.react("singlePlot",traces,{
    // Preserve user zoom/pan when controls trigger a recalculation.
    uirevision:"singlePlot",
    title:{text:title,x:0.5,xanchor:"center",font:{size:14}},
    xaxis:{title:"Qx (Å⁻¹)",range:keptView.x||[-Qplot,Qplot],tickmode:"auto",nticks:10,showgrid:true,gridcolor:"lightgray",zeroline:true,constrain:"domain"},
    // Keep the reciprocal-space plotting box square: identical numerical Qx/Qy
    // ranges and a 1:1 data-unit aspect ratio.  `constrain: domain` makes Plotly
    // shrink the axis domain rather than silently expanding one numerical range.
    yaxis:{title:"Qy (Å⁻¹)",range:keptView.y||[-Qplot,Qplot],tickmode:"auto",nticks:10,showgrid:true,gridcolor:"lightgray",zeroline:true,scaleanchor:"x",scaleratio:1,constrain:"domain"},
    // UI-only spacing: reclaim a little space above the plot, while reserving
    // more room below so the x-axis title and horizontal legend do not crowd.
    margin:{l:60,r:20,t:92,b:96},
    legend:{orientation:"h",x:0.5,xanchor:"center",y:-0.16,yanchor:"top"}
  },{responsive:true});
  bindSingleZoomMarkerScaling(cache,Qplot);
  bindSingleZoomLabelScaling(cache,Qplot);

  $("hwValue").textContent=`${cache.hwList[i].toFixed(1)} meV`;
  renderGeometry(cache,i);
}

function qeGeometryAngles(cache, senseOverride=null){
  const calc={h:num("geomH"),k:num("geomK"),l:num("geomL"),hw:num("geomHW")};
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
  b.config.sign_config=senseOverride ?? cache.sense;
  const angles=tasMotorAngles(calc,b);
  const Ei=cache.energyMode==="Ei fixed" ? cache.Ei : cache.Ef+calc.hw;
  const Ef=cache.energyMode==="Ei fixed" ? cache.Ei-calc.hw : cache.Ef;
  return {calc,angles,Ei,Ef,ki:Math.sqrt(Ei/2.072),kf:Math.sqrt(Ef/2.072)};
}

function renderGeometry(cache,index=0){
  const i=Math.max(0,Math.min(index,cache.hwList.length-1));
  const sense=cache.sense || checkedValue("sense");
  const hw=cache.hwList[i] || 0;
  const mirror=sense==="+-+" ? 1 : -1;

  // Default explanatory geometry is retained when the requested target cannot
  // be solved.  A valid h,k,l,hw target switches the drawing to calculated TAS
  // motor angles while keeping all flight-leg lengths equal for readability.
  let target=null;
  let targetError="";
  try{ target=qeGeometryAngles(cache); }
  catch(err){ targetError=err?.message || String(err); }

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
    const drawTarget=(sense==="+-+") ? target : qeGeometryAngles(cache,"+-+");
    const {angles,ki,kf}=drawTarget;
    source=[-L,0];
    mono=[0,0];
    thetaKi=deg2rad(angles.m2);
    sample=[mono[0]+L*Math.cos(thetaKi),mono[1]+L*Math.sin(thetaKi)];
    thetaKf=thetaKi+deg2rad(angles.s2);
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

  // Display-only transform: rotate the complete TAS schematic 90 degrees
  // counterclockwise.  Motor angles and all physical calculations above remain
  // untouched; only the coordinates/angles used for drawing are transformed.
  const rotateCCW90=([x,y])=>[y,-x];
  source=rotateCCW90(source);
  mono=rotateCCW90(mono);
  sample=rotateCCW90(sample);
  analyzer=rotateCCW90(analyzer);
  detector=rotateCCW90(detector);
  // rotateCCW90() above maps [x,y] -> [y,-x], i.e. a 90° clockwise
  // screen transform. Rotate all direction angles by the SAME amount so ki/kf/Q
  // arrows remain aligned with their flight paths. This is display-only.
  thetaKi-=Math.PI/2;
  thetaKf-=Math.PI/2;
  thetaOut-=Math.PI/2;
  monoPlaneAngle-=Math.PI/2;
  anaPlaneAngle-=Math.PI/2;
  qAngle-=Math.PI/2;

  const traces=[];
  const addLine=(a,b,color,width=3,dash="solid")=>traces.push({x:[a[0],b[0]],y:[a[1],b[1]],mode:"lines",line:{color,width,dash},hoverinfo:"skip",showlegend:false});
  const flightColor="#cfcfcf";
  addLine(source,mono,flightColor,4); addLine(mono,sample,flightColor,4); addLine(sample,analyzer,flightColor,4); addLine(analyzer,detector,flightColor,4);

  // Fixed, compact display radius: independent of instrument/angle auto-scaling.
  // The guide circle belongs to the dark-angle overlay, so hide it together
  // with the dark-angle sectors when the left-panel "show" checkbox is off.
  const showDarkGeometry=Boolean($("addDark")?.checked);
  const darkRadius=1.0;
  if(showDarkGeometry){
    const circle=linspace(0,2*Math.PI,181);
    traces.push({x:circle.map(t=>sample[0]+darkRadius*Math.cos(t)),y:circle.map(t=>sample[1]+darkRadius*Math.sin(t)),mode:"lines",line:{color:"#d9d9d9",width:1},hoverinfo:"skip",showlegend:false});
  }

  // Draw every enabled dark-angle asset independently. Reference-Q assets
  // rotate with the sample about Q; Direct-beam assets use the ki direction at
  // the Reference-Q condition; Fixed assets remain laboratory-fixed.
  let referenceBase=qAngle, deltaS1=0;
  if(target){
    try{
      const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
      const {ex,ey}=makeSpiceScatteringPlaneBasis(cache.rl,U,V);
      const qPlaneAngle=hkl=>{const q=hklToQ(cache.rl,hkl),x=dot(q,ex),y=dot(q,ey);return Math.hypot(x,y)<1e-12?0:Math.atan2(y,x);};
      const phiTarget=qPlaneAngle([target.calc.h,target.calc.k,target.calc.l]);
      const effectiveRef=effectiveOrientationReference(cache.rl,(cache.energyMode==="Ei fixed")?cache.Ei:cache.Ef);
      const phiRef=qPlaneAngle(effectiveRef.hkl);
      const crystalDelta=phiRef-phiTarget;
      referenceBase=qAngle+(sense==="-+-" ? -crystalDelta : crystalDelta);
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
        base=qAngle+(sense==="-+-" ? -crystalDelta : crystalDelta);
      }catch(_err){}
    }else if(asset.ref==="Direct beam"){
      try{
        const effectiveRef=effectiveOrientationReference(cache.rl,(cache.energyMode==="Ei fixed")?cache.Ei:cache.Ef);
        const qRef=hklToQ(cache.rl,effectiveRef.hkl);
        const qRefNorm=norm(qRef), refEnergy=(cache.energyMode==="Ei fixed")?cache.Ei:cache.Ef;
        if(qRefNorm>1e-12&&Number.isFinite(refEnergy)&&refEnergy>0){
          const kRef=Math.sqrt(refEnergy/2.072), thetaRef=Math.asin(clamp(qRefNorm/(2*kRef),-1,1));
          const qToKi=Math.PI/2-thetaRef; base+=-qToKi;
          darkReferenceOffset=(sense==="+-+"?-1:+1)*rad2deg(qToKi);
        }
      }catch(_err){}
    }else if(asset.ref==="Fixed"){
      base=thetaKi; darkReferenceOffset=0;
    }
    asset.ranges.forEach((r,j)=>{
      const [from,to,offset]=r; if(from===0&&to===0) return;
      const directBeamCorrection=asset.ref==="Direct beam"
        ? directBeamPerpUCorrection(cache.rl,cache.energyMode,cache.Ei,cache.Ef,sense) : 0;
      let a0=offset+from+directBeamCorrection,a1=offset+to+directBeamCorrection; if(a1<a0)a1+=360;
      const aa=linspace(a0,a1,120).map(d=>base-deg2rad(d));
      traces.push({x:aa.map(t=>sample[0]+darkRadius*Math.cos(t)),y:aa.map(t=>sample[1]+darkRadius*Math.sin(t)),mode:"lines",line:{color:"red",width:4},name:`Dark ${asset.slot}-${j+1}`,hovertemplate:`Dark angle ${asset.slot}-${j+1}<br>Reference=${asset.ref}<br>ΔS1=${deltaS1.toFixed(2)}°<br>Ref offset=${darkReferenceOffset.toFixed(2)}°<extra></extra>`,showlegend:false});
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

  // Display-only crystallographic U/V guides. Numerical TAS calculations are unchanged.
  let uArrowAngle=qAngle, vArrowAngle=qAngle;
  try{
    const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
    const {ex,ey}=makeSpiceScatteringPlaneBasis(cache.rl,U,V);
    const planePhi=hkl=>{const q=hklToQ(cache.rl,hkl),x=dot(q,ex),y=dot(q,ey);return Math.atan2(y,x);};
    const targetHKL=target ? [target.calc.h,target.calc.k,target.calc.l] : U;
    const phiT=planePhi(targetHKL), phiU=planePhi(U), phiV=planePhi(V);
    uArrowAngle=qAngle+(phiU-phiT);
    vArrowAngle=qAngle+(phiV-phiT);

    // DISPLAY ONLY: the -+- TAS drawing is a left/right mirror of the canonical
    // +-+ instrument geometry, while the crystallographic U/V frame itself must
    // keep the same handed relationship.  Do not touch UB, HKL, S1/S2, Q, or any
    // numerical calculation here.  Instead, for the two ki-perpendicular
    // orientation modes, keep the selected reference axis fixed and reflect only
    // the other crystallographic guide about it.  This works for arbitrary U-V
    // angles (including hexagonal planes), unlike a hard-coded V -> -V operation.
    if(sense==="-+-") {
      const orientationMode=$("orientationReference")?.value || "perpU";
      if(orientationMode==="perpU") {
        // U is the reference: put V on the right-handed side of U.
        vArrowAngle=2*uArrowAngle-vArrowAngle;
      } else if(orientationMode==="perpV") {
        // V is the reference: put U on the right-handed side of V.
        uArrowAngle=2*vArrowAngle-uArrowAngle;
      }
    }
  }catch(_err){}
  const uvAxisLen=darkRadius; // U/V guide length equals the guide-circle diameter (2 * darkRadius).
  const axisEnds=ang=>({
    neg:[sample[0]-uvAxisLen*Math.cos(ang),sample[1]-uvAxisLen*Math.sin(ang)],
    pos:[sample[0]+uvAxisLen*Math.cos(ang),sample[1]+uvAxisLen*Math.sin(ang)]
  });
  const uAxis=axisEnds(uArrowAngle), vAxis=axisEnds(vArrowAngle);
  const uColor="#58c7e8", vColor="#e6a23c";
  // Draw the crystallographic axes as two straight lines crossing the guide circle.
  // They are traces (not annotations), so ki/kf/Q arrows remain visually on top.
  addLine(uAxis.neg,uAxis.pos,uColor,2.2);
  addLine(vAxis.neg,vAxis.pos,vColor,2.2);

  // Component-label placement only; the TAS geometry/calculation is untouched.
  // Place Monochromator and Analyzer labels beside their components rather than
  // directly underneath them. Put the Sample label farther outside the guide
  // circle on the side opposite to Q so the text does not overlap the circle.
  // Display Monochromator label on the requested screen side.
  // The x-axis is reversed for -+-, so the same data-space x offset appears
  // on the right for -+- and on the left for +-+.
  const monoLabel=[mono[0]-1.15,mono[1]];
  const anaLabel=[analyzer[0]-1.05,analyzer[1]];
  const sampleLabelRadius=1.55;
  const sampleLabel=[
    sample[0]-sampleLabelRadius*Math.cos(qAngle),
    sample[1]-sampleLabelRadius*Math.sin(qAngle)
  ];
  const detLabel=[detector[0],detector[1]-0.58];
  const kiMid=pointAlong(kiArrow.tail,kiArrow.head,.5),kfMid=pointAlong(kfArrow.tail,kfArrow.head,.5);

  const annotations=[
    {x:uAxis.pos[0]+0.14*Math.cos(uArrowAngle),y:uAxis.pos[1]+0.14*Math.sin(uArrowAngle),text:"U",showarrow:false,font:{color:uColor,size:14}},
    {x:vAxis.pos[0]+0.14*Math.cos(vArrowAngle),y:vAxis.pos[1]+0.14*Math.sin(vArrowAngle),text:"V",showarrow:false,font:{color:vColor,size:14}},
    {x:monoLabel[0],y:monoLabel[1],text:"Monochromator",showarrow:false},
    {x:sampleLabel[0],y:sampleLabel[1],text:"Sample",showarrow:false},
    {x:anaLabel[0],y:anaLabel[1],text:"Analyzer",showarrow:false},
    {x:detLabel[0],y:detLabel[1],text:"Detector",showarrow:false},
    {x:kiArrow.head[0],y:kiArrow.head[1],ax:kiArrow.tail[0],ay:kiArrow.tail[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.8,arrowcolor:"#2e9b50"},
    {x:kfArrow.head[0],y:kfArrow.head[1],ax:kfArrow.tail[0],ay:kfArrow.tail[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.8,arrowcolor:"#7b2cbf"},
    {x:kiMid[0]-0.18*Math.sin(thetaKi),y:kiMid[1]+0.18*Math.cos(thetaKi),text:"ki",showarrow:false,font:{color:"#2e9b50"}},
    {x:kfMid[0]+0.18*Math.sin(thetaKf),y:kfMid[1]-0.18*Math.cos(thetaKf),text:"kf",showarrow:false,font:{color:"#7b2cbf"}},
    {x:qEnd[0],y:qEnd[1],ax:sample[0],ay:sample[1],xref:"x",yref:"y",axref:"x",ayref:"y",text:"",showarrow:true,arrowhead:3,arrowsize:1.1,arrowwidth:2.8,arrowcolor:"#000"},
    {x:qEnd[0]+.12*Math.cos(qAngle),y:qEnd[1]+.12*Math.sin(qAngle),text:"Q",showarrow:false,font:{color:"#000"}}
  ];

  // Fixed display viewport.  Do not auto-fit the current angles: auto-fitting made
  // identical schematic flight lengths appear different for different instruments.
  // With the viewport tied only to L, Source-Mono, Mono-Sample, Sample-Analyzer
  // (0.75 L), and Analyzer-Detector (0.5 L) keep constant on-screen lengths.
  const span=4.32*L;
  const cx=mono[0];
  const cy=mono[1]-0.60*L;

  const angleBox=$("geometryAngles");
  if(angleBox){
    if(target){
      const a=target.angles;
      angleBox.classList.remove("error-text");
      angleBox.innerHTML=`Ei=${target.Ei.toFixed(3)} meV, Ef=${target.Ef.toFixed(3)} meV &nbsp; | &nbsp; `+
        `M1=${formatAngle(-a.m1)}°, M2=${formatAngle(-a.m2)}°, S1=${formatAngle(a.s1)}°, S2=${formatAngle(a.s2)}°, A1=${formatAngle(-a.a1)}°, A2=${formatAngle(-a.a2)}°`+
        (a.warning?`<br>${a.warning}`:"");
    }else{
      angleBox.classList.add("error-text"); angleBox.textContent=`Angle calculation unavailable: ${targetError}`;
    }
  }

  Plotly.react("geometryPlot",traces,{
    xaxis:{range:sense==="+-+" ? [cx-span/2,cx+span/2] : [cx+span/2,cx-span/2],showgrid:false,zeroline:false,showticklabels:false,fixedrange:true},
    yaxis:{range:[cy-span/2,cy+span/2],showgrid:false,zeroline:false,showticklabels:false,scaleanchor:"x",scaleratio:1,fixedrange:true},
    annotations,margin:{l:10,r:10,t:12,b:10},showlegend:false
  },{responsive:true,displayModeBar:false});
}

function calculatePowder(){
  const inst=currentInstrument();
  const lc=latticeParams();
  const rv=reciprocalVectors(lc.a,lc.b,lc.c,lc.alpha,lc.beta,lc.gamma);
  const al=norm(rv.astar), bl=norm(rv.bstar), cl=norm(rv.cstar);
  const interp=instrumentInterp(inst,false);
  const energyMode=checkedValue("energyMode");
  const E=num("energy"), S2min=num("S2min");
  const qmin=[],qmax=[],hw=[];
  let fixedE=E;

  if(energyMode==="Ef fixed"){
    const Ef=E;
    const EiMax=Math.max(...rangeTable(inst).map(x=>Number(x.Ei)));
    for(const Ei of arange(Ef+0.01,EiMax,0.1)){
      const s2max=interp(Ei), ki=0.6947*Math.sqrt(Ei), kf=0.6947*Math.sqrt(Ef);
      const tmin=deg2rad(S2min),tmax=deg2rad(s2max);
      qmin.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmin)));
      qmax.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmax)));
      hw.push(Ei-Ef);
    }
  } else {
    const Ei=E;
    const s2max=interp(Ei),ki=0.6947*Math.sqrt(Ei);
    for(const w of arange(0,Ei-0.01,0.1)){
      const Ef=Ei-w;
      if(Ef<=0) continue;
      const kf=0.6947*Math.sqrt(Ef),tmin=deg2rad(S2min),tmax=deg2rad(s2max);
      qmin.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmin)));
      qmax.push(Math.sqrt(ki*ki+kf*kf-2*ki*kf*Math.cos(tmax)));
      hw.push(w);
    }
  }
  if(!qmax.length) throw new Error("No accessible powder range was generated.");

  const traces=[{
    x:[...qmin,...[...qmax].reverse()],
    y:[...hw,...[...hw].reverse()],
    fill:"toself",fillcolor:"rgba(255,215,0,0.20)",
    line:{width:0},name:"Accessible QE range"
  }];
  const shapes=[],annotations=[];
  const Qlim=Math.max(...qmax), hwmax=Math.max(...hw);
  [[al,"red","a*"],[bl,"blue","b*"],[cl,"green","c*"]].forEach(([base,color,label])=>{
    for(let n=1;n<20;n++){
      const q=n*base;
      if(q>Qlim) break;
      shapes.push({type:"line",x0:q,x1:q,y0:0,y1:1,yref:"paper",line:{color,dash:"dot",width:2}});
      annotations.push({x:q,y:hwmax,text:`${n}${label}`,showarrow:false,xshift:15,yshift:20,font:{color}});
    }
  });

  const powderMagStyles={1:{dash:"dash",symbol:"circle"},2:{dash:"dash",symbol:"x"},3:{dash:"dash",symbol:"star"}};
  for(const kv of enabledPropagationVectors()){
    const vals=new Set();
    const K=hklToQ({astar:rv.astar,bstar:rv.bstar,cstar:rv.cstar},kv.hkl);
    for(let h=-20;h<=20;h++) for(let k=-20;k<=20;k++) for(let l=-20;l<=20;l++){
      const G=add(add(scale(rv.astar,h),scale(rv.bstar,k)),scale(rv.cstar,l));
      for(const sign of [1,-1]){
        const q=norm(add(G,scale(K,sign)));
        if(q>=1e-6&&q<=Qlim) vals.add(q.toFixed(6));
      }
    }
    const qs=[...vals].map(Number).sort((a,b)=>a-b), style=powderMagStyles[kv.index];
    qs.forEach((q,j)=>traces.push({x:[q,q],y:[0,hwmax],mode:"lines",name:`Magnetic Bragg peaks: k${kv.index}`,legendgroup:`powder-k${kv.index}`,showlegend:j===0,line:{color:"red",dash:style.dash,width:1},hovertemplate:`k${kv.index}<br>Q = ${q.toFixed(3)} Å⁻¹<extra></extra>`}));
    // Keep the circle/x/star visual key at the top of each magnetic line.
    if(qs.length) traces.push({x:qs,y:qs.map(()=>hwmax),mode:"markers",showlegend:false,legendgroup:`powder-k${kv.index}`,marker:{color:"red",size:kv.index===3?9:7,symbol:style.symbol},hoverinfo:"skip"});
  }

  for(const bg of selectedBackgrounds()){
    const sample=samples.get(bg.key);
    const peaks=Array.isArray(sample.peaks)?sample.peaks:[];
    const visiblePeaks=peaks
      .map(p=>({...p,q:2*PI/Number(p.d)}))
      .filter(p=>Number.isFinite(p.q) && p.q>0 && p.q<=Qlim);
    const maxI=visiblePeaks.length
      ? Math.max(...visiblePeaks.map(p=>Number(p.intensity)||0))
      : 0;

    visiblePeaks.forEach((p,index)=>{
      const intensity=Number(p.intensity)||0;
      const ratio=maxI>0?intensity/maxI:0;
      const hkl=[p.h,p.k,p.l].every(v=>v!==undefined)
        ? ` (${p.h}${p.k}${p.l})`
        : "";
      traces.push({
        x:[p.q,p.q],y:[0,hwmax],mode:"lines",
        name:`BG${bg.index+1}: ${sample.name||bg.key}`,
        legendgroup:`background-scattering-${bg.index}`,showlegend:index===0,
        line:{color:backgroundColor(bg.slot,0.20+0.75*ratio),width:1.5},
        hovertemplate:`BG${bg.index+1}: ${sample.name||bg.key}${hkl}<br>Q = ${p.q.toFixed(3)} Å⁻¹<br>I = ${intensity.toFixed(1)}<extra></extra>`
      });
    });
  }

  // Selected S2 guide: Q changes with energy transfer, so draw the full
  // constant-S2 trajectory Q(hw) rather than a vertical line fixed at hw=0.
  let pS2=Number($('powderS2Entry')?.value);
  if(!Number.isFinite(pS2)) pS2=Math.max(0,S2min);
  pS2=Math.max(0,Math.min(180,pS2));
  if($('powderS2Slider')){$('powderS2Slider').min=0;$('powderS2Slider').max=180;$('powderS2Slider').step=0.1;$('powderS2Slider').value=pS2;}
  if($('powderS2Entry')) $('powderS2Entry').value=pS2.toFixed(1);
  if($('powderS2Value')) $('powderS2Value').textContent=`${pS2.toFixed(1)}°`;
  const s2CurveQ=[], s2CurveHW=[];
  for(const w of hw){
    let Ei,Ef;
    if(energyMode==='Ef fixed'){ Ef=E; Ei=E+w; }
    else { Ei=E; Ef=E-w; }
    if(!(Ei>0&&Ef>0)) continue;
    const ki=0.6947*Math.sqrt(Ei), kf=0.6947*Math.sqrt(Ef);
    const q=Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(deg2rad(pS2))));
    s2CurveQ.push(q); s2CurveHW.push(w);
  }
  if(s2CurveQ.length){
    traces.push({x:s2CurveQ,y:s2CurveHW,mode:'lines',name:`S2 = ${pS2.toFixed(1)}°`,line:{color:'black',width:1.2,dash:'solid'},hovertemplate:`S2 = ${pS2.toFixed(1)}°<br>Q = %{x:.3f} Å⁻¹<br>ħω = %{y:.1f} meV<extra></extra>`});
  }

  const qMargin=0.1*Qlim;
  const title=`${inst.name||"Instrument"} | ${energyMode==="Ef fixed"?"Ef":"Ei"}=${E.toFixed(2)} meV | `+
    `a=${lc.a.toFixed(3)}, b=${lc.b.toFixed(3)}, c=${lc.c.toFixed(3)} Å<br>`+
    `α=${lc.alpha.toFixed(1)}, β=${lc.beta.toFixed(1)}, γ=${lc.gamma.toFixed(1)}°`;

  const keptPowderView=currentPlotRanges("powderPlot");
  Plotly.react("powderPlot",traces,{
    // Preserve user zoom/pan when controls trigger a recalculation.
    uirevision:"powderPlot",
    title:{text:title,x:0.5,xanchor:"center",font:{size:14}},
    xaxis:{title:"Q (Å⁻¹)",range:keptPowderView.x||[0,Qlim+qMargin],showgrid:true,gridcolor:"lightgray",zeroline:false,showline:true,mirror:true,linecolor:"black",linewidth:1,automargin:true},
    yaxis:{title:"ħω (meV)",range:keptPowderView.y||[0,hwmax*1.1||1],showgrid:true,gridcolor:"lightgray",zeroline:false,showline:true,mirror:true,linecolor:"black",linewidth:1,automargin:true},
    plot_bgcolor:"white",paper_bgcolor:"white",legend:{orientation:"h",x:0.5,xanchor:"center",y:-0.16,yanchor:"top"},
    shapes,annotations,margin:{l:66,r:34,t:80,b:110}
  },{responsive:true});
}

let timer=null;
function scheduleRecalc(){
  clearTimeout(timer);
  timer=setTimeout(recalculate,50);
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
function setGeometryPerpendicularCondition(mode){
  try{
    const b=collectResolutionBase();
    const U=[num("Uh"),num("Uk"),num("Ul")], V=[num("Vh"),num("Vk"),num("Vl")];
    const {ex,ey}=makeSpiceScatteringPlaneBasis(b.rl,U,V);
    const qU=hklToQ(b.rl,U), qV=hklToQ(b.rl,V);
    const ux=dot(qU,ex), uy=dot(qU,ey), vx=dot(qV,ex), vy=dot(qV,ey);
    const phiU=rad2deg(Math.atan2(uy,ux)), phiV=rad2deg(Math.atan2(vy,vx));
    const phiAxis=mode==="perpV"?phiV:phiU;

    // Perpendicular-condition buttons are absolute quick targets, not operations
    // on the previously entered Q.  Start from the corresponding fundamental
    // U/V Bragg position at elastic transfer so a previous high-Q target cannot
    // select a higher-|Q| solution.
    const currentHKL=(mode==="perpV"?V:U).slice();
    const hw=0;
    $("geomH").value=currentHKL[0];
    $("geomK").value=currentHKL[1];
    $("geomL").value=currentHKL[2];
    $("geomHW").value=0;
    const qCurrent=hklToQ(b.rl,currentHKL), qNorm=norm(qCurrent);
    if(!(qNorm>1e-12)) throw new Error(`${mode==="perpV"?"V":"U"} must be non-zero.`);
    const em=b.config.energy_mode;
    const Ei=em==="Ei fixed"?Number(b.config.Ei):Number(b.config.Ef)+hw;
    const Ef=em==="Ei fixed"?Number(b.config.Ei)-hw:Number(b.config.Ef);
    if(!(Ei>0) || !(Ef>0)) throw new Error("Ei and Ef must be positive.");
    const ki=Math.sqrt(Ei/2.072), kf=Math.sqrt(Ef/2.072);
    const cosS2=(ki*ki+kf*kf-qNorm*qNorm)/(2*ki*kf);
    if(cosS2<-1-1e-10||cosS2>1+1e-10) throw new Error("Current |Q| is not accessible at this energy transfer.");
    const s2Geom=rad2deg(Math.acos(clamp(cosS2,-1,1))), t=deg2rad(s2Geom);
    const phiQlab=rad2deg(Math.atan2(-kf*Math.sin(t),ki-kf*Math.cos(t)));
    const orient=$('orientationReference')?.value||'perpU';
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
    if(orient==='perpU') phiTargetDeg=wrap180(-90+phiU-phiQlab-s1Perp);
    else if(orient==='perpV') phiTargetDeg=wrap180(-90+phiV-phiQlab-s1Perp);
    else{
      const tx=dot(qCurrent,ex),ty=dot(qCurrent,ey),phi0=rad2deg(Math.atan2(ty,tx));
      const a0=tasMotorAngles({h:currentHKL[0],k:currentHKL[1],l:currentHKL[2],hw},b);
      phiTargetDeg=wrap180(phi0-angleDiffDeg(s1Perp,a0.s1));
    }
    const phiTarget=deg2rad(phiTargetDeg), qx=qNorm*Math.cos(phiTarget), qy=qNorm*Math.sin(phiTarget);
    const det=ux*vy-uy*vx; if(Math.abs(det)<=1e-12) throw new Error("U and V do not define an independent scattering plane.");
    const aa=(qx*vy-qy*vx)/det, bb=(ux*qy-uy*qx)/det;
    setGeometryTargetHKL([aa*U[0]+bb*V[0],aa*U[1]+bb*V[1],aa*U[2]+bb*V[2]].map(x=>Number(x.toFixed(3))));
  }catch(err){ console.error(err); alert(err?.message||String(err)); }
}
function setGeometryKiPerpU(){ setGeometryPerpendicularCondition("perpU"); }
function setGeometryKiPerpV(){ setGeometryPerpendicularCondition("perpV"); }
function setGeometryTargetFromBragg(){ setGeometryTargetHKL([num("refh"),num("refk"),num("refl")]); }
function setGeometryTargetFromDarkRef(slot){
  const ids=darkAssetIds(slot);
  setGeometryTargetHKL([num(ids.refH),num(ids.refK),num(ids.refL)]);
}

function syncGeometryHWSlider(cache){
  const slider=$("geomHWSlider"), output=$("geomHWValue"), entry=$("geomHW");
  if(!slider || !output || !entry || !cache?.hwList?.length) return;
  const lo=Math.min(...cache.hwList), hi=Math.max(...cache.hwList);
  const diffs=cache.hwList.slice(1).map((x,i)=>Math.abs(x-cache.hwList[i])).filter(x=>x>1e-9);
  const step=diffs.length ? Math.min(...diffs) : 0.1;
  slider.min=lo; slider.max=hi; slider.step=step;
  const v=Math.max(lo,Math.min(hi,Number(entry.value)||0));
  slider.value=v;
  output.textContent=`${Number(entry.value||0).toFixed(1)} meV`;
}


function ensureNuclearLabelControl(){
  if($("displayNuclearLabels")) return;
  const plot=$("singlePlot");
  const sliderRow=$("hwSlider")?.closest(".energy-slider-row");
  if(!plot || !sliderRow) return;
  const row=document.createElement("div");
  row.className="nuclear-label-control";
  row.innerHTML='<label class="checkbox-label"><input id="displayNuclearLabels" type="checkbox" checked><span>Display labels of nuclear Bragg peaks</span></label>';
  sliderRow.parentNode.insertBefore(row,sliderRow);
}

function ensureQESliderControls(){
  if(!$('hwEntry')){
    const row=$('hwSlider')?.closest('.energy-slider-row');
    if(row){
      row.style.display='grid'; row.style.gridTemplateColumns='1fr auto auto'; row.style.gap='10px'; row.style.alignItems='end';
      const wrap=document.createElement('label'); wrap.textContent='ħω (meV)';
      const input=document.createElement('input'); input.id='hwEntry'; input.type='number'; input.step='0.1'; input.value='0.0'; input.style.width='88px'; wrap.appendChild(input); row.appendChild(wrap);
      const srow=document.createElement('div'); srow.className='energy-slider-row'; srow.style.display='grid'; srow.style.gridTemplateColumns='1fr auto auto'; srow.style.gap='10px'; srow.style.alignItems='end';
      srow.innerHTML='<label>S2<input id="s2Slider" type="range" min="0" max="180" step="0.1" value="0"></label><output id="s2Value">0.0°</output><label>S2 (deg)<input id="s2Entry" type="number" step="0.1" value="0.0" style="width:88px"></label>';
      row.insertAdjacentElement('afterend',srow);
    }
  }
  if(!$('powderS2Slider')){
    const card=$('powderPlot')?.closest('.powder-plot-card');
    if(card){
      const row=document.createElement('div'); row.className='energy-slider-row'; row.style.display='grid'; row.style.gridTemplateColumns='1fr auto auto'; row.style.gap='10px'; row.style.alignItems='end'; row.style.marginBottom='8px';
      row.innerHTML='<label>S2<input id="powderS2Slider" type="range" min="0" max="180" step="0.1" value="0"></label><output id="powderS2Value">0.0°</output><label>S2 (deg)<input id="powderS2Entry" type="number" step="0.1" value="0.0" style="width:88px"></label>';
      card.insertBefore(row,$('powderPlot'));
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
function updatePowderS2Line(){ calculatePowder(); }
function recalculate(){
  clearError();
  updateEnergyLabel();
  updateModeVisibility();
  try{
    if(checkedValue("sampleMode")==="single"){
      singleCache=calculateSingleCrystal();
      syncGeometryHWSlider(singleCache);
      $("hwSlider").min=0;
      $("hwSlider").max=Math.max(0,singleCache.regions.length-1);
      $("hwSlider").step=1;
      const idx=Math.min(Number($("hwSlider").value)||0,singleCache.regions.length-1);
      $("hwSlider").value=idx;
      renderSingle(singleCache,idx);
    } else {
      calculatePowder();
      updatePowderRelation(powderRelationDriver);
    }
  }catch(err){
    showError(err);
  }
}

$("instrument").addEventListener("change",()=>{
  applyInstrumentDefaults();
  scheduleRecalc();
});

for(let slot=1;slot<=3;slot++){ const ids=darkAssetIds(slot); $(ids.se).addEventListener("change",()=>applySampleEnvironmentDefaults(slot)); $(ids.ref).addEventListener("change",()=>{updateDarkReferenceUI(slot);scheduleRecalc();}); }
BACKGROUND_SLOTS.forEach(slot=>$(slot.id).addEventListener("change",scheduleRecalc));

$("hwSlider").addEventListener("input",()=>{ if(singleCache) renderSingle(singleCache,Number($("hwSlider").value)); });

$("geomHWSlider").addEventListener("input",()=>{
  const v=Number($("geomHWSlider").value);
  $("geomHW").value=Number.isFinite(v) ? v.toFixed(1) : "0.0";
  $("geomHWValue").textContent=`${Number($("geomHW").value).toFixed(1)} meV`;
  scheduleRecalc();
});

$("geomHW").addEventListener("input",()=>{
  if(singleCache) syncGeometryHWSlider(singleCache);
});

$("geomSetU").addEventListener("click",setGeometryTargetFromU);
$("geomSetV").addEventListener("click",setGeometryTargetFromV);
$("geomPerpU").addEventListener("click",setGeometryKiPerpU);
$("geomPerpV").addEventListener("click",setGeometryKiPerpV);
$("geomSetBragg").addEventListener("click",setGeometryTargetFromBragg);
for(let slot=1;slot<=3;slot++) $(`geomSetRefQ${slot}`).addEventListener("click",()=>setGeometryTargetFromDarkRef(slot));

document.querySelectorAll("input,select").forEach(el=>{
  if([
    "instrument",
    "seSelect","seSelect2","seSelect3",
    ...BACKGROUND_SLOTS.map(slot=>slot.id),
    "hwSlider",
    "geomHWSlider"
  ].includes(el.id)) return;

  el.addEventListener("input",scheduleRecalc);
  el.addEventListener("change",scheduleRecalc);
});


// ==================== Resolution calculator ====================
let scanResults=[];
function formatAutoHKL(v){return v.map(x=>{if(Math.abs(x)<1e-10)return '0';const r=Math.round(x);if(Math.abs(x-r)<1e-10)return String(r);return Number(x.toPrecision(6)).toString();}).join(', ');}
function buildResolutionLattice(normalizeOrder=false){
  const lc={...latticeParams(),sv1:[num('Uh'),num('Uk'),num('Ul')],sv2:[num('Vh'),num('Vk'),num('Vl')]};
  const rl=RLRes(lc);
  if(normalizeOrder){
    const ordered=normalizeScatteringPlaneHKL(rl,lc.sv1,lc.sv2);
    if(ordered.swapped){
      // Resolution uses the canonical U/V order internally, but the shared
      // Scattering Plane inputs belong to both Q-E Range and Resolution.
      // Keep the user's entered vectors untouched in the left panel.
      lc.sv1=ordered.U; lc.sv2=ordered.V;
    }
  }
  lc.sv3=inferOutOfPlaneHKL(rl,lc.sv1,lc.sv2);
  $('Wauto').textContent=`auto: (${formatAutoHKL(lc.sv3)})`;
  return {lc,rl};
}
function updateAutoW(){try{buildResolutionLattice();}catch(_e){if($('Wauto'))$('Wauto').textContent='auto: unavailable';}}
function collectResolutionBase(){
  const {lc,rl}=buildResolutionLattice(true), em=$('energyMode').value,E=num('energy');
  const config={energy_mode:em,Ei:em==='Ei fixed'?E:null,Ef:em==='Ef fixed'?E:null,geometry:$('geometry').value,sign_config:$('sense').value};
  const approximation={method:$('method').value};
  const focusing={monochromator:{horizontal:{enabled:$('monoHF').checked,blades:num('monoHB')},vertical:{enabled:$('monoVF').checked,blades:num('monoVB')}},analyzer:{horizontal:{enabled:$('anaHF').checked,blades:num('anaHB')},vertical:{enabled:$('anaVF').checked,blades:num('anaVB')}}};
  const col={gm_1st:$('gm1').checked,div_1st_m:num('div1m'),div_1st_h:num('div1h'),div_1st_v:num('div1v'),div_2nd_h:num('div2h'),div_2nd_v:num('div2v'),div_3rd_h:num('div3h'),div_3rd_v:num('div3v'),div_4th_h:num('div4h'),div_4th_v:num('div4v')};
  const mos={d_mono:num('dMono'),mos_mono_h:num('mosMonoH'),mos_mono_v:num('mosMonoV'),mos_sam_h:num('mosSamH'),mos_sam_v:num('mosSamV'),d_ana:num('dAna'),mos_ana_h:num('mosAnaH'),mos_ana_v:num('mosAnaV')};
  const geom={L0:num('L0'),L1:num('L1'),L2:num('L2'),L3:num('L3'),beam_width:num('beamW'),beam_height:num('beamH'),mono_width:num('monoW'),mono_height:num('monoH'),mono_thickness:num('monoT'),ana_width:num('anaW'),ana_height:num('anaH'),ana_thickness:num('anaT'),det_width:num('detW'),det_height:num('detH')};
  return {lc,rl,col,mos,config,approximation,focusing,geom,unitMode:$('unit').value};
}
function wrap180(x){
  let y=(Number(x)+180)%360;
  if(y<0) y+=360;
  return y-180;
}

function angleDiffDeg(a,b){
  return wrap180(Number(a)-Number(b));
}

function tasMotorAngles(calc,b){
  const em=b.config.energy_mode;
  let Ei,Ef;
  if(em==='Ei fixed'){
    Ei=Number(b.config.Ei);
    Ef=Ei-Number(calc.hw);
  }else{
    Ef=Number(b.config.Ef);
    Ei=Ef+Number(calc.hw);
  }
  if(!(Ei>0) || !(Ef>0)) throw new Error('Ei and Ef must be positive to calculate TAS angles.');

  const ki=Math.sqrt(Ei/2.072);
  const kf=Math.sqrt(Ef/2.072);

  const braggAngle=(E,d,label)=>{
    const k=Math.sqrt(E/2.072);
    const arg=(2*PI/Number(d))/(2*k);
    if(arg>1+1e-12 || arg<-1-1e-12){
      throw new Error(`${label} Bragg condition is inaccessible at the selected energy.`);
    }
    return rad2deg(Math.asin(clamp(arg,-1,1)));
  };

  let m1abs=braggAngle(Ei,b.mos.d_mono,'Monochromator');
  let a1abs=braggAngle(Ef,b.mos.d_ana,'Analyzer');
  if(b.config.geometry==='anti-W') a1abs=-a1abs;

  let senseM,senseS,senseA;
  if(b.config.sign_config==='+-+'){
    senseM=+1; senseS=-1; senseA=+1;
  }else if(b.config.sign_config==='-+-'){
    senseM=-1; senseS=+1; senseA=-1;
  }else{
    throw new Error(`Unsupported TAS sign configuration: ${b.config.sign_config}`);
  }

  const m1=senseM*m1abs;
  const m2=2*m1;
  const a1=senseA*a1abs;
  const a2=2*a1;

  const target=[Number(calc.h),Number(calc.k),Number(calc.l)];
  const Qt=hklToQ(b.rl,target);
  const QtNorm=norm(Qt);
  if(QtNorm<1e-12) throw new Error('Q = 0 cannot define TAS sample angles.');

  const cosS2=(ki*ki+kf*kf-QtNorm*QtNorm)/(2*ki*kf);
  if(cosS2<-1-1e-10 || cosS2>1+1e-10){
    throw new Error('The requested Q and energy transfer are kinematically inaccessible.');
  }
  const s2=senseS*rad2deg(Math.acos(clamp(cosS2,-1,1)));

  // Reference-Q calibration of S1.
  // The entered Reference Q is observed at refs1 in the elastic condition.
  const U=b.lc.sv1, V=b.lc.sv2;
  const {ex,ey}=makeSpiceScatteringPlaneBasis(b.rl,U,V);
  const qAngle=(q,{allowZeroProjection=false}={})=>{
    const x=dot(q,ex), y=dot(q,ey);
    if(Math.hypot(x,y)<1e-12){
      // Match the Q-E range convention for Reference Q: Reference Q is
      // allowed to lie outside the scattering plane because it is used only
      // to establish the S1 offset.  When its in-plane projection vanishes,
      // use phi_ref = 0 rather than aborting the resolution calculation.
      if(allowZeroProjection) return 0;
      throw new Error('Calculation Q has no in-plane component and cannot define the TAS sample orientation.');
    }
    return rad2deg(Math.atan2(y,x));
  };

  // Reference Q is needed only for the optional S1/S2 angle calibration.
  // A bad Reference Q must never suppress an otherwise valid resolution result.
  const fixedE=em==='Ei fixed' ? Number(b.config.Ei) : Number(b.config.Ef);
  const orientationRef=effectiveOrientationReference(b.rl,fixedE);
  const ref=orientationRef.hkl;
  const Qr=hklToQ(b.rl,ref);
  const QrNorm=norm(Qr);

  if(QrNorm<1e-12){
    return {Ei,Ef,m1,m2,s1:null,s2,a1,a2,
      warning:'Reference Q is zero; S1 is unavailable.'};
  }

  const k0=Math.sqrt(fixedE/2.072);
  const cosRef=(2*k0*k0-QrNorm*QrNorm)/(2*k0*k0);
  if(cosRef<-1-1e-10 || cosRef>1+1e-10){
    return {Ei,Ef,m1,m2,s1:null,s2,a1,a2,
      warning:'Reference Q is outside the measurable range at the selected reference energy; S1 is unavailable.'};
  }
  const s2Ref=senseS*rad2deg(Math.acos(clamp(cosRef,-1,1)));

  // S1 is a physical sample-axis encoder calibration and must not change when
  // the TAS sign configuration is switched.  The validated -+- convention
  // uses the positive scattering branch, so use that same branch for the S1
  // UB/reference calculation in both -+- and +-+.  Only the displayed/physical
  // S2 motor angle above retains senseS.
  const s2ForS1=rad2deg(Math.acos(clamp(cosS2,-1,1)));
  const s2RefForS1=rad2deg(Math.acos(clamp(cosRef,-1,1)));

  // Match the validated Python UB/reference geometry exactly.  In the
  // canonical PDF frame, +z is the incident beam and +x is the in-plane
  // transverse direction.  For a horizontal detector:
  //   Q_lab = (-kf*sin(S2), 0, ki-kf*cos(S2))
  // and the physical sample rotation is
  //   omega = atan2(Qlab_x,Qlab_z) - atan2(Q0_x,Q0_z).
  // Reference Q determines omega_ref only; the encoder offset is then
  // transferred to the target by S1 = S1_ref + (omega_target-omega_ref).
  const phiLab=(ki0,kf0,s2deg)=>{
    const t=deg2rad(s2deg);
    const qx=-kf0*Math.sin(t);
    const qz= ki0-kf0*Math.cos(t);
    return rad2deg(Math.atan2(qx,qz));
  };

  // makeSpiceScatteringPlaneBasis gives ex along entered U and ey along the
  // canonical in-plane transverse direction.  These correspond to PDF z and
  // PDF x respectively, so atan2(ey,ex) is atan2(Q0_x,Q0_z).
  const phiTarget=qAngle(Qt);
  const phiRef=qAngle(Qr,{allowZeroProjection:true});
  const omegaTarget=wrap180(phiLab(ki,kf,s2ForS1)-phiTarget);
  const omegaRef=wrap180(phiLab(k0,k0,s2RefForS1)-phiRef);

  // The validated Python simulation uses C2_TO_OMEGA_SIGN = +1 for its
  // native scattering sense.  The opposite TAS sign configuration is the
  // left/right-mirrored instrument, so its sample encoder must run with the
  // opposite C2->omega sign.  Without this factor +-+ and -+- collapse onto
  // the same S1 solution after the signed-S2 geometry is formed.
  //
  //   omega = omega_ref + c2Sign * (S1-S1_ref)
  //   S1    = S1_ref + (omega-omega_ref)/c2Sign
  //
  // Keep +-+ as the already validated result and mirror only -+-.
  const c2Sign=(b.config.sign_config==='+-+') ? +1 : -1;
  const s1=orientationRef.s1 + angleDiffDeg(omegaTarget,omegaRef)/c2Sign;

  return {Ei,Ef,m1,m2,s1,s2,a1,a2,warning:''};
}

function calcOne(calc){
  const b=collectResolutionBase();
  const result=calcResolution(b.lc,b.rl,b.col,b.mos,b.config,b.approximation,b.focusing,b.geom,calc,b.unitMode);
  let angles;
  try{
    angles=tasMotorAngles(calc,b);
  }catch(err){
    // Angle calculation is supplemental.  Do not hide a valid resolution
    // result just because motor angles cannot be determined.
    angles={m1:null,m2:null,s1:null,s2:null,a1:null,a2:null,
      warning:`Angle calculation unavailable: ${err?.message || String(err)}`};
  }
  return {calc,...b,result,angles};
}
function matrixText(M){return M.map(r=>'[ '+r.map(x=>Number(x).toExponential(6).padStart(14)).join('  ')+' ]').join('\n');}
function traceEllipse(p,name,dash='solid'){return{x:p.x,y:p.y,mode:'lines',name,line:{dash},hoverinfo:'skip'};}
function baseLayout(title,xlabel,ylabel,xlim,ylim,equal=false,plotId=null){const kept=plotId?currentPlotRanges(plotId):{x:null,y:null};return{uirevision:plotId||'resolutionPlots',title:{text:title,font:{size:14}},margin:{l:60,r:20,t:45,b:55},xaxis:{title:xlabel,range:kept.x||[-xlim,xlim],zeroline:true,showgrid:true},yaxis:{title:ylabel,range:kept.y||[-ylim,ylim],zeroline:true,showgrid:true,...(equal?{scaleanchor:'x',scaleratio:1}:{})},showlegend:false};}
function formatAngle(value,absolute=false){
  if(value===null || value===undefined || !Number.isFinite(Number(value))) return '';
  const v=absolute ? Math.abs(Number(value)) : Number(value);
  return v.toFixed(3);
}

function renderResolution(entry,indexInfo=''){
  const {result:r,calc,unitMode,lc,angles}=entry;
  const qUnit=unitMode==='rlu'?'r.l.u.':'Å⁻¹';
  const ax=r.displayAxes || {U:lc.sv1,V:lc.sv2,W:lc.sv3};
  const fmtAxis=v=>`(${v.map(x=>{
    const y=Number(x);
    return Math.abs(y-Math.round(y))<1e-10 ? String(Math.round(y)) : Number(y.toPrecision(6)).toString();
  }).join(', ')})`;

  $('result').classList.remove('hidden');

  $('summary').innerHTML=
    `<div><b>Calculation point</b> ℏω=${calc.hw.toFixed(3)} meV, `+
    `h=${calc.h.toFixed(3)}, k=${calc.k.toFixed(3)}, l=${calc.l.toFixed(3)} ${indexInfo}</div>`+
    `<div><b>Resolution</b> δQ//${fmtAxis(ax.U)}=${r.display.U.toFixed(4)} (${r.display.Ucoh.toFixed(4)}) ${qUnit}, `+
    `δQ//${fmtAxis(ax.V)}=${r.display.V.toFixed(4)} (${r.display.Vcoh.toFixed(4)}) ${qUnit}, `+
    `δQ//${fmtAxis(ax.W)}=${r.display.W.toFixed(4)} (${r.display.Wcoh.toFixed(4)}) ${qUnit}, `+
    `δℏω=${r.display.E.toFixed(4)} (${r.display.Ecoh.toFixed(4)}) meV</div>`+
    `<div><b>Resolution axes</b> U=${fmtAxis(ax.U)}, V=${fmtAxis(ax.V)}, W=${fmtAxis(ax.W)}</div>`+
    `<div><b>Angles (deg)</b> M1=${formatAngle(angles.m1)}, M2=${formatAngle(angles.m2)}, `+
    `S1=${formatAngle(angles.s1)}, S2=${formatAngle(angles.s2,true)}, `+
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
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.U)} (${qUnit})`,'δℏω (meV)',r.lim.U,r.lim.E,false,'plotUE'),
    {responsive:true}
  );

  Plotly.react(
    'plotVE',
    [traceEllipse(r.ellipses.projVE,'projection'),traceEllipse(r.ellipses.sliceVE,'slice','dash')],
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.V)} (${qUnit})`,'δℏω (meV)',r.lim.V,r.lim.E,false,'plotVE'),
    {responsive:true}
  );

  Plotly.react(
    'plotWE',
    [traceEllipse(r.ellipses.projWE,'projection'),traceEllipse(r.ellipses.sliceWE,'slice','dash')],
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.W)} (${qUnit})`,'δℏω (meV)',r.lim.W,r.lim.E,false,'plotWE'),
    {responsive:true}
  );

  // Scattering-plane display scaling:
  // - r.l.u.: U and V are different reciprocal-lattice coordinates, so give
  //   each axis its own resolution range and do not force a 1:1 plot aspect.
  // - Å^-1: both axes are physical reciprocal-space lengths, so keep a common
  //   range and a 1:1 aspect ratio.
  const uvEqual=(unitMode!=='rlu');
  const uLim=uvEqual ? Math.max(r.lim.U,r.lim.V) : r.lim.U;
  const vLim=uvEqual ? uLim : r.lim.V;
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
function doSingleResolution(){clearError();try{const e=calcOne({hw:num('hw'),h:num('h'),k:num('k'),l:num('l')});$('scanNav').classList.add('hidden');renderResolution(e);}catch(e){showError(e);}}
function doScanResolution(){clearError();try{const n=Math.max(2,Math.round(num('npts'))),xs=(a,b)=>linspace(a,b,n),hs=xs(num('h0'),num('h1')),ks=xs(num('k0'),num('k1')),ls=xs(num('l0'),num('l1')),ws=xs(num('hw0'),num('hw1'));scanResults=Array.from({length:n},(_,i)=>calcOne({hw:ws[i],h:hs[i],k:ks[i],l:ls[i]}));$('scanSlider').min=1;$('scanSlider').max=n;$('scanSlider').value=1;$('scanNav').classList.remove('hidden');renderResolutionScan(1);}catch(e){showError(e);}}
function renderResolutionScan(i){i=Math.max(1,Math.min(scanResults.length,Number(i)));$('scanSlider').value=i;$('scanIndex').textContent=`${i} / ${scanResults.length}`;renderResolution(scanResults[i-1],`| scan ${i}/${scanResults.length}`);}


// Display-only terminology: magnetic propagation vectors are k1/k2/k3.
function updatePropagationVectorLabels(){
  for(let i=1;i<=3;i++){
    const enable=$( `q_enable${i}` );
    const row=enable?.closest('.propagation-row');
    if(!row) continue;
    const span=enable.closest('label')?.querySelector('span');
    if(span) span.textContent=`k${i}`;
    const labels=[...row.querySelectorAll('label')].filter(x=>x!==enable.closest('label'));
    ['h','k','l'].forEach((c,j)=>{
      if(labels[j] && labels[j].firstChild) labels[j].firstChild.nodeValue=`k${i}_${c}`;
    });
  }
}

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

function ensureExtendedToolboxUI(){
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
    style.textContent=`#toolboxPanel .toolbox-grid{grid-template-columns:repeat(11,minmax(105px,1fr))!important;overflow-x:auto;align-items:end} #toolboxPanel .toolbox-grid label{min-width:105px}`;
    document.head.appendChild(style);
  }
  // Extend the wavelength-multiple table with the same four quantities.
  const table=document.querySelector('#toolboxPanel .harmonic-table');
  if(table && !document.getElementById('harmBaseMass')){
    const old=[...table.children];
    const oldCols=8; // row label + 7 original quantities
    const prefixes=['harmThird','harmHalf','harmBase','harmDouble','harmTriple'];
    const extraHeaders=['Mass equivalent (kg)','Magnetic field (T)','Energy (J)','Heat (cal)'];
    const suffixes=['Mass','Field','J','Cal'];
    const frag=document.createDocumentFragment();
    for(let row=0;row<6;row++){
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
    for(const [factor,prefix] of [[1/3,'harmThird'],[1/2,'harmHalf'],[1,'harmBase'],[2,'harmDouble'],[3,'harmTriple']]){
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

// ==================== Powder Q / hw / 2theta helper ====================
let powderRelationDriver='powderTwoTheta';
function powderWavevectors(hw){
  const E=num('energy');
  const mode=checkedValue('energyMode');
  const Ei=mode==='Ef fixed' ? E+hw : E;
  const Ef=mode==='Ef fixed' ? E : E-hw;
  if(!(Ei>0) || !(Ef>0)) return null;
  return {ki:Math.sqrt(Ei/2.072),kf:Math.sqrt(Ef/2.072)};
}
function updatePowderRelation(driver=powderRelationDriver){
  if(!$('powderQ') || !$('powderHW') || !$('powderTwoTheta')) return;
  powderRelationDriver=driver;
  const hw=Number($('powderHW').value);
  if(!Number.isFinite(hw)) return;
  const wv=powderWavevectors(hw);
  const note=$('powderRelationNote');
  if(!wv){ note.textContent='This ħω is outside the positive Ei/Ef range.'; return; }
  const {ki,kf}=wv;
  if(driver==='powderQ'){
    const q=Number($('powderQ').value);
    if(!Number.isFinite(q) || q<0) return;
    const c=(ki*ki+kf*kf-q*q)/(2*ki*kf);
    if(c < -1-1e-10 || c > 1+1e-10){ note.textContent='The entered Q is not accessible at this ħω.'; return; }
    $('powderTwoTheta').value=rad2deg(Math.acos(clamp(c,-1,1))).toFixed(4);
  }else{
    const tt=Number($('powderTwoTheta').value);
    if(!Number.isFinite(tt)) return;
    const t=deg2rad(tt);
    const q=Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(t)));
    $('powderQ').value=q.toFixed(6);
  }
  note.textContent=`Ei=${(ki*ki*2.072).toFixed(4)} meV, Ef=${(kf*kf*2.072).toFixed(4)} meV`;
}

function resizeVisiblePlots(){
  if(typeof Plotly === "undefined" || !Plotly.Plots) return;
  const panel = [$("qePanel"),$("resolutionPanel"),$("toolboxPanel")].find(p=>p && !p.classList.contains("hidden"));
  if(!panel) return;
  panel.querySelectorAll(".js-plotly-plot").forEach(el=>{
    try{ Plotly.Plots.resize(el); }catch(_err){}
  });
}

function setActiveTab(name){
  const isQE=name==='qe', isResolution=name==='resolution', isToolbox=name==='toolbox';
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
  for(const [id,on] of [['tabQe',isQE],['tabResolution',isResolution],['tabToolbox',isToolbox]]){
    $(id).classList.toggle('active',on);
    $(id).setAttribute('aria-selected',String(on));
  }
  try{ localStorage.setItem(ACTIVE_TAB_STORAGE_KEY,name); }catch(_e){}
  requestAnimationFrame(()=>requestAnimationFrame(resizeVisiblePlots));
}
function updateCalcMode(){const scan=$('calcMode').value==='scan';$('singleInputs').classList.toggle('hidden',scan);$('scanInputs').classList.toggle('hidden',!scan);}

// ==================== App chrome + right-panel persistence ====================
const RIGHT_PANEL_STORAGE_KEY='tas-simulator-right-panel-v1';
const ACTIVE_TAB_STORAGE_KEY='tas-simulator-active-tab-v1';
let restoringRightPanel=false;

function setupAppHeader(){
  document.title='TAS Simulator';
  const header=document.querySelector('header');
  const h1=header?.querySelector('h1');
  if(h1) h1.textContent='TAS Simulator';
  if(!header || document.getElementById('githubLink')) return;

  // Project repository: fixed URL so the GitHub link works identically on
  // localhost, GitHub Pages, and custom-domain deployments.
  const repoUrl='https://github.com/Hodaka-Kikuchi/TAS_Simulator';

  const a=document.createElement('a');
  a.id='githubLink';
  a.href=repoUrl;
  a.target='_blank';
  a.rel='noopener noreferrer';
  a.textContent='GitHub';
  a.title='Open this project on GitHub';
  Object.assign(a.style,{marginLeft:'auto',whiteSpace:'nowrap',fontWeight:'600'});
  header.appendChild(a);
  // Keep the link at the far right without requiring a styles.css change.
  header.style.display='flex';
  header.style.alignItems='center';
  header.style.gap='14px';
  const status=header.querySelector('#status');
  if(status) status.style.marginLeft='auto';
  a.style.marginLeft='0';
}

function rightPanelControls(){
  return [...document.querySelectorAll('#qePanel input[id], #qePanel select[id], #resolutionPanel input[id], #resolutionPanel select[id], #toolboxPanel input[id], #toolboxPanel select[id]')]
    .filter(el=>el.type!=='button' && el.type!=='submit');
}

function saveRightPanelState(){
  if(restoringRightPanel) return;
  try{
    const values={};
    for(const el of rightPanelControls()){
      values[el.id]=(el.type==='checkbox'||el.type==='radio') ? !!el.checked : el.value;
    }
    localStorage.setItem(RIGHT_PANEL_STORAGE_KEY,JSON.stringify({version:1,values}));
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
    return true;
  }finally{restoringRightPanel=false;}
}

function savedActiveTab(){
  try{
    const name=localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    return ['qe','resolution','toolbox'].includes(name) ? name : 'qe';
  }catch(_e){ return 'qe'; }
}

function enableRightPanelPersistence(){
  for(const panelId of ['qePanel','resolutionPanel','toolboxPanel']){
    const panel=$(panelId); if(!panel) continue;
    panel.addEventListener('input',saveRightPanelState);
    panel.addEventListener('change',saveRightPanelState);
  }
}

setupAppHeader();

// ==================== Local left-panel persistence ====================
// Instrument/sample JSON files are the source of available choices and defaults.
// Restore the user's browser-local values only AFTER those JSON files have loaded,
// so saved values never race with or get overwritten by configuration loading.
const LEFT_PANEL_STORAGE_KEY='tas-qe-left-panel-v1';
let restoringLeftPanel=false;

function leftPanelControls(){
  return [...document.querySelectorAll('.sidebar input[id], .sidebar select[id]')];
}

function saveLeftPanelState(){
  if(restoringLeftPanel) return;
  try{
    const values={};
    for(const el of leftPanelControls()){
      values[el.id]=(el.type==='checkbox'||el.type==='radio') ? !!el.checked : el.value;
    }
    localStorage.setItem(LEFT_PANEL_STORAGE_KEY,JSON.stringify({version:1,values}));
  }catch(_e){ /* localStorage may be unavailable in a restricted browser context. */ }
}

function setSavedControl(id,value,{dispatchChange=false}={}){
  const el=$(id); if(!el || value===undefined) return false;
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

    // 2) The sample-environment JSON can populate dark-angle fields, so apply it
    //    before restoring the user's individual left-panel values.
    for(let slot=1;slot<=3;slot++){ const ids=darkAssetIds(slot); if(setSavedControl(ids.se,v[ids.se])) applySampleEnvironmentDefaults(slot); }

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
    for(const el of leftPanelControls()){
      if(el.id==='instrument'||['seSelect','seSelect2','seSelect3'].includes(el.id)) continue;
      setSavedControl(el.id,v[el.id],{dispatchChange:el.id==='monoCrystal'||el.id==='anaCrystal'});
    }

    updateModeVisibility(); updateEnergyLabel(); updateSupermirrorUI(); updateAutoW();
    return true;
  }finally{restoringLeftPanel=false;}
}

document.querySelector('.sidebar').addEventListener('input',saveLeftPanelState);
document.querySelector('.sidebar').addEventListener('change',saveLeftPanelState);

async function tryLoadDir(directory,map){try{return await loadJsonDirectory(directory,map);}catch(_e){map.clear();return 0;}}
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
  setStatus('instrument / sample / sample_environments loading...');
  const nInstrument=await loadJsonDirectory('instrument',instruments);
  const [nSample,nSE]=await Promise.all([tryLoadDir('sample',samples),tryLoadDir('sample_environments',sampleEnvironments)]);
  await tryLoadDir('instruments',legacyRangeInstruments); // migration compatibility only
  mergeLegacyRangeData();
  refreshSelect(instruments,$('instrument'),null);BACKGROUND_SLOTS.forEach(slot=>refreshSelect(samples,$(slot.id),'None'));for(let slot=1;slot<=3;slot++) refreshSelect(sampleEnvironments,$(darkAssetIds(slot).se),'Standard');
  if(!instruments.size) throw new Error('instrument directory has no JSON files.');
  $('instrument').selectedIndex=0;BACKGROUND_SLOTS.forEach(slot=>$(slot.id).value='');for(let slot=1;slot<=3;slot++) $(darkAssetIds(slot).se).value='';applyInstrumentDefaults();for(let slot=1;slot<=3;slot++) applySampleEnvironmentDefaults(slot);
  // JSON configuration is now fully loaded.  Only at this point is it safe to
  // overlay browser-local user parameters (including the selected instrument).
  const restoredLocalState=restoreLeftPanelState();
  // Restoring sidebar values can change Dark-angle Reference after the sample-
  // environment defaults were applied.  Re-sync the h/k/l row explicitly.
  for(let slot=1;slot<=3;slot++) updateDarkReferenceUI(slot);
  // Geometry starts at the current Reference Q HKL while preserving the current energy transfer.
  setGeometryTargetHKL([num("refh"),num("refk"),num("refl")]);
  updatePropagationVectorLabels(); ensureExtendedToolboxUI(); ensureNuclearLabelControl(); ensureQESliderControls();
  // Right-side controls are restored only after dynamic Toolbox controls exist and
  // after the default geometry target has been initialized, so saved values win.
  const restoredRightState=restoreRightPanelState();
  enableRightPanelPersistence();
  $('tabQe').addEventListener('click',()=>setActiveTab('qe'));$('tabResolution').addEventListener('click',()=>setActiveTab('resolution'));$('tabToolbox').addEventListener('click',()=>setActiveTab('toolbox'));
  for(const id of ['toolLambda','toolEnergy','toolK','toolTHz','toolTemp','toolCm','toolVelocity','toolMass','toolField','toolJ','toolCal']) $(id).addEventListener('input',()=>setToolboxFrom(id));
  $('powderQ').addEventListener('input',()=>updatePowderRelation('powderQ'));$('powderTwoTheta').addEventListener('input',()=>updatePowderRelation('powderTwoTheta'));$('powderHW').addEventListener('input',()=>updatePowderRelation(powderRelationDriver));
  $('hwEntry').addEventListener('change',()=>{if(singleCache){const i=nearestHWIndex(singleCache,Number($('hwEntry').value));renderSingle(singleCache,i);saveRightPanelState();}});
  $('s2Slider').addEventListener('input',()=>{$('s2Entry').value=Number($('s2Slider').value).toFixed(1);if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));});
  $('s2Entry').addEventListener('change',()=>{if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));});
  $('powderS2Slider').addEventListener('input',()=>{$('powderS2Entry').value=Number($('powderS2Slider').value).toFixed(1);updatePowderS2Line();});
  $('powderS2Entry').addEventListener('change',updatePowderS2Line);
  $('displayNuclearLabels').addEventListener('change',()=>{if(singleCache)renderSingle(singleCache,Number($('hwSlider').value));saveRightPanelState();});
  setToolboxFrom('toolLambda'); updatePowderRelation('powderTwoTheta');
  setActiveTab(savedActiveTab());
  $('gm1').addEventListener('change',updateSupermirrorUI);$('calcMode').addEventListener('change',updateCalcMode);$('calc').addEventListener('click',doSingleResolution);$('calcScan').addEventListener('click',doScanResolution);$('scanSlider').addEventListener('input',()=>renderResolutionScan(num('scanSlider')));$('prev').addEventListener('click',()=>renderResolutionScan(num('scanSlider')-1));$('next').addEventListener('click',()=>renderResolutionScan(num('scanSlider')+1));
  for(const id of ['a','b','c','alpha','beta','gamma','Uh','Uk','Ul','Vh','Vk','Vl']) $(id).addEventListener('input',updateAutoW);
  updateOrientationReferenceUI(); updateGeometryQuickTargetButtons(); $('orientationReference')?.addEventListener('change',()=>{updateOrientationReferenceUI();updateGeometryQuickTargetButtons();recalculate();});
  $('addDark')?.addEventListener('change',updateGeometryQuickTargetButtons);
  for(let slot=1;slot<=3;slot++){ const ids=darkAssetIds(slot); $(ids.enable)?.addEventListener('change',updateGeometryQuickTargetButtons); $(ids.ref)?.addEventListener('change',updateGeometryQuickTargetButtons); }
  setStatus(`${nInstrument} instrument(s), ${nSample} sample(s), ${nSE} sample environment(s) loaded${(restoredLocalState||restoredRightState) ? ' / local parameters restored' : ''}`);recalculate();
}
initialize().catch(err=>{showError(err);setStatus('Configuration loading failed. Open the project through an HTTP server.');});
