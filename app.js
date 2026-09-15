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

function applySampleEnvironmentDefaults(){
  const key=$("seSelect").value;
  if(!key || !sampleEnvironments.has(key)){
    setRadio("darkRef","Reference Q");
    for(let i=0;i<4;i++){
      $(`darkFrom${i}`).value=0;
      $(`darkTo${i}`).value=0;
      $(`darkOffset${i}`).value=0;
    }
    scheduleRecalc();
    return;
  }
  const se=sampleEnvironments.get(key);
  setRadio("darkRef",se.dark_angle_reference || "Reference Q");
  const ranges=Array.isArray(se.dark_angle_ranges)?se.dark_angle_ranges:[];
  for(let i=0;i<4;i++){
    const r=ranges[i] || {from:0,to:0,offset:0};
    $(`darkFrom${i}`).value=Number(r.from||0);
    $(`darkTo${i}`).value=Number(r.to||0);
    $(`darkOffset${i}`).value=Number(r.offset||0);
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

function getDarkRanges(){
  const rotation=num("darkRotation");
  const out=[];
  for(let i=0;i<4;i++){
    out.push([num(`darkFrom${i}`),num(`darkTo${i}`),num(`darkOffset${i}`)+rotation]);
  }
  return out;
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

  const ref=[num("refh"),num("refk"),num("refl")];
  const refS1=num("refs1");
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
  const darkRef=checkedValue("darkRef");
  // Q-E Range dark-angle calculation is intentionally kept on the previously
  // validated convention.  Direct-beam display corrections belong only to
  // the TAS geometry schematic below and must not alter these regions.
  const Qoffset=darkRef==="Reference Q"?90+thetaRef:2*thetaRef;
  const s1Offset=-thetaRef+180-phiRef;

  const S2min=num("S2min"), S1min=num("S1min"), S1max=num("S1max");
  const interp=instrumentInterp(inst,lambdaHalf);
  let hwList;
  if(lambdaHalf) hwList=[0];
  else if(energyMode==="Ef fixed"){
    const EiMax=maxArray(rangeTable(inst).map(x=>Number(x.Ei)));
    hwList=arange(0,EiMax-Ef,0.2);
  } else {
    hwList=arange(0,Ei,0.2);
  }
  if(hwList.length===0) hwList=[0];

  const regions=[], S2list=[], QmaxList=[];
  const darkKF=[],darkKI=[];
  const addDark=$("addDark").checked && QrefNorm>1e-10;
  const sense=checkedValue("sense");
  const darkRanges=getDarkRanges();

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

    const hwKF=[],hwKI=[];
    if(addDark){
      const s2dark=linspace(S2min,S2max,200);
      for(const rawRange of darkRanges){
        const [from,to,offset]=rawRange;
        if(from===0 && to===0) continue;

        // Dark-angle entries are geometric angles: counter-clockwise is always
        // positive.  calcQDark() already mirrors the calculated Q trajectory for
        // the +-+ instrument sense about the Reference-Q axis.  Therefore the
        // dark-angle limits themselves must NOT be sign-flipped for +-+; doing
        // both operations mirrors the geometry twice.  Use the same geometric
        // S1 parameterization for both sign conventions and let calcQDark()
        // perform the instrument-handedness mapping.
        const s1from=offset+from-Qoffset;
        const s1to=offset+to-Qoffset;

        const fromKF=s2dark.map(s2=>calcQDark(s1from,s2,ki,kf,s1Offset,QrefXY,sense,energyMode));
        const toKF=s2dark.map(s2=>calcQDark(s1to,s2,ki,kf,s1Offset,QrefXY,sense,energyMode));
        const topKF=linspace(s1from,s1to,100).map(s1=>calcQDark(s1,S2max,ki,kf,s1Offset,QrefXY,sense,energyMode));
        const bottomKF=linspace(s1to,s1from,100).map(s1=>calcQDark(s1,S2min,ki,kf,s1Offset,QrefXY,sense,energyMode));
        hwKF.push([...fromKF,...topKF,...[...toKF].reverse(),...bottomKF]);

        // The ki-blocking boundary is displaced from the kf-blocking boundary
        // by (180 - S2) in this geometric parameterization.  As above, the +-+
        // handedness is applied inside calcQDark(), so this displacement must
        // not receive an additional sign flip here.
        const kiShift=s2=>(180-s2);
        const fromKI=s2dark.map(s2=>calcQDark(s1from-kiShift(s2),s2,ki,kf,s1Offset,QrefXY,sense,energyMode));
        const toKI=s2dark.map(s2=>calcQDark(s1to-kiShift(s2),s2,ki,kf,s1Offset,QrefXY,sense,energyMode));
        const topKI=linspace(s1from-kiShift(S2max),s1to-kiShift(S2max),100)
          .map(s1=>calcQDark(s1,S2max,ki,kf,s1Offset,QrefXY,sense,energyMode));
        const bottomKI=linspace(s1to-kiShift(S2min),s1from-kiShift(S2min),100)
          .map(s1=>calcQDark(s1,S2min,ki,kf,s1Offset,QrefXY,sense,energyMode));
        hwKI.push([...fromKI,...topKI,...[...toKI].reverse(),...bottomKI]);
      }
    }
    darkKF.push(hwKF); darkKI.push(hwKI);
  }

  if(regions.length===0) throw new Error("No accessible energy-transfer points were generated.");

  const Qmax0=QmaxList[0];
  const Uq=hklToQ(rl,U), Vq=hklToQ(rl,V);
  const Ulen=norm(Uq), Vlen=norm(Vq);
  const Mmax=Math.ceil(Qmax0/Ulen)+1, Nmax=Math.ceil(Qmax0/Vlen)+1;
  const Gpoints=[], magPoints=[];
  const QplotLattice=2*Qmax0;
  const kvec=[num("kh"),num("kk"),num("kl")];

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

      if($("showK").checked){
        for(const s of [1,-1]){
          const hm=add(hkl,scale(kvec,s));
          const Gm=hklToQ(rl,hm);

          if(norm(Gm)<=QplotLattice){
            magPoints.push({
              x:dot(Gm,ex),
              y:dot(Gm,ey),
              label:`(${hm.map(x=>x.toFixed(2)).join(",")})`
            });
          }
        }
      }
    }
  }

  const ringData=[];
  const sampleKey=$("sampleSelect").value;
  if(sampleKey && samples.has(sampleKey)){
    const sample=samples.get(sampleKey);
    const peaks=Array.isArray(sample.peaks)?sample.peaks:[];
    const maxI=peaks.length?Math.max(...peaks.map(p=>Number(p.intensity)||0)):0;
    const qlimit=Math.max(...QmaxList);
    for(const p of peaks){
      const q=2*PI/Number(p.d);
      if(!Number.isFinite(q) || q>qlimit) continue;
      const phi=linspace(0,2*PI,361);
      const ratio=maxI>0?(Number(p.intensity)||0)/maxI:0;
      ringData.push({
        x:phi.map(t=>q*Math.cos(t)), y:phi.map(t=>q*Math.sin(t)),
        color:`rgba(0,0,255,${(0.15+0.70*ratio).toFixed(3)})`,
        hover:`${sample.name||sampleKey} (${p.h}${p.k}${p.l})<br>Q = ${q.toFixed(3)} Å⁻¹<br>I = ${Number(p.intensity).toFixed(1)}`
      });
    }
  }

  return {
    inst,lc,latticeCentering,U,V,rl,ex,ey,ez,
    energyMode,Ei,Ef,lambdaHalf,hwList,
    regions,S2list,QmaxList,darkKF,darkKI,addDark,
    Gpoints,magPoints,ringData,darkRanges,darkRef,QrefXY,sense
  };
}

