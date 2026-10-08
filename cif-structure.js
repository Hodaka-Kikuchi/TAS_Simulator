// CIF parser + neutron nuclear structure-factor utilities.
// Natural-element bound coherent neutron scattering lengths are based on the
// NIST/NCNR table: https://www.ncnr.nist.gov/resources/n-lengths/list.html
// Units: fm.  Complex values include the absorptive imaginary component.

const TWO_PI=2*Math.PI;
const EIGHT_PI2=8*Math.PI*Math.PI;
const SIXTEEN_PI2=16*Math.PI*Math.PI;

// Neutron data are loaded from neutron-data.json by app.js at startup.
// Keeping the table external makes scattering and absorption data easier to
// maintain and keeps the CIF parser/calculator on one shared data source.
export const NEUTRON_B_FM=Object.create(null);
const NEUTRON_DATA=Object.create(null);
let NEUTRON_DATA_META=null;

export function setNeutronData(payload){
  const src=payload?.elements || payload || {};
  for(const key of Object.keys(NEUTRON_B_FM)) delete NEUTRON_B_FM[key];
  for(const key of Object.keys(NEUTRON_DATA)) delete NEUTRON_DATA[key];
  for(const [key,record] of Object.entries(src)){
    if(!record || typeof record!=="object") continue;
    NEUTRON_DATA[key]=record;
    const b=record.b_coherent_fm;
    const re=Number(b?.real), im=Number(b?.imag||0);
    if(Number.isFinite(re) && Number.isFinite(im)) NEUTRON_B_FM[key]=[re,im];
  }
  NEUTRON_DATA_META=payload?.source || null;
}

export function neutronDataRecord(key){ return NEUTRON_DATA[String(key||"")] || null; }
export function neutronDataSource(){ return NEUTRON_DATA_META; }

function tokenizeCifLine(line){
  const out=[];
  let token='', quote=null;
  const flush=()=>{ if(token.length){ out.push(token); token=''; } };
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quote){
      if(ch===quote){ quote=null; flush(); }
      else token+=ch;
      continue;
    }
    if(ch==='#'){ flush(); break; }
    if(ch==='\'' || ch==='"'){
      flush(); quote=ch; continue;
    }
    if(/\s/.test(ch)){ flush(); continue; }
    token+=ch;
  }
  flush();
  return out;
}

export function tokenizeCif(text){
  const lines=String(text??'').replace(/\r\n?/g,'\n').split('\n');
  const tokens=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    // CIF semicolon text blocks begin/end with ';' in column 1.
    if(line.startsWith(';')){
      const block=[];
      const first=line.slice(1);
      if(first) block.push(first);
      i++;
      while(i<lines.length && !lines[i].startsWith(';')){ block.push(lines[i]); i++; }
      tokens.push(block.join('\n'));
      continue;
    }
    tokens.push(...tokenizeCifLine(line));
  }
  return tokens;
}

function isControlToken(token){
  const s=String(token||'').toLowerCase();
  return s==='loop_' || s==='stop_' || s==='global_' || s.startsWith('data_') || s.startsWith('save_');
}

export function parseCifDocument(text){
  const tokens=tokenizeCif(text);
  const scalar=Object.create(null), loops=[];
  let dataName='', i=0;
  while(i<tokens.length){
    const token=tokens[i], lower=String(token).toLowerCase();
    if(lower.startsWith('data_')){ dataName=token.slice(5); i++; continue; }
    if(lower==='loop_'){
      i++;
      const tags=[];
      while(i<tokens.length && String(tokens[i]).startsWith('_')) tags.push(String(tokens[i++]).toLowerCase());
      if(!tags.length) continue;
      const values=[];
      while(i<tokens.length){
        const t=String(tokens[i]);
        if(values.length%tags.length===0 && (isControlToken(t) || t.startsWith('_'))) break;
        values.push(tokens[i++]);
      }
      const rows=[];
      for(let j=0;j+tags.length<=values.length;j+=tags.length){
        const row=Object.create(null);
        for(let k=0;k<tags.length;k++) row[tags[k]]=values[j+k];
        rows.push(row);
      }
      loops.push({tags,rows});
      continue;
    }
    if(String(token).startsWith('_')){
      scalar[lower]=(i+1<tokens.length)?tokens[i+1]:'';
      i+=2; continue;
    }
    i++;
  }
  return {dataName,scalar,loops};
}

function stripUncertainty(value){
  const s=String(value??'').trim();
  if(!s || s==='.' || s==='?') return '';
  // 1.234(5) -> 1.234 ; 1.23(4)e2 -> 1.23e2
  return s.replace(/^(.*?)(?:\([^)]*\))(?=([eE][+-]?\d+)?$)/,'$1$2');
}

function parseCifNumber(value, fallback=NaN){
  const s=stripUncertainty(value);
  if(!s) return fallback;
  if(/^[-+]?\d+\s*\/\s*\d+$/.test(s)){
    const [a,b]=s.split('/').map(Number); return b? a/b:fallback;
  }
  const n=Number(s);
  return Number.isFinite(n)?n:fallback;
}

function wrap01(x){
  let y=x-Math.floor(x);
  if(Math.abs(y-1)<1e-10 || Math.abs(y)<1e-10) y=0;
  return y;
}

