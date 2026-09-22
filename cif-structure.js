// CIF parser + neutron nuclear structure-factor utilities.
// Natural-element bound coherent neutron scattering lengths are based on the
// NIST/NCNR table: https://www.ncnr.nist.gov/resources/n-lengths/list.html
// Units: fm.  Complex values include the absorptive imaginary component.

const TWO_PI=2*Math.PI;
const EIGHT_PI2=8*Math.PI*Math.PI;
const SIXTEEN_PI2=16*Math.PI*Math.PI;

// [real, imaginary] coherent bound scattering length in fm.
// Values are for the natural isotopic composition unless an isotope is named.
export const NEUTRON_B_FM=Object.freeze({
  H:[-3.7390,0], D:[6.671,0], '2H':[6.671,0], He:[3.26,0], Li:[-1.90,0], Be:[7.79,0], B:[5.30,-0.213],
  C:[6.6460,0], N:[9.36,0], O:[5.803,0], F:[5.654,0], Ne:[4.566,0], Na:[3.63,0], Mg:[5.375,0], Al:[3.449,0],
  Si:[4.1491,0], P:[5.13,0], S:[2.847,0], Cl:[9.5770,0], Ar:[1.909,0], K:[3.67,0], Ca:[4.70,0], Sc:[12.29,0],
  Ti:[-3.438,0], V:[-0.3824,0], Cr:[3.635,0], Mn:[-3.73,0], Fe:[9.45,0], Co:[2.49,0], Ni:[10.3,0], Cu:[7.718,0],
  Zn:[5.680,0], Ga:[7.288,0], Ge:[8.185,0], As:[6.58,0], Se:[7.970,0], Br:[6.795,0], Kr:[7.81,0], Rb:[7.09,0],
  Sr:[7.02,0], Y:[7.75,0], Zr:[7.16,0], Nb:[7.054,0], Mo:[6.715,0], Tc:[6.8,0], Ru:[7.03,0], Rh:[5.88,0],
  Pd:[5.91,0], Ag:[5.922,0], Cd:[4.87,-0.70], In:[4.065,-0.0539], Sn:[6.225,0], Sb:[5.57,0], Te:[5.80,0], I:[5.28,0],
  Xe:[4.92,0], Cs:[5.42,0], Ba:[5.07,0], La:[8.24,0], Ce:[4.84,0], Pr:[4.58,0], Nd:[7.69,0], Pm:[12.6,0],
  Sm:[0.80,-1.65], Eu:[7.22,-1.26], Gd:[6.5,-13.82], Tb:[7.38,0], Dy:[16.9,-0.276], Ho:[8.01,0], Er:[7.79,0],
  Tm:[7.07,0], Yb:[12.43,0], Lu:[7.21,0], Hf:[7.7,0], Ta:[6.91,0], W:[4.86,0], Re:[9.2,0], Os:[10.7,0],
  Ir:[10.6,0], Pt:[9.60,0], Au:[7.63,0], Hg:[12.692,0], Tl:[8.776,0], Pb:[9.405,0], Bi:[8.532,0],
  Ra:[10.0,0], Th:[10.31,0], Pa:[9.1,0], U:[8.417,0]
});

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
  const symops=findSymmetryOperations(doc);
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
  const atoms=[], asymmetricSites=[], missing=new Set(), invalidSites=[], warnings=[];

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
    asymmetricSites.push({label:siteLabel,element,x:xyz[0],y:xyz[1],z:xyz[2],occupancy});
    let Biso=parseCifNumber(row['_atom_site_b_iso_or_equiv'],NaN);
    if(!Number.isFinite(Biso)){
      const Uiso=parseCifNumber(row['_atom_site_u_iso_or_equiv'],NaN);
      Biso=Number.isFinite(Uiso)?EIGHT_PI2*Uiso:0;
    }
    const label=String(row['_atom_site_label'] ?? '').trim();
    const U0=anisoByLabel.get(label) || null;
    const unique=new Map();
    for(const op of symops){
      const p=applySymmetryOperation(op,xyz);
      const key=positionKey(p);
      if(!unique.has(key)){
        const R=symmetryRotationMatrix(op);
        unique.set(key,{p,U:U0?transformSymmetricTensor(U0,R):null});
      }
    }
    for(const item of unique.values()) atoms.push({
      element, occupancy:Number.isFinite(occupancy)?occupancy:1,
      Biso:Number.isFinite(Biso)?Biso:0, Uaniso:item.U,
      x:item.p[0],y:item.p[1],z:item.p[2], bRe:b[0],bIm:b[1]
    });
  }

  if(missing.size) throw new Error(`No neutron coherent scattering length is available for CIF atom type(s): ${[...missing].join(', ')}`);
  if(invalidSites.length) throw new Error(`CIF atom site(s) could not be loaded because coordinates or occupancy are invalid: ${invalidSites.join(', ')}`);
  if(!atoms.length) throw new Error('CIF atom sites could not be expanded into a crystal structure.');
  if(symops.length===1 && String(symops[0]).replace(/\s/g,'').toLowerCase()==='x,y,z') warnings.push('No symmetry-operation loop was found; identity symmetry only was used.');

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
  const spaceGroup=firstScalar(scalar,['_space_group_name_h-m_alt','_symmetry_space_group_name_h-m','_space_group_name_hall']) || '';
  const spaceGroupNumber=parseCifNumber(firstScalar(scalar,['_space_group_it_number','_symmetry_int_tables_number']),NaN);
  const name=firstScalar(scalar,['_chemical_name_common','_chemical_name_mineral']) || formula || doc.dataName || 'CIF structure';
  return {
    name:String(name), formula:String(formula), spaceGroup:String(spaceGroup),
    spaceGroupNumber:Number.isFinite(spaceGroupNumber)?spaceGroupNumber:null, dataName:doc.dataName,
    lattice, atoms, asymmetricSites, symmetryOperationCount:symops.length, asymmetricSiteCount:asymmetricSites.length, warnings
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