function renderSingle(cache,index=0){
  const i=Math.max(0,Math.min(index,cache.regions.length-1));
  const boundary=cache.regions[i];
  const qMax = Math.max(
    ...cache.Gpoints.map(p => Math.hypot(p.x, p.y))
  );

  const labelOffset = 0.03 * qMax;
  const traces=[
    {
      x:boundary.map(p=>p[0]), y:boundary.map(p=>p[1]),
      fill:"toself", name:"Accessible Q", mode:"lines",
      line:{width:0}, fillcolor:"rgba(255,0,0,0.15)"
    },
    {
      x:cache.Gpoints.map(p=>p.x),
      y:cache.Gpoints.map(p=>p.y),
      mode:"markers",
      name:"Nuclear Bragg peaks",
      marker:{color:"black",size:6},
      hovertext:cache.Gpoints.map(p=>p.label),
      hovertemplate:"%{hovertext}<extra></extra>"
    },
    {
      x:cache.Gpoints
        .filter(p=>p.label !== "")
        .map(p=>p.x),

      y:cache.Gpoints
        .filter(p=>p.label !== "")
        .map(p=>p.y + labelOffset),

      mode:"text",

      text:cache.Gpoints
        .filter(p=>p.label !== "")
        .map(p=>p.label),

      textposition:"middle center",
      textfont:{color:"black",size:8},
      showlegend:false,
      hoverinfo:"skip"
    },
    {
      x:cache.magPoints.map(p=>p.x), y:cache.magPoints.map(p=>p.y),
      mode:"markers", name:"Magnetic Bragg peaks",
      marker:{color:"red",size:6},
      hovertext:cache.magPoints.map(p=>p.label), hovertemplate:"%{hovertext}<extra></extra>"
    }
  ];
  for(const ring of cache.ringData){
    traces.push({
      x:ring.x,y:ring.y,mode:"lines",showlegend:false,
      line:{color:ring.color,width:3},hovertemplate:ring.hover+"<extra></extra>"
    });
  }
  if(cache.addDark){
    for(const r of cache.darkKF[i]){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (kf side)",mode:"lines",line:{width:0},fillcolor:"rgba(0,0,255,0.15)"});
    }
    for(const r of cache.darkKI[i]){
      traces.push({x:r.map(p=>p[0]),y:r.map(p=>p[1]),fill:"toself",name:"Dark angle (ki side)",mode:"lines",line:{width:0},fillcolor:"rgba(0,255,0,0.15)"});
    }
  }
  traces.push({x:[null],y:[null],mode:"markers",name:`S2 range = ${num("S2min").toFixed(1)} - ${cache.S2list[i].toFixed(1)}°`});

  const energyText=cache.energyMode==="Ef fixed"?`Ef=${cache.Ef.toFixed(2)} meV`:`Ei=${cache.Ei.toFixed(2)} meV`;
  const lam=cache.lambdaHalf?" | λ/2":"";
  const Qplot=1.2*Math.max(...cache.QmaxList);
  const title=`${cache.inst.name||"Instrument"} | ${energyText}${lam}<br>`+
    `a=${cache.lc.a.toFixed(3)}, b=${cache.lc.b.toFixed(3)}, c=${cache.lc.c.toFixed(3)} Å<br>`+
    `α=${cache.lc.alpha.toFixed(1)}, β=${cache.lc.beta.toFixed(1)}, γ=${cache.lc.gamma.toFixed(1)}° | `+
    `Centering: ${cache.latticeCentering} | Plane: (${cache.U.join(",")})-(${cache.V.join(",")})`;

  Plotly.react("singlePlot",traces,{
    title:{text:title,x:0.5,xanchor:"center",font:{size:14}},
    xaxis:{title:"Qx (Å⁻¹)",range:[-Qplot,Qplot],dtick:1,showgrid:true,gridcolor:"lightgray",zeroline:true,constrain:"domain"},
    // Keep the reciprocal-space plotting box square: identical numerical Qx/Qy
    // ranges and a 1:1 data-unit aspect ratio.  `constrain: domain` makes Plotly
    // shrink the axis domain rather than silently expanding one numerical range.
    yaxis:{title:"Qy (Å⁻¹)",range:[-Qplot,Qplot],dtick:1,showgrid:true,gridcolor:"lightgray",zeroline:true,scaleanchor:"x",scaleratio:1,constrain:"domain"},
    // UI-only spacing: reclaim a little space above the plot, while reserving
    // more room below so the x-axis title and horizontal legend do not crowd.
    margin:{l:60,r:20,t:92,b:96},
    legend:{orientation:"h",x:0.5,xanchor:"center",y:-0.16,yanchor:"top"}
  },{responsive:true});

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
    analyzer=[sample[0]+L*Math.cos(thetaKf),sample[1]+L*Math.sin(thetaKf)];
    thetaOut=thetaKf+deg2rad(angles.a2);
    detector=[analyzer[0]+L*Math.cos(thetaOut),analyzer[1]+L*Math.sin(thetaOut)];
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
    sample=[0,0]; mono=[0,L]; source=[-L,L]; analyzer=[-mirror*L,0]; detector=[-mirror*L,-L];
    thetaKi=-Math.PI/2; thetaKf=mirror>0?Math.PI:-0; thetaOut=-Math.PI/2;
    monoPlaneAngle=mirror*deg2rad(45); anaPlaneAngle=mirror*deg2rad(45);
    qAngle=-mirror*Math.PI/4;
  }

  const traces=[];
  const addLine=(a,b,color,width=3,dash="solid")=>traces.push({x:[a[0],b[0]],y:[a[1],b[1]],mode:"lines",line:{color,width,dash},hoverinfo:"skip",showlegend:false});
  const flightColor="#cfcfcf";
  addLine(source,mono,flightColor,4); addLine(mono,sample,flightColor,4); addLine(sample,analyzer,flightColor,4); addLine(analyzer,detector,flightColor,4);

  const darkRadius=0.92;
  const circle=linspace(0,2*Math.PI,181);
  traces.push({x:circle.map(t=>sample[0]+darkRadius*Math.cos(t)),y:circle.map(t=>sample[1]+darkRadius*Math.sin(t)),mode:"lines",line:{color:"#d9d9d9",width:1},hoverinfo:"skip",showlegend:false});

  // Dark-angle arcs are centered on the sample.  Use exactly one origin:
  // the Reference-Q direction carried by the current sample orientation.
  //
  // Direct-beam mode is not anchored to the *current* ki.  Its zero direction
  // is the ki direction at the Reference-Q condition.  Convert that direction
  // to a fixed offset from Reference Q, then let the same sample orientation
  // carry both origins as S1 changes.  This makes, e.g., a 90-deg sample move
  // from (100) to (010) rotate a ki-referenced block by the same 90 deg.
  let base=qAngle;
  let deltaS1=0;
  let darkReferenceOffset=0;
  if(target){
    try{
      const U=[num("Uh"),num("Uk"),num("Ul")];
      const V=[num("Vh"),num("Vk"),num("Vl")];
      const {ex,ey}=makeSpiceScatteringPlaneBasis(cache.rl,U,V);
      const qPlaneAngle=(hkl)=>{
        const q=hklToQ(cache.rl,hkl);
        const x=dot(q,ex), y=dot(q,ey);
        if(Math.hypot(x,y)<1e-12) return 0;
        return Math.atan2(y,x);
      };
      const phiTarget=qPlaneAngle([target.calc.h,target.calc.k,target.calc.l]);
      const phiRef=qPlaneAngle([num("refh"),num("refk"),num("refl")]);
      const crystalDelta=phiRef-phiTarget;
      base=qAngle+(sense==="-+-" ? -crystalDelta : crystalDelta);

      const refS1=num("refs1");
      if(Number.isFinite(target.angles?.s1) && Number.isFinite(refS1)){
        deltaS1=angleDiffDeg(target.angles.s1,refS1); // display/hover only
      }

      if(cache.darkRef==="Direct beam"){
        // Elastic Reference-Q geometry: angle(Q -> ki) = 90deg-thetaRef.
        // The Q-E calculation uses the equivalent Qoffset correction
        // darkReferenceOffset = thetaRef-90deg.  Here we use the actual
        // screen-space Q->ki angle, with the TAS sense handled by the same
        // mirrored display convention as the Reference-Q geometry.
        const qRef=hklToQ(cache.rl,[num("refh"),num("refk"),num("refl")]);
        const qRefNorm=norm(qRef);
        const refEnergy=(cache.energyMode==="Ei fixed") ? cache.Ei : cache.Ef;
        if(qRefNorm>1e-12 && Number.isFinite(refEnergy) && refEnergy>0){
          const kRef=Math.sqrt(refEnergy/2.072);
          const thetaRef=Math.asin(clamp(qRefNorm/(2*kRef),-1,1));
          const qToKi=Math.PI/2-thetaRef;
          // base is the current Reference-Q direction.  Move its zero to the
          // incident-beam direction that existed when Reference Q was observed.
          base += -qToKi;
          darkReferenceOffset=(sense==="+-+" ? -1 : +1)*rad2deg(qToKi);
        }
      }
    }catch(_err){
      base=qAngle;
    }
  }

  cache.darkRanges.forEach((r,j)=>{
    const [from,to,offset]=r; if(from===0 && to===0) return;
    let a0=offset+from,a1=offset+to; if(a1<a0)a1+=360;
    // TAS-geometry-only convention: the dark/black sector must rotate around Q
    // in opposite senses for +-+ and -+-, matching the already-validated Q-E
    // Range block definition.  Q-E Range calculations are intentionally untouched.
    // Geometry-only display convention after the inelastic Q-E handedness fix:
    // +-+ must sweep the dark sector in the opposite plot-coordinate direction.
    // -+- is already validated, so leave it unchanged.
    const sign=-1;
    const aa=linspace(a0,a1,120).map(d=>base+sign*deg2rad(d));
    traces.push({x:aa.map(t=>sample[0]+darkRadius*Math.cos(t)),y:aa.map(t=>sample[1]+darkRadius*Math.sin(t)),mode:"lines",line:{color:"red",width:4},name:`Dark ${j+1}`,hovertemplate:`Dark angle ${j+1}<br>ΔS1=${deltaS1.toFixed(2)}°<br>Ref offset=${darkReferenceOffset.toFixed(2)}°<extra></extra>`,showlegend:false});
  });

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

  // Keep component labels in fixed screen-relative positions so their placement
  // does not change with the +-+ / -+- configuration.
  // Mono / Analyzer / Detector: always to the right. Sample: always to the left.
  const screenRightSign=sense==="+-+" ? 1 : -1;
  const monoLabel=[mono[0]+screenRightSign*0.72,mono[1]];
  const anaLabel=[analyzer[0]+screenRightSign*0.52,analyzer[1]];
  const sampleLabel=[sample[0]-screenRightSign*0.48,sample[1]];
  const detLabel=[detector[0]+screenRightSign*0.66,detector[1]];
  const kiMid=pointAlong(kiArrow.tail,kiArrow.head,.5),kfMid=pointAlong(kfArrow.tail,kfArrow.head,.5);

  const annotations=[
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

  const xs=[...source,...mono,...sample,...analyzer,...detector,qEnd[0]],ys=[source[1],mono[1],sample[1],analyzer[1],detector[1],qEnd[1]];
  const xmin=Math.min(source[0],mono[0],sample[0],analyzer[0],detector[0],qEnd[0])-1.0,xmax=Math.max(source[0],mono[0],sample[0],analyzer[0],detector[0],qEnd[0])+1.0;
  const ymin=Math.min(source[1],mono[1],sample[1],analyzer[1],detector[1],qEnd[1])-1.0,ymax=Math.max(source[1],mono[1],sample[1],analyzer[1],detector[1],qEnd[1])+1.0;
  // Keep the monochromator at a fixed screen position when the geometry target
  // changes.  Use the same compact scale as the pre-v18 view, but place the
  // monochromator above the vertical center so the instrument sits higher in
  // the panel.  Only the viewport changes; the TAS geometry itself is untouched.
  const span=Math.max(xmax-xmin,ymax-ymin);
  const cx=mono[0];
  const cy=mono[1]+0.28*span;

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
    fill:"toself",fillcolor:"rgba(255,150,150,0.35)",
    line:{width:0},name:"Accessible QE range"
  }];
  const shapes=[],annotations=[];
  const Qlim=Math.max(...qmax), hwmax=Math.max(...hw);
  [[al,"red","a*"],[bl,"blue","b*"],[cl,"green","c*"]].forEach(([base,color,label])=>{
    for(let n=1;n<20;n++){
      const q=n*base;
      if(q>Qlim) break;
      shapes.push({type:"line",x0:q,x1:q,y0:0,y1:1,yref:"paper",line:{color,dash:"dot",width:1}});
      annotations.push({x:q,y:hwmax,text:`${n}${label}`,showarrow:false,xshift:15,yshift:20,font:{color}});
    }
  });

  if($("showK").checked){
    const kv=[num("kh"),num("kk"),num("kl")], vals=new Set();
    for(let h=-20;h<=20;h++) for(let k=-20;k<=20;k++) for(let l=-20;l<=20;l++){
      const G=add(add(scale(rv.astar,h),scale(rv.bstar,k)),scale(rv.cstar,l));
      const K=add(add(scale(rv.astar,kv[0]),scale(rv.bstar,kv[1])),scale(rv.cstar,kv[2]));
      for(const s of [1,-1]){
        const q=norm(add(G,scale(K,s)));
        if(q>=1e-6&&q<=Qlim) vals.add(q.toFixed(6));
      }
    }
    [...vals].map(Number).sort((a,b)=>a-b).forEach(q=>{
      shapes.push({type:"line",x0:q,x1:q,y0:0,y1:1,yref:"paper",line:{color:"black",dash:"dot",width:1}});
      annotations.push({x:q,y:hwmax,text:"k*",showarrow:false,xshift:15,yshift:10,font:{color:"black"}});
    });
  }

  const sampleKey=$("sampleSelect").value;
  if(sampleKey && samples.has(sampleKey)){
    const sample=samples.get(sampleKey);
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
        name:`${sample.name||sampleKey} background`,
        legendgroup:"background-scattering",showlegend:index===0,
        line:{color:`rgba(0,0,255,${(0.15+0.70*ratio).toFixed(3)})`,width:3},
        hovertemplate:`${sample.name||sampleKey}${hkl}<br>Q = ${p.q.toFixed(3)} Å⁻¹<br>I = ${intensity.toFixed(1)}<extra></extra>`
      });
    });
  }

  const qMargin=0.1*Qlim;
  const title=`${inst.name||"Instrument"} | ${energyMode==="Ef fixed"?"Ef":"Ei"}=${E.toFixed(2)} meV | `+
    `a=${lc.a.toFixed(3)}, b=${lc.b.toFixed(3)}, c=${lc.c.toFixed(3)} Å<br>`+
    `α=${lc.alpha.toFixed(1)}, β=${lc.beta.toFixed(1)}, γ=${lc.gamma.toFixed(1)}°`;

  Plotly.react("powderPlot",traces,{
    title:{text:title,x:0.5,xanchor:"center",font:{size:14}},
    xaxis:{title:"Q (Å⁻¹)",range:[0,Qlim+qMargin],showgrid:true,gridcolor:"lightgray",zeroline:false,mirror:true,linecolor:"black"},
    yaxis:{title:"ħω (meV)",range:[0,hwmax*1.1||1],showgrid:true,gridcolor:"lightgray",zeroline:false,mirror:true,linecolor:"black"},
    plot_bgcolor:"white",paper_bgcolor:"white",legend:{x:0.02,y:0.98},
    shapes,annotations,margin:{l:60,r:20,t:80,b:55}
  },{responsive:true});
}