function rationalNumber(s){
  s=String(s).replace(/\*/g,'').trim();
  if(!s || s==='+') return 1;
  if(s==='-') return -1;
  if(s.startsWith('/')) return 1/Number(s.slice(1));
  if(s.startsWith('+/')) return 1/Number(s.slice(2));
  if(s.startsWith('-/')) return -1/Number(s.slice(2));
  if(s.includes('/')){
    const p=s.split('/');
    if(p.length===2){ const a=Number(p[0]),b=Number(p[1]); return a/b; }
  }
  return Number(s);
}

function evalSymComponent(expr,xyz){
  let s=String(expr??'').trim().toLowerCase().replace(/\s+/g,'').replace(/−/g,'-');
  if(!s) throw new Error('Empty symmetry-operation component.');
  // Convert subtraction into additive signed terms without altering exponents.
  s=s.replace(/-/g,'+-');
  if(s.startsWith('+')) s=s.slice(1);
  let out=0;
  for(const raw of s.split('+').filter(Boolean)){
    const m=raw.match(/[xyz]/);
    if(!m){ const c=rationalNumber(raw); if(!Number.isFinite(c)) throw new Error(`Unsupported CIF symmetry term: ${raw}`); out+=c; continue; }
    const v=m[0], idx={x:0,y:1,z:2}[v];
    let coeffText=raw.replace(v,'');
    const coeff=rationalNumber(coeffText);
    if(!Number.isFinite(coeff)) throw new Error(`Unsupported CIF symmetry term: ${raw}`);
    out+=coeff*xyz[idx];
  }
  return out;
}

function applySymmetryOperation(op,xyz){
  const parts=String(op).split(',');
  if(parts.length!==3) throw new Error(`Unsupported CIF symmetry operation: ${op}`);
  return parts.map(p=>wrap01(evalSymComponent(p,xyz)));
}

function elementKey(raw){
  let s=String(raw??'').trim();
  if(!s) return '';
  if(/^D(?:[0-9+\-].*)?$/i.test(s)) return 'D';
  const iso=s.match(/^(\d+)\s*([A-Za-z]{1,2})/);
  if(iso){
    const el=iso[2][0].toUpperCase()+iso[2].slice(1).toLowerCase();
    const key=iso[1]+el;
    if(NEUTRON_B_FM[key]) return key;
    if(key==='2H') return '2H';
    return el;
  }
  const m=s.match(/^([A-Za-z]{1,2})/);
  if(!m) return '';
  return m[1][0].toUpperCase()+m[1].slice(1).toLowerCase();
}

function firstScalar(scalar,names){
  for(const n of names){ const v=scalar[n.toLowerCase()]; if(v!==undefined) return v; }
  return undefined;
}

function findAtomLoop(doc){
  return doc.loops.find(lp=>lp.tags.includes('_atom_site_fract_x') && lp.tags.includes('_atom_site_fract_y') && lp.tags.includes('_atom_site_fract_z')) || null;
}
function findSymmetryOperations(doc){
  const names=['_space_group_symop_operation_xyz','_symmetry_equiv_pos_as_xyz'];
  for(const lp of doc.loops){
    for(const name of names){
      if(lp.tags.includes(name)) return lp.rows.map(r=>r[name]).filter(Boolean);
    }
  }
  const single=firstScalar(doc.scalar,names);
  return single ? [single] : ['x,y,z'];
}

// mCIF magnetic symmetry: (R,t,time reversal), including centering operators.
function magneticOperators(doc,names){
  for(const name of names){
    const loop=doc.loops.find(lp=>lp.tags.includes(name));
    if(loop) return loop.rows.map(r=>r[name]).filter(v=>v && v!=='.' && v!=='?');
    const single=doc.scalar[name];
    if(single) return [single];
  }
  return null;
}
function parseMagneticOperation(value){
  const parts=String(value).replace(/\s+/g,'').split(',');
  if(parts.length!==4) throw new Error(`Invalid mCIF magnetic symmetry operation: ${value}`);
  const xyz=parts.slice(0,3).join(',');
  const parity=parseCifNumber(parts[3]);
  if(parity!==1 && parity!==-1) throw new Error(`Invalid mCIF time reversal: ${value}`);
  return {xyz,rotation:symmetryRotationMatrix(xyz),parity};
}
function multiply3(A,B){return A.map(row=>B[0].map((_,j)=>row.reduce((v,x,k)=>v+x*B[k][j],0)));}
function determinant3(R){return R[0][0]*(R[1][1]*R[2][2]-R[1][2]*R[2][1])-R[0][1]*(R[1][0]*R[2][2]-R[1][2]*R[2][0])+R[0][2]*(R[1][0]*R[2][1]-R[1][1]*R[2][0]);}
function magneticMomentLoop(doc){
  return doc.loops.find(lp=>lp.tags.includes('_atom_site_moment.label')||lp.tags.includes('_atom_site_moment_label'))||null;
}
function magneticMomentForLabel(loop,label){
  if(!loop) return null;
  const row=loop.rows.find(r=>String(r['_atom_site_moment.label']??r['_atom_site_moment_label']??'').trim()===label);
  if(!row) return null;
  const values=[[' _atom_site_moment.crystalaxis_x','_atom_site_moment_crystalaxis_x'],['_atom_site_moment.crystalaxis_y','_atom_site_moment_crystalaxis_y'],['_atom_site_moment.crystalaxis_z','_atom_site_moment_crystalaxis_z']]
    .map(([modern,old])=>parseCifNumber(row[modern.trim()]??row[old]));
  if(values.some(v=>!Number.isFinite(v))) throw new Error(`Invalid mCIF moment components for ${label}`);
  return values;
}
function buildMagneticOperations(doc){
  const ops=magneticOperators(doc,['_space_group_symop_magn_operation.xyz','_space_group_symop.magn_operation_xyz']);
  if(!ops) return null;
  const centers=magneticOperators(doc,['_space_group_symop_magn_centering.xyz','_space_group_symop.magn_centering_xyz'])||['x,y,z,1'];
  const result=[];
  for(const opText of ops) for(const centeringText of centers){
    const a=parseMagneticOperation(opText),b=parseMagneticOperation(centeringText);
    const R=multiply3(a.rotation,b.rotation);
    const origin=applySymmetryOperation(a.xyz,applySymmetryOperation(b.xyz,[0,0,0]));
    result.push({R,origin,parity:a.parity*b.parity});
  }
  return result;
}

