import {computeMagneticFormFactor, magneticIonConfigurations} from './magnetic-form-factor.js';
// Bragg intensities from a fully specified COMMENSURATE magnetic motif.
// Intensity is the unpolarized magnetic structure factor in barn per magnetic
// cell, excluding scale, Lorentz, absorption, extinction and form-factor terms.
export const MAGNETIC_BRAGG_CONSTANT_BARN = 0.07265; // (gamma*r0/2)^2
const twopi=2*Math.PI;
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>Math.hypot(...a);
const unit=a=>{const n=norm(a);return n>1e-12?a.map(x=>x/n):[0,0,0];};
const plus=(a,b)=>a.map((x,i)=>x+b[i]);
const times=(a,s)=>a.map(x=>x*s);
function rotate(v,axis,angle){const u=unit(axis),c=Math.cos(angle),s=Math.sin(angle);return plus(plus(times(v,c),times(cross(u,v),s)),times(u,dot(u,v)*(1-c)));}
export function latticeVectors(l){
  const [a,b,c]=[l.a,l.b,l.c].map(Number);
  const [alpha,beta,gamma]=[l.alpha,l.beta,l.gamma].map(x=>Number(x)*Math.PI/180);
  const ca=Math.cos(alpha), cb=Math.cos(beta), cg=Math.cos(gamma), sg=Math.sin(gamma);
  if(!(a>0&&b>0&&c>0&&Math.abs(sg)>1e-9))throw Error('Invalid magnetic cell.');
  const A=[a,0,0],B=[b*cg,b*sg,0],cx=c*cb,cy=c*(ca-cb*cg)/sg;
  const cz2=c*c-cx*cx-cy*cy;
  if(!(cz2>0))throw Error('Invalid magnetic lattice geometry.');
  return [A,B,[cx,cy,Math.sqrt(cz2)]];
}
export function cartesianMoment(crystalAxis,lattice){
  const axes=latticeVectors(lattice).map(unit);
  return crystalAxis.reduce((v,x,i)=>plus(v,times(axes[i],Number(x)||0)),[0,0,0]);
}
function reciprocalBasis(lattice){
  const [a,b,c]=latticeVectors(lattice);
  const vol=dot(a,cross(b,c));
  return [times(cross(b,c),twopi/vol),times(cross(c,a),twopi/vol),times(cross(a,b),twopi/vol)];
}
export function reciprocalVector(lattice,hkl){
  const B=reciprocalBasis(lattice);
  return hkl.reduce((v,x,i)=>plus(v,times(B[i],x)),[0,0,0]);
}
// Finite supercell for k=(n1/d1,n2/d2,n3/d3). Strict rational check
// avoids silently replacing a genuinely incommensurate modulation.
export function rationalDenominator(value,max=24,tol=1e-8){
  const v=Number(value);
  if(!Number.isFinite(v))throw Error('Invalid propagation-vector component.');
  for(let d=1;d<=max;d++)if(Math.abs(v*d-Math.round(v*d))<=tol*d)return d;
  throw Error('Incommensurate k is not supported in the finite-cell Bragg calculator.');
}
export function buildMagneticMotif({structure,settings=new Map(),q=[0,0,0],mode='collinear',axis='c',chirality='CCW',imported=false,maxAtoms=1500}){
  if(!structure?.atoms?.length)throw Error('No atomic structure loaded.');
  if(structure.incommensurateSingleQ || structure.atoms.some(a=>a.magneticFourier))
    throw Error('Fourier-modulated mCIF requires a dedicated satellite structure-factor calculation (not implemented).');
  const dims=imported?[1,1,1]:q.map(v=>rationalDenominator(v));
  const size=dims.reduce((a,b)=>a*b,1)*structure.atoms.length;
  if(size>maxAtoms)throw Error(`Magnetic supercell would contain ${size} atoms (limit ${maxAtoms}).`);
  const parentBasis=latticeVectors(structure.lattice);
  const rotAxis=parentBasis[['a','b','c'].indexOf(axis)]||parentBasis[2];
  const sites=[];
  for(let ix=0;ix<dims[0];ix++)for(let iy=0;iy<dims[1];iy++)for(let iz=0;iz<dims[2];iz++){
    for(const atom of structure.atoms){
      const p=[atom.x+ix,atom.y+iy,atom.z+iz];
      const key=`${atom.sourceSiteIndex}:${structure.asymmetricSites?.[atom.sourceSiteIndex]?.label||atom.sourceLabel||atom.element}`;
      const s=settings.get(key);
      let m;
      if(imported){
        m=Array.isArray(atom.magneticMoment)?cartesianMoment(atom.magneticMoment,structure.lattice):[0,0,0];
      }else{
        m=(s?.enabled && [s.mx,s.my,s.mz].every(Number.isFinite))?[s.mx,s.my,s.mz]:[0,0,0];
        const phase=twopi*dot(q,p);
        if(mode==='helical')m=rotate(m,rotAxis,(chirality==='CW'?1:-1)*phase);
        else if(mode==='sinusoidal')m=times(m,Math.cos(phase));
        else if(mode==='collinear')m=times(m,Math.cos(phase)<0?-1:1);
        else throw Error('Unsupported magnetic structure type.');
      }
      sites.push({element:atom.element,occupancy:Number(atom.occupancy??1),
        fract:p.map((x,i)=>x/dims[i]), moment:m,sourceLabel:atom.sourceLabel});
    }
  }
  const lattice={...structure.lattice,a:structure.lattice.a*dims[0],b:structure.lattice.b*dims[1],c:structure.lattice.c*dims[2]};
  return {lattice,sites,replication:dims,source:imported?'mCIF':'Modify',
    caveat:'Dipole approximation; f(Q)=1. No Lorentz, Debye-Waller, absorption, or instrument corrections.'};
}
export function magneticStructureFactorSquared(motif,hkl,{formFactor=()=>1}={}){
  const Q=reciprocalVector(motif.lattice,hkl),q=norm(Q);
  if(!(q>1e-9))return 0;
  const n=Q.map(x=>x/q),re=[0,0,0],im=[0,0,0];
  for(const s of motif.sites){
    if(!s.moment || norm(s.moment)<1e-12)continue;
    const v=plus(s.moment,times(n,-dot(s.moment,n)));
    const ff=Number(formFactor(s.element,q));
    if(!Number.isFinite(ff))throw Error('Invalid magnetic form factor.');
    const amp=(s.occupancy??1)*ff;
    const phase=twopi*dot(hkl,s.fract),c=Math.cos(phase),sn=Math.sin(phase);
    for(let i=0;i<3;i++){re[i]+=amp*v[i]*c;im[i]+=amp*v[i]*sn;}
  }
  return MAGNETIC_BRAGG_CONSTANT_BARN*(dot(re,re)+dot(im,im));
}
// Only use magnetic-ion factors when oxidation states are explicitly known.
// Site labels such as Cu1 are crystallographic labels, NOT Cu+.
export function explicitMagneticIonFactors(cifText){
  const lines=String(cifText||'').split(/\r?\n/);
  const result={};
  for(let i=0;i<lines.length;i++){
    if(lines[i].trim().toLowerCase()!=='loop_')continue;
    const fields=[];let j=i+1;
    while(j<lines.length && lines[j].trim().startsWith('_')){fields.push(lines[j].trim().split(/\s+/)[0].toLowerCase());j++;}
    const symbolColumn=fields.indexOf('_atom_type_symbol');
    const oxColumn=fields.indexOf('_atom_type_oxidation_number');
    if(symbolColumn<0||oxColumn<0)continue;
    for(;j<lines.length;j++){
      const line=lines[j].trim();
      if(!line||line.startsWith('#'))continue;
      if(line==='loop_'||line.startsWith('_')||line.startsWith('data_')||line.startsWith('save_'))break;
      const tokens=line.match(/(?:'[^']*'|"[^"]*"|\S+)/g)||[];
      if(tokens.length<fields.length)continue;
      const element=tokens[symbolColumn].replace(/^['"]|['"]$/g,'').match(/^[A-Z][a-z]?/)?.[0];
      const ox=Number(tokens[oxColumn]);
      if(!element||!Number.isInteger(ox)||ox<0)continue;
      const ion=element+ox;
      if(magneticIonConfigurations(ion).length){
        if(Object.hasOwn(result,element)&&result[element]!==ion)result[element]=null;
        else if(!Object.hasOwn(result,element))result[element]=ion;
      }
    }
  }
  return result;
}
export function magneticIonFormFactor(element,Q,ionByElement={}){
  const symbol=String(element||'').match(/^[A-Z][a-z]?/)?.[0]||'';
  const ion=ionByElement[symbol];
  if(!ion)return 1;
  const configs=magneticIonConfigurations(ion);
  if(!configs.length)return 1;
  return computeMagneticFormFactor(ion,Q,{config:configs[0],j2Weight:0}).f;
}
function magneticFormFactorDisplay(motif,Q,ionByElement){
  const elements=[...new Set(motif.sites.filter(s=>s.moment&&norm(s.moment)>1e-12).map(s=>s.element))].sort();
  if(!elements.length)return {display:'1',sortValue:1};
  const factors=elements.map(element=>({element,ion:ionByElement[element],value:magneticIonFormFactor(element,Q,ionByElement)}));
  if(factors.length===1)return {display:Number(factors[0].value.toFixed(5)).toString(),sortValue:factors[0].value};
  return {display:factors.map(f=>`${f.ion||f.element}: ${Number(f.value.toFixed(4))}`).join('; '),sortValue:factors.reduce((sum,f)=>sum+f.value,0)/factors.length};
}
export function magneticBraggPeaks(motif,wavelength,{twoThetaMax=180,maxCandidates=350000,ionByElement={}}={}){
  const lambda=Number(wavelength);if(!(lambda>0))throw Error('Wavelength must be positive.');
  const qMax=4*Math.PI/lambda, l=motif.lattice;
  const bound=[l.a,l.b,l.c].map(x=>Math.ceil(qMax*Number(x)/(twopi))+2);
  const count=bound.reduce((a,n)=>a*(2*n+1),1);
  if(count>maxCandidates)throw Error(`Too many magnetic hkl candidates (${count}); increase wavelength.`);
  const result=[];
  for(let h=-bound[0];h<=bound[0];h++)for(let k=-bound[1];k<=bound[1];k++)for(let z=-bound[2];z<=bound[2];z++){
    if(!(h||k||z))continue;
    const hkl=[h,k,z],q=norm(reciprocalVector(l,hkl));
    if(!(q>1e-9)||q>qMax+1e-8)continue;
    const theta2=2*Math.asin(Math.min(1,q*lambda/(4*Math.PI)))*180/Math.PI;
    if(theta2>twoThetaMax+1e-8)continue;
    const formFactor=(element,Q)=>magneticIonFormFactor(element,Q,ionByElement);
    const intensity=magneticStructureFactorSquared(motif,hkl,{formFactor});
    if(intensity>1e-12){
      const ff=magneticFormFactorDisplay(motif,q,ionByElement);
      result.push({hkl,q,d:twopi/q,twoTheta:theta2,intensity,formFactor:ff.display,formFactorSort:ff.sortValue});
    }
  }
  const max=Math.max(0,...result.map(r=>r.intensity));
  return result.filter(r=>r.intensity>Math.max(1e-12,max*1e-10)).sort((a,b)=>b.intensity-a.intensity);
}

// Parent indexing for the app's explicitly tagged commensurate supercell exports.
// Generic imported mCIF files may use different cell settings: never infer
// their parent basis from k alone.
export function parentIndexingFromMcif(text, magneticLattice, q){
  const src=String(text||'');
  // Bilbao/standard mCIF with a known parent-cell setting. For identity
  // transforms, the parent and magnetic conventional-cell hkl are identical,
  // even when the magnetic centering includes time reversal (e.g. k=[1,0,0]).
  // Do not mistake the BNS standard-setting transform for this mapping.
  const tag=(name)=>src.split(/\r?\n/).map(line=>line.trim()).find(line=>line.toLowerCase().startsWith(name.toLowerCase()+' '))?.slice(name.length).trim().replace(/^[\"']|[\"']$/g,'');
  const parent=tag('_parent_space_group.transform_Pp_abc');
  const child=tag('_parent_space_group.child_transform_Pp_abc');
  if(/_parent_space_group\.(?:IT_number|name_H-M_alt)/i.test(src) && parent && child &&
     /^a\s*,\s*b\s*,\s*c\s*;\s*0\s*,\s*0\s*,\s*0$/i.test(parent) &&
     /^a\s*,\s*b\s*,\s*c\s*;\s*0\s*,\s*0\s*,\s*0$/i.test(child)){
    return {replication:[1,1,1],lattice:{...magneticLattice},reference:'parent mCIF identity basis'};
  }
  if(!/^# Commensurate magnetic supercell generated from user-entered moments\.\s*$/m.test(src))return null;
  if(!/_parent_space_group\.(?:IT_number|name_H-M_alt)/i.test(src))return null;
  if(!/_parent_propagation_vector\.kxkykz/i.test(src))return null;
  if(!Array.isArray(q)||q.length!==3)return null;
  let dims;
  try { dims=q.map(v=>rationalDenominator(v)); } catch {return null;}
  const lattice={...magneticLattice};
  for(const [i,key] of ['a','b','c'].entries()){
    const length=Number(lattice[key]);
    if(!(length>0))return null;
    lattice[key]=length/dims[i];
  }
  return {replication:dims,lattice,reference:'parent CIF cell (inferred from app-generated supercell)'};
}
export function hklInParentCell(magneticHkl,replication){
  return magneticHkl.map((v,i)=>Number(v)/Number(replication[i]));
}