let timer=null;
function scheduleRecalc(){
  clearTimeout(timer);
  timer=setTimeout(recalculate,50);
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
    }
  }catch(err){
    showError(err);
  }
}

$("instrument").addEventListener("change",()=>{
  applyInstrumentDefaults();
  scheduleRecalc();
});

$("seSelect").addEventListener("change",applySampleEnvironmentDefaults);
$("sampleSelect").addEventListener("change",scheduleRecalc);

$("hwSlider").addEventListener("input",()=>{
  if(singleCache){
    renderSingle(singleCache,Number($("hwSlider").value));
  }
});

$("geomHWSlider").addEventListener("input",()=>{
  const v=Number($("geomHWSlider").value);
  $("geomHW").value=Number.isFinite(v) ? v.toFixed(1) : "0.0";
  $("geomHWValue").textContent=`${Number($("geomHW").value).toFixed(1)} meV`;
  scheduleRecalc();
});

$("geomHW").addEventListener("input",()=>{
  if(singleCache) syncGeometryHWSlider(singleCache);
});

document.querySelectorAll("input,select").forEach(el=>{
  if([
    "instrument",
    "seSelect",
    "sampleSelect",
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
  const ref=[num('refh'),num('refk'),num('refl')];
  const Qr=hklToQ(b.rl,ref);
  const QrNorm=norm(Qr);

  if(QrNorm<1e-12){
    return {Ei,Ef,m1,m2,s1:null,s2,a1,a2,
      warning:'Reference Q is zero; S1 is unavailable.'};
  }

  const fixedE=em==='Ei fixed' ? Number(b.config.Ei) : Number(b.config.Ef);
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
  const s1=num('refs1') + angleDiffDeg(omegaTarget,omegaRef)/c2Sign;

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
function baseLayout(title,xlabel,ylabel,xlim,ylim,equal=false){return{title:{text:title,font:{size:14}},margin:{l:60,r:20,t:45,b:55},xaxis:{title:xlabel,range:[-xlim,xlim],zeroline:true,showgrid:true},yaxis:{title:ylabel,range:[-ylim,ylim],zeroline:true,showgrid:true,...(equal?{scaleanchor:'x',scaleratio:1}:{})},showlegend:false};}
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
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.U)} (${qUnit})`,'δℏω (meV)',r.lim.U,r.lim.E),
    {responsive:true}
  );

  Plotly.react(
    'plotVE',
    [traceEllipse(r.ellipses.projVE,'projection'),traceEllipse(r.ellipses.sliceVE,'slice','dash')],
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.V)} (${qUnit})`,'δℏω (meV)',r.lim.V,r.lim.E),
    {responsive:true}
  );

  Plotly.react(
    'plotWE',
    [traceEllipse(r.ellipses.projWE,'projection'),traceEllipse(r.ellipses.sliceWE,'slice','dash')],
    baseLayout('δQ vs ℏω ellipse',`δQ ∥ ${fmtAxis(ax.W)} (${qUnit})`,'δℏω (meV)',r.lim.W,r.lim.E),
    {responsive:true}
  );

  // r.l.u. scaling is already included in projUV/sliceUV and r.lim.
  // Do NOT multiply the display range by two.
  const uvLim=Math.max(r.lim.U,r.lim.V);
  const uline={x:[-uvLim,uvLim],y:[0,0],mode:'lines',line:{width:1},hoverinfo:'skip'};
  const vline={x:[0,0],y:[-uvLim,uvLim],mode:'lines',line:{width:1},hoverinfo:'skip'};

  Plotly.react(
    'plotUV',
    [traceEllipse(r.ellipses.projUV,'projection'),traceEllipse(r.ellipses.sliceUV,'slice','dash'),uline,vline],
    baseLayout(
      'Scattering-plane resolution ellipse',
      `δQ ∥ ${fmtAxis(ax.U)} (${qUnit})`,
      `δQ ∥ ${fmtAxis(ax.V)} (${qUnit})`,
      uvLim,uvLim,true
    ),
    {responsive:true}
  );
}
function doSingleResolution(){clearError();try{const e=calcOne({hw:num('hw'),h:num('h'),k:num('k'),l:num('l')});$('scanNav').classList.add('hidden');renderResolution(e);}catch(e){showError(e);}}
function doScanResolution(){clearError();try{const n=Math.max(2,Math.round(num('npts'))),xs=(a,b)=>linspace(a,b,n),hs=xs(num('h0'),num('h1')),ks=xs(num('k0'),num('k1')),ls=xs(num('l0'),num('l1')),ws=xs(num('hw0'),num('hw1'));scanResults=Array.from({length:n},(_,i)=>calcOne({hw:ws[i],h:hs[i],k:ks[i],l:ls[i]}));$('scanSlider').min=1;$('scanSlider').max=n;$('scanSlider').value=1;$('scanNav').classList.remove('hidden');renderResolutionScan(1);}catch(e){showError(e);}}
function renderResolutionScan(i){i=Math.max(1,Math.min(scanResults.length,Number(i)));$('scanSlider').value=i;$('scanIndex').textContent=`${i} / ${scanResults.length}`;renderResolution(scanResults[i-1],`| scan ${i}/${scanResults.length}`);}