function parseLinearCombination(expr,variables){
  let s=String(expr??'').trim().toLowerCase().replace(/\s+/g,'').replace(/−/g,'-');
  if(!s) throw new Error(`Empty linear expression: ${expr}`);
  s=s.replace(/-/g,'+-');
  if(s.startsWith('+')) s=s.slice(1);
  const coeffs=Object.fromEntries(variables.map(v=>[v,0]));
  let constant=0;
  const ordered=[...variables].sort((a,b)=>b.length-a.length);
  for(const raw of s.split('+').filter(Boolean)){
    const hit=ordered.find(v=>raw.includes(v));
    if(!hit){
      const c=rationalNumber(raw);
      if(!Number.isFinite(c)) throw new Error(`Unsupported linear term: ${raw}`);
      constant+=c;
      continue;
    }
    const coeffText=raw.replace(hit,'');
    const coeff=rationalNumber(coeffText);
    if(!Number.isFinite(coeff)) throw new Error(`Unsupported linear term: ${raw}`);
    coeffs[hit]+=coeff;
  }
  return {coeffs,constant};
}
function parseSuperspaceMagneticOperation(value){
  const parts=String(value).replace(/\s+/g,'').split(',');
  if(parts.length!==5) throw new Error(`Invalid magnetic superspace operation: ${value}`);
  const spatialText=parts.slice(0,3).map(v=>String(v).replace(/x1/g,'x').replace(/x2/g,'y').replace(/x3/g,'z')).join(',');
  const parity=parseCifNumber(parts[4]);
  if(parity!==1 && parity!==-1) throw new Error(`Invalid mCIF superspace time reversal: ${value}`);
  const x4=parseLinearCombination(parts[3],['x1','x2','x3','x4']);
  if(Math.abs((x4.coeffs.x1||0))>1e-12 || Math.abs((x4.coeffs.x2||0))>1e-12 || Math.abs((x4.coeffs.x3||0))>1e-12){
    throw new Error(`Unsupported superspace x4 dependence on x1/x2/x3 in: ${value}`);
  }
  if(Math.abs(Math.abs(x4.coeffs.x4)-1)>1e-12) throw new Error(`Unsupported superspace x4 coefficient in: ${value}`);
  return {xyz:spatialText,rotation:symmetryRotationMatrix(spatialText),parity,phaseSign:x4.coeffs.x4,phaseShift:x4.constant};
}
function buildMagneticSuperspaceOperations(doc,warnings){
  const opNames=['_space_group_symop_magn_ssg_operation.algebraic','_space_group_symop.magn_ssg_operation_algebraic'];
  const centerNames=['_space_group_symop_magn_ssg_centering.algebraic','_space_group_symop.magn_ssg_centering_algebraic'];
  const ops=magneticOperators(doc,opNames);
  if(!ops) return null;
  const centers=magneticOperators(doc,centerNames)||['x1,x2,x3,x4,+1'];
  const result=[];
  try{
    for(const opText of ops) for(const centeringText of centers){
      const a=parseSuperspaceMagneticOperation(opText), b=parseSuperspaceMagneticOperation(centeringText);
      const R=multiply3(a.rotation,b.rotation);
      const origin=applySymmetryOperation(a.xyz,applySymmetryOperation(b.xyz,[0,0,0]));
      result.push({R,origin,parity:a.parity*b.parity,phaseSign:a.phaseSign*b.phaseSign,phaseShift:a.phaseSign*b.phaseShift+a.phaseShift});
    }
  }catch(err){
    warnings?.push(`Single-q incommensurate display was disabled: ${err.message}`);
    return null;
  }
  return result;
}
function cellWaveVectors(doc){
  const loop=doc.loops.find(lp=>lp.tags.includes('_cell_wave_vector_x') && lp.tags.includes('_cell_wave_vector_y') && lp.tags.includes('_cell_wave_vector_z'));
  if(!loop) return [];
  return loop.rows.map((row,index)=>({
    seqId:String(row['_cell_wave_vector_seq_id'] ?? `${index+1}`),
    q:[parseCifNumber(row['_cell_wave_vector_x']),parseCifNumber(row['_cell_wave_vector_y']),parseCifNumber(row['_cell_wave_vector_z'])]
  })).filter(item=>item.q.every(Number.isFinite));
}
function magneticFourierMoments(doc,warnings){
  const qVectors=cellWaveVectors(doc);
  const loop=doc.loops.find(lp=>lp.tags.includes('_atom_site_moment_fourier.atom_site_label'));
  if(!loop || !qVectors.length) return {supported:false,q:null,byLabel:new Map()};
  if(qVectors.length!==1){
    warnings?.push(`This viewer currently supports only single-q incommensurate magCIF display; found ${qVectors.length} wave vectors.`);
    return {supported:false,q:qVectors[0]?.q||null,byLabel:new Map()};
  }
  const q=qVectors[0].q.slice();
  const byLabel=new Map();
  const axisIndex={x:0,y:1,z:2};
  for(const row of loop.rows){
    const label=String(row['_atom_site_moment_fourier.atom_site_label']||'').trim();
    const axis=String(row['_atom_site_moment_fourier.axis']||'').trim().toLowerCase();
    const seqId=String(row['_atom_site_moment_fourier.wave_vector_seq_id']||'').trim();
    if(!label || !(axis in axisIndex)) continue;
    if(seqId && seqId!==String(qVectors[0].seqId)) continue;
    const cos=parseCifNumber(row['_atom_site_moment_fourier_param.cos'],0);
    const sin=parseCifNumber(row['_atom_site_moment_fourier_param.sin'],0);
    const rec=byLabel.get(label)||{q:q.slice(),cos:[0,0,0],sin:[0,0,0]};
    rec.cos[axisIndex[axis]]=Number.isFinite(cos)?cos:0;
    rec.sin[axisIndex[axis]]=Number.isFinite(sin)?sin:0;
    byLabel.set(label,rec);
  }
  return {supported:byLabel.size>0,q,byLabel};
}
function applyMagneticOperator(op,p){return op.origin.map((v,i)=>wrap01(v+op.R[i].reduce((sum,x,j)=>sum+x*p[j],0)));}
function transformAxialMoment(op,m){
  const factor=op.parity*determinant3(op.R);
  return op.R.map(row=>factor*row.reduce((sum,x,j)=>sum+x*m[j],0));
}
function positionKey(p){ return p.map(v=>Math.round(wrap01(v)*1e8)).join(','); }

function findAnisoLoop(doc){
  return doc.loops.find(lp=>
    (lp.tags.includes('_atom_site_aniso_label') || lp.tags.includes('_atom_site_aniso_type_symbol')) &&
    lp.tags.includes('_atom_site_aniso_u_11') && lp.tags.includes('_atom_site_aniso_u_22') && lp.tags.includes('_atom_site_aniso_u_33')
  ) || null;
}

function symmetryRotationMatrix(op){
  // Extract the linear fractional-coordinate part R from x' = R x + t.
  const o=[0,0,0];
  const p0=applySymmetryOperation(op,o);
  const cols=[];
  for(let j=0;j<3;j++){
    const e=[0,0,0]; e[j]=1e-4;
    const p=applySymmetryOperation(op,e);
    cols.push(p.map((v,i)=>{
      let d=(v-p0[i])/1e-4;
      // wrapping can turn a small negative displacement into ~1; recover it.
      if(d>5000) d-=10000;
      return Math.round(d);
    }));
  }
  return [
    [cols[0][0],cols[1][0],cols[2][0]],
    [cols[0][1],cols[1][1],cols[2][1]],
    [cols[0][2],cols[1][2],cols[2][2]]
  ];
}

function transformSymmetricTensor(U,R){
  const out=Array.from({length:3},()=>Array(3).fill(0));
  for(let i=0;i<3;i++) for(let j=0;j<3;j++)
    for(let a=0;a<3;a++) for(let b=0;b<3;b++) out[i][j]+=R[i][a]*U[a][b]*R[j][b];
  return out;
}

function reciprocalLengths(lattice){
  const a=Number(lattice?.a), b=Number(lattice?.b), c=Number(lattice?.c);
  const al=Number(lattice?.alpha)*Math.PI/180, be=Number(lattice?.beta)*Math.PI/180, ga=Number(lattice?.gamma)*Math.PI/180;
  if(![a,b,c,al,be,ga].every(Number.isFinite) || !(a>0&&b>0&&c>0)) return null;
  const ca=Math.cos(al), cb=Math.cos(be), cg=Math.cos(ga), sg=Math.sin(ga);
  const volFactor=Math.sqrt(Math.max(0,1-ca*ca-cb*cb-cg*cg+2*ca*cb*cg));
  if(!(volFactor>0) || Math.abs(sg)<1e-14) return null;
  const V=a*b*c*volFactor;
  return [b*c*Math.sin(al)/V, a*c*Math.sin(be)/V, a*b*Math.sin(ga)/V];
}