function resizeVisiblePlots(){
  if(typeof Plotly === "undefined" || !Plotly.Plots) return;
  const panel = $("qePanel").classList.contains("hidden") ? $("resolutionPanel") : $("qePanel");
  panel.querySelectorAll(".js-plotly-plot").forEach(el=>{
    try{ Plotly.Plots.resize(el); }catch(_err){}
  });
}

function setActiveTab(name){
  const isQE = name !== "resolution";
  const sampleMode=$("sampleMode");
  if(!isQE){
    // Resolution & Angle is defined only for a single-crystal scattering plane.
    // Force the shared Sample Type to Single crystal and prevent powder choice
    // while this tab is active.
    if(sampleMode.value!=="single"){
      sampleMode.value="single";
      updateModeVisibility();
      scheduleRecalc();
    }
    sampleMode.disabled=true;
    // Resolution canonicalizes U/V only in its internal calculation state.
    // The shared left-side Scattering Plane inputs remain exactly as entered
    // so Q-E Range is not silently modified when switching tabs.
    try{ buildResolutionLattice(true); }catch(_err){}
  }else{
    sampleMode.disabled=false;
  }
  $("qePanel").classList.toggle("hidden", !isQE);
  $("resolutionPanel").classList.toggle("hidden", isQE);
  $("tabQe").classList.toggle("active", isQE);
  $("tabResolution").classList.toggle("active", !isQE);
  $("tabQe").setAttribute("aria-selected", String(isQE));
  $("tabResolution").setAttribute("aria-selected", String(!isQE));
  requestAnimationFrame(()=>requestAnimationFrame(resizeVisiblePlots));
}
function updateCalcMode(){const scan=$('calcMode').value==='scan';$('singleInputs').classList.toggle('hidden',scan);$('scanInputs').classList.toggle('hidden',!scan);}

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
  refreshSelect(instruments,$('instrument'),null);refreshSelect(samples,$('sampleSelect'),'None');refreshSelect(sampleEnvironments,$('seSelect'),'Standard');
  if(!instruments.size) throw new Error('instrument directory has no JSON files.');
  $('instrument').selectedIndex=0;$('sampleSelect').value='';$('seSelect').value='';applyInstrumentDefaults();applySampleEnvironmentDefaults();
  $('tabQe').addEventListener('click',()=>setActiveTab('qe'));$('tabResolution').addEventListener('click',()=>setActiveTab('resolution'));
  $('gm1').addEventListener('change',updateSupermirrorUI);$('calcMode').addEventListener('change',updateCalcMode);$('calc').addEventListener('click',doSingleResolution);$('calcScan').addEventListener('click',doScanResolution);$('scanSlider').addEventListener('input',()=>renderResolutionScan(num('scanSlider')));$('prev').addEventListener('click',()=>renderResolutionScan(num('scanSlider')-1));$('next').addEventListener('click',()=>renderResolutionScan(num('scanSlider')+1));
  for(const id of ['a','b','c','alpha','beta','gamma','Uh','Uk','Ul','Vh','Vk','Vl']) $(id).addEventListener('input',updateAutoW);
  setStatus(`${nInstrument} instrument(s), ${nSample} sample(s), ${nSE} sample environment(s) loaded`);recalculate();
}
initialize().catch(err=>{showError(err);setStatus('Configuration loading failed. Open the project through an HTTP server.');});