export function parseCifStructure(text){
  const doc=parseCifDocument(text);
  const atomLoop=findAtomLoop(doc);
  if(!atomLoop || !atomLoop.rows.length) throw new Error('CIF has no atom-site fractional coordinates.');
  const warnings=[];
  const magneticOps=buildMagneticOperations(doc);
  const momentLoop=magneticMomentLoop(doc);
  const fourierInfo=magneticFourierMoments(doc,warnings);
  const superspaceOps=fourierInfo.supported ? buildMagneticSuperspaceOperations(doc,warnings) : null;
  const symops=(magneticOps||superspaceOps) ? [] : findSymmetryOperations(doc);
  const anisoLoop=findAnisoLoop(doc);
  const anisoByLabel=new Map();
  if(anisoLoop){
    for(const r of anisoLoop.rows){
      const label=String(r['_atom_site_aniso_label'] ?? r['_atom_site_aniso_type_symbol'] ?? '').trim();
      if(!label) continue;
      const u11=parseCifNumber(r['_atom_site_aniso_u_11']), u22=parseCifNumber(r['_atom_site_aniso_u_22']), u33=parseCifNumber(r['_atom_site_aniso_u_33']);
      const u12=parseCifNumber(r['_atom_site_aniso_u_12'],0), u13=parseCifNumber(r['_atom_site_aniso_u_13'],0), u23=parseCifNumber(r['_atom_site_aniso_u_23'],0);
      if([u11,u22,u33,u12,u13,u23].every(Number.isFinite)) anisoByLabel.set(label,[[u11,u12,u13],[u12,u22,u23],[u13,u23,u33]]);
    }
  }
  const atoms=[], asymmetricSites=[], missing=new Set(), invalidSites=[];

  for(const row of atomLoop.rows){
    const typeRaw=row['_atom_site_type_symbol'] ?? row['_atom_site_label'];
    const element=elementKey(typeRaw);
    const b=NEUTRON_B_FM[element];
    if(!element || !b){ missing.add(String(typeRaw||'?')); continue; }
    const xyz=[
      parseCifNumber(row['_atom_site_fract_x']),
      parseCifNumber(row['_atom_site_fract_y']),
      parseCifNumber(row['_atom_site_fract_z'])
    ];
    const siteLabel=String(row['_atom_site_label'] ?? typeRaw ?? `site ${asymmetricSites.length+1}`).trim();
    if(xyz.some(v=>!Number.isFinite(v))){ invalidSites.push(siteLabel || `site ${asymmetricSites.length+1}`); continue; }
    const occupancy=parseCifNumber(row['_atom_site_occupancy'],1);
    if(!Number.isFinite(occupancy) || occupancy<0 || occupancy>1){ invalidSites.push(`${siteLabel || `site ${asymmetricSites.length+1}`} (occupancy)`); continue; }
    const sourceMoment=magneticMomentForLabel(momentLoop,siteLabel);
    const fourier=fourierInfo.byLabel.get(siteLabel) || null;
    asymmetricSites.push({label:siteLabel,element,x:xyz[0],y:xyz[1],z:xyz[2],occupancy,magneticMoment:sourceMoment,magneticFourier:fourier});
    let Biso=parseCifNumber(row['_atom_site_b_iso_or_equiv'],NaN);
    if(!Number.isFinite(Biso)){
      const Uiso=parseCifNumber(row['_atom_site_u_iso_or_equiv'],NaN);
      Biso=Number.isFinite(Uiso)?EIGHT_PI2*Uiso:0;
    }
    const label=String(row['_atom_site_label'] ?? '').trim();
    const U0=anisoByLabel.get(label) || null;
    const moment=magneticMomentForLabel(momentLoop,siteLabel);
    const unique=new Map();
    const opsToUse=(superspaceOps && fourier) ? superspaceOps : (magneticOps||symops);
    for(const op of opsToUse){
      const p=(magneticOps||superspaceOps)?applyMagneticOperator(op,xyz):applySymmetryOperation(op,xyz);
      const key=positionKey(p);
      const R=(magneticOps||superspaceOps)?op.R:symmetryRotationMatrix(op);
      const transformedMoment=moment ? ((magneticOps||superspaceOps)?transformAxialMoment(op,moment):moment.slice()) : null;
      const transformedFourier=fourier ? {q:fourier.q.slice(),cos:fourier.cos.slice(),sin:fourier.sin.slice(),phaseSign:(op.phaseSign ?? 1),phaseShift:(op.phaseShift ?? 0),transformR:R,transformFactor:(op.parity ?? 1)*determinant3(R)} : null;
      if(unique.has(key)){
        // Sunny's set_dipoles_from_mcif! rejects incompatible moments produced
        // for the same site by different magnetic symmetry operations.
        const previous=unique.get(key).magneticMoment;
        if(previous && transformedMoment &&
           previous.some((v,i)=>Math.abs(v-transformedMoment[i])>1e-7*Math.max(1,Math.abs(v),Math.abs(transformedMoment[i])))){
          throw new Error(`Inconsistent mCIF magnetic symmetry for ${siteLabel} at (${p.map(v=>v.toFixed(6)).join(', ')}).`);
        }
      }else{
        unique.set(key,{p,U:U0?transformSymmetricTensor(U0,R):null,magneticMoment:transformedMoment,magneticFourier:transformedFourier});
      }
    }
    const sourceSiteIndex=asymmetricSites.length-1;
    for(const item of unique.values()) atoms.push({
      element, occupancy:Number.isFinite(occupancy)?occupancy:1,
      Biso:Number.isFinite(Biso)?Biso:0, Uaniso:item.U,
      x:item.p[0],y:item.p[1],z:item.p[2], bRe:b[0],bIm:b[1],
      sourceLabel:siteLabel, sourceSiteIndex, magneticMoment:item.magneticMoment,
      magneticFourier:item.magneticFourier,
      sourceX:xyz[0], sourceY:xyz[1], sourceZ:xyz[2]
    });
  }

  // Check duplicates across *different* asymmetric labels as well: overlapping
  // magnetic orbits must not silently assign contradictory dipoles to one site.
  if((magneticOps||superspaceOps) && momentLoop){
    const occupied=new Map();
    for(const atom of atoms){
      if(!Array.isArray(atom.magneticMoment)) continue;
      const key=positionKey([atom.x,atom.y,atom.z]);
      const existing=occupied.get(key);
      if(existing && existing.moment.some((v,i)=>Math.abs(v-atom.magneticMoment[i])>1e-7*Math.max(1,Math.abs(v),Math.abs(atom.magneticMoment[i])))){
        throw new Error(`Conflicting mCIF moments at (${[atom.x,atom.y,atom.z].map(v=>v.toFixed(6)).join(', ')}): ${existing.label} and ${atom.sourceLabel}.`);
      }
      if(!existing) occupied.set(key,{moment:atom.magneticMoment,label:atom.sourceLabel});
    }
  }
  if(missing.size) throw new Error(`No neutron coherent scattering length is available for CIF atom type(s): ${[...missing].join(', ')}`);
  if(invalidSites.length) throw new Error(`CIF atom site(s) could not be loaded because coordinates or occupancy are invalid: ${invalidSites.join(', ')}`);
  if(!atoms.length) throw new Error('CIF atom sites could not be expanded into a crystal structure.');
  if(!(magneticOps||superspaceOps) && symops.length===1 && String(symops[0]).replace(/\s/g,'').toLowerCase()==='x,y,z') warnings.push('No symmetry-operation loop was found; identity symmetry only was used.');

  const scalar=doc.scalar;
  const lattice={
    a:parseCifNumber(firstScalar(scalar,['_cell_length_a'])),
    b:parseCifNumber(firstScalar(scalar,['_cell_length_b'])),
    c:parseCifNumber(firstScalar(scalar,['_cell_length_c'])),
    alpha:parseCifNumber(firstScalar(scalar,['_cell_angle_alpha'])),
    beta:parseCifNumber(firstScalar(scalar,['_cell_angle_beta'])),
    gamma:parseCifNumber(firstScalar(scalar,['_cell_angle_gamma']))
  };
  const formula=firstScalar(scalar,['_chemical_formula_sum','_chemical_formula_structural']) || '';
  const spaceGroup=firstScalar(scalar,['_space_group_name_h-m_alt','_symmetry_space_group_name_h-m','_space_group_name_hall','_parent_space_group.name_h-m_alt','_parent_space_group_name_h-m_alt']) || '';
  const spaceGroupNumber=parseCifNumber(firstScalar(scalar,['_space_group_it_number','_symmetry_int_tables_number','_parent_space_group.it_number','_parent_space_group_it_number']),NaN);
  const name=firstScalar(scalar,['_chemical_name_common','_chemical_name_mineral']) || formula || doc.dataName || 'CIF structure';
  return {
    name:String(name), formula:String(formula), spaceGroup:String(spaceGroup),
    spaceGroupNumber:Number.isFinite(spaceGroupNumber)?spaceGroupNumber:null, dataName:doc.dataName,
    lattice, atoms, asymmetricSites,
    magnetic:!!magneticOps||!!momentLoop||fourierInfo.byLabel.size>0,
    incommensurateSingleQ:!!fourierInfo.supported,
    propagationVectors:fourierInfo.q ? [{id:'q1',h:fourierInfo.q[0],k:fourierInfo.q[1],l:fourierInfo.q[2]}] : [],
    symmetryOperationCount:superspaceOps?.length||magneticOps?.length||symops.length,
    asymmetricSiteCount:asymmetricSites.length, warnings
  };
}

export function unitCellVolumeA3(lattice){
  if(!lattice) return NaN;
  const a=Number(lattice.a), b=Number(lattice.b), c=Number(lattice.c);
  const alpha=Number(lattice.alpha)*Math.PI/180;
  const beta=Number(lattice.beta)*Math.PI/180;
  const gamma=Number(lattice.gamma)*Math.PI/180;
  if(![a,b,c,alpha,beta,gamma].every(Number.isFinite) || !(a>0&&b>0&&c>0)) return NaN;
  const ca=Math.cos(alpha), cb=Math.cos(beta), cg=Math.cos(gamma);
  const factor=1+2*ca*cb*cg-ca*ca-cb*cb-cg*cg;
  return factor>0 ? a*b*c*Math.sqrt(factor) : NaN;
}

function energyDependentComplexBAtWavelength(rec,wavelengthA){
  const pts=rec?.energy_dependent_b_fm?.points_energy_eV_re_im;
  const lambda=Number(wavelengthA);
  if(!Array.isArray(pts) || pts.length<2 || !(lambda>0)) return null;
  // Match periodictable/NCNR: convert the tabulated energies to wavelength,
  // linearly interpolate b(lambda), and use constant values beyond the ends.
  const rows=pts.map(p=>{
    const e=Number(p[0]), re=Number(p[1]), im=Number(p[2]);
    return {lambda:0.286014369/Math.sqrt(e),re,im};
  }).filter(p=>[p.lambda,p.re,p.im].every(Number.isFinite)).sort((a,b)=>a.lambda-b.lambda);
  if(!rows.length) return null;
  // Outside the tabulated resonance range, fall back to the standard 1/v
  // absorption scaling rather than freezing the nearest resonance value.
  if(lambda<rows[0].lambda || lambda>rows[rows.length-1].lambda) return null;
  for(let i=1;i<rows.length;i++){
    const a=rows[i-1], b=rows[i];
    if(lambda<=b.lambda){
      const t=(lambda-a.lambda)/(b.lambda-a.lambda);
      return {re:a.re+t*(b.re-a.re),im:a.im+t*(b.im-a.im)};
    }
  }
  return null;
}

export function absorptionCrossSectionBarn(element,wavelengthA){
  const rec=neutronDataRecord(element);
  const sigma0=Number(rec?.sigma_absorption_2200_barn);
  const lambda=Number(wavelengthA);
  if(!(lambda>0)) return NaN;
  const bEnergy=energyDependentComplexBAtWavelength(rec,lambda);
  if(bEnergy && Number.isFinite(bEnergy.im)){
    // periodictable/NCNR convention: sigma_a[barn] = -2 lambda[A] Im(b)[fm] * 1000.
    return Math.max(0,-2*lambda*bEnergy.im*1000);
  }
  if(!(sigma0>=0)) return NaN;
  // Ordinary nuclei: standard 1/v approximation from the 2200 m/s value.
  return sigma0*(lambda/1.798);
}

export function coherentCrossSectionBarn(element){
  const rec=neutronDataRecord(element);
  const sigma=Number(rec?.sigma_coherent_barn);
  return sigma>=0 ? sigma : NaN;
}

export function incoherentCrossSectionBarn(element){
  const rec=neutronDataRecord(element);
  const sigma=Number(rec?.sigma_incoherent_barn);
  return sigma>=0 ? sigma : NaN;
}

export function scatteringCrossSectionBarn(element){
  const rec=neutronDataRecord(element);
  const sigma=Number(rec?.sigma_scattering_barn);
  return sigma>=0 ? sigma : NaN;
}

export function neutronAbsorptionSummary(structure,wavelengthA,thicknessCm=0){
  const volumeA3=unitCellVolumeA3(structure?.lattice);
  const lambda=Number(wavelengthA), thickness=Number(thicknessCm);
  if(!(volumeA3>0)) throw new Error('A valid CIF unit-cell volume is required for attenuation calculation.');
  if(!(lambda>0)) throw new Error('A positive neutron wavelength is required for attenuation calculation.');
  if(!(thickness>=0)) throw new Error('Sample thickness must be zero or positive.');
  if(!structure?.atoms?.length) throw new Error('A CIF structure with atom sites is required for attenuation calculation.');

  // Match the NCNR/periodictable compound convention:
  //   1) absorption is additive over atoms;
  //   2) total bound scattering is additive over atoms;
  //   3) compound coherent scattering is computed from the occupancy-weighted
  //      mean coherent scattering length, not by summing atomic sigma_coh;
  //   4) compound incoherent scattering is total scattering - coherent.
  // This distinction matters for compounds containing species with very
  // different/sign-changing b_c (e.g. NiTiO3).
  const byElement=new Map();
  let sigmaAbsCellBarn=0, sigmaScatCellBarn=0, atomCount=0;
  let sumBReFm=0, sumBImFm=0;
  const missingAbs=new Set(), missingScat=new Set(), missingB=new Set();
  let resonanceCaution=false;

  for(const atom of structure.atoms){
    const element=String(atom.element||'');
    const occupancy=Number(atom.occupancy);
    const occ=Number.isFinite(occupancy)?occupancy:1;
    const rec=neutronDataRecord(element);
    const sigmaAbs=absorptionCrossSectionBarn(element,lambda);
    const sigmaScat=scatteringCrossSectionBarn(element);
    const bEnergy=energyDependentComplexBAtWavelength(rec,lambda);
    const b0=NEUTRON_B_FM[element];
    const bRe=Number(bEnergy?.re ?? b0?.[0]);
    const bIm=Number(bEnergy?.im ?? b0?.[1] ?? 0);
    if(!Number.isFinite(sigmaAbs)){ missingAbs.add(element||'?'); continue; }
    if(!Number.isFinite(sigmaScat)){ missingScat.add(element||'?'); continue; }
    if(!Number.isFinite(bRe) || !Number.isFinite(bIm)){ missingB.add(element||'?'); continue; }

    const sigmaCohElement=coherentCrossSectionBarn(element);
    const sigmaIncohElement=incoherentCrossSectionBarn(element);
    const absContribution=occ*sigmaAbs;
    const scatContribution=occ*sigmaScat;
    const cohContribution=Number.isFinite(sigmaCohElement)?occ*sigmaCohElement:NaN;
    const incohContribution=Number.isFinite(sigmaIncohElement)?occ*sigmaIncohElement:NaN;
    sigmaAbsCellBarn+=absContribution;
    sigmaScatCellBarn+=scatContribution;
    atomCount+=occ;
    sumBReFm+=occ*bRe;
    sumBImFm+=occ*bIm;
    resonanceCaution=resonanceCaution || !!rec?.resonance_caution;

    const row=byElement.get(element)||{
      element,count:0,
      sigmaAbsBarn:sigmaAbs,sigmaCohBarn:sigmaCohElement,sigmaIncohBarn:sigmaIncohElement,sigmaScatBarn:sigmaScat,
      absContributionBarn:0,cohContributionBarn:0,incohContributionBarn:0,scatContributionBarn:0,
      resonanceCaution:!!rec?.resonance_caution
    };
    row.count+=occ;
    row.absContributionBarn+=absContribution;
    if(Number.isFinite(cohContribution)) row.cohContributionBarn+=cohContribution;
    if(Number.isFinite(incohContribution)) row.incohContributionBarn+=incohContribution;
    row.scatContributionBarn+=scatContribution;
    byElement.set(element,row);
  }
  if(missingAbs.size) throw new Error(`No absorption cross section is available for CIF atom type(s): ${[...missingAbs].join(', ')}`);
  if(missingScat.size) throw new Error(`No total scattering cross section is available for CIF atom type(s): ${[...missingScat].join(', ')}`);
  if(missingB.size) throw new Error(`No coherent scattering length is available for CIF atom type(s): ${[...missingB].join(', ')}`);
  if(!(atomCount>0)) throw new Error('No occupied atom sites are available for attenuation calculation.');

  const meanBRe=sumBReFm/atomCount;
  const meanBIm=sumBImFm/atomCount;
  const sigmaCohPerAtomBarn=4*Math.PI*(meanBRe*meanBRe+meanBIm*meanBIm)/100;
  const sigmaCohCellBarn=atomCount*sigmaCohPerAtomBarn;
  const sigmaIncohCellBarn=Math.max(0,sigmaScatCellBarn-sigmaCohCellBarn);
  const sigmaAttenuationCellBarn=sigmaAbsCellBarn+sigmaIncohCellBarn;
  const sigmaFullCellBarn=sigmaAttenuationCellBarn+sigmaCohCellBarn;

  // barn / A^3 = cm^-1 because 1 barn = 1e-24 cm^2 and 1 A^3 = 1e-24 cm^3.
  const muAbsCmInv=sigmaAbsCellBarn/volumeA3;
  const muCohCmInv=sigmaCohCellBarn/volumeA3;
  const muIncohCmInv=sigmaIncohCellBarn/volumeA3;
  const muScatCmInv=sigmaScatCellBarn/volumeA3;
  const muAttenuationCmInv=muAbsCmInv+muIncohCmInv;
  const muFullCmInv=muAttenuationCmInv+muCohCmInv;
  const muTotalCmInv=muAttenuationCmInv; // compatibility alias for UI/transmission

  const absorptionLengthCm=muAbsCmInv>0 ? 1/muAbsCmInv : Infinity;
  const attenuationLengthCm=muAttenuationCmInv>0 ? 1/muAttenuationCmInv : Infinity;
  const fullLengthCm=muFullCmInv>0 ? 1/muFullCmInv : Infinity;
  const coherentLengthCm=muCohCmInv>0 ? 1/muCohCmInv : Infinity;
  const incoherentLengthCm=muIncohCmInv>0 ? 1/muIncohCmInv : Infinity;
  const transmissionAbsorptionOnly=Math.exp(-muAbsCmInv*thickness);
  const transmission=Math.exp(-muAttenuationCmInv*thickness);

  return {
    wavelengthA:lambda, thicknessCm:thickness, volumeA3, atomCount,
    meanBReFm:meanBRe,meanBImFm:meanBIm,
    sigmaCellBarn:sigmaAbsCellBarn,
    sigmaAbsCellBarn,sigmaCohCellBarn,sigmaIncohCellBarn,sigmaScatCellBarn,
    sigmaAttenuationCellBarn,sigmaFullCellBarn,
    muAbsCmInv,muCohCmInv,muIncohCmInv,muScatCmInv,muAttenuationCmInv,muFullCmInv,muTotalCmInv,
    absorptionLengthCm,coherentLengthCm,incoherentLengthCm,attenuationLengthCm,fullLengthCm,
    transmissionAbsorptionOnly,transmission,resonanceCaution,
    elements:[...byElement.values()].sort((a,b)=>(b.absContributionBarn+b.scatContributionBarn)-(a.absContributionBarn+a.scatContributionBarn))
  };
}

export function nuclearStructureFactorSquared(structure,hkl,qNorm=0){
  if(!structure?.atoms?.length) return NaN;
  const [h,k,l]=hkl.map(Number);
  let re=0, im=0;
  const q2=Number.isFinite(Number(qNorm)) ? Number(qNorm)*Number(qNorm) : 0;
  const rlen=reciprocalLengths(structure.lattice);
  for(const a of structure.atoms){
    let dw;
    if(a.Uaniso && rlen){
      const g=[h*rlen[0],k*rlen[1],l*rlen[2]];
      let quad=0;
      for(let i=0;i<3;i++) for(let j=0;j<3;j++) quad+=g[i]*a.Uaniso[i][j]*g[j];
      dw=Math.exp(-2*Math.PI*Math.PI*quad);
    }else{
      dw=Math.exp(-(Number(a.Biso)||0)*q2/SIXTEEN_PI2);
    }
    const amp=(Number(a.occupancy)||0)*dw;
    const phase=TWO_PI*(h*a.x+k*a.y+l*a.z);
    const c=Math.cos(phase), s=Math.sin(phase);
    // (bRe+i bIm)*(c+i s)
    re+=amp*(a.bRe*c-a.bIm*s);
    im+=amp*(a.bRe*s+a.bIm*c);
  }
  return re*re+im*im;
}
