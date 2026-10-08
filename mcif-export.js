// Commensurate magnetic structure exporter. The displayed spins, not the
// parent crystallographic space group, determine the retained magnetic group.
import {parseCifDocument, parseCifStructure} from './cif-structure.js';

const wrap=x=>((x%1)+1)%1;
const near=(a,b,tol=2e-5)=>Math.abs(a-b)<=tol;
const nearFrac=(a,b,tol=2e-5)=>Math.abs(wrap(a-b+0.5)-0.5)<=tol;
const det=R=>R[0][0]*(R[1][1]*R[2][2]-R[1][2]*R[2][1])-R[0][1]*(R[1][0]*R[2][2]-R[1][2]*R[2][0])+R[0][2]*(R[1][0]*R[2][1]-R[1][1]*R[2][0]);
const matVec=(R,v)=>R.map(r=>r.reduce((s,a,j)=>s+a*v[j],0));
const matMult=(A,B)=>A.map(r=>B[0].map((_,j)=>r.reduce((s,x,k)=>s+x*B[k][j],0)));
const fracKey=p=>p.map(v=>Math.round(wrap(v)*1e6)%1000000).join(',');
const clean=n=>Math.abs(n)<1e-10?0:Number(n.toFixed(9));
function parseNumber(raw){
  const str=String(raw??'').trim();
  const parts=str.split('/');
  if(parts.length===2)return Number(parts[0])/Number(parts[1]);
  return Number(str);
}
function parseLinear(expr){
  const R=[0,0,0]; let t=0;
  const terms=String(expr).toLowerCase().replace(/\s/g,'').replace(/-/g,'+-').replace(/^\+/,'').split('+').filter(Boolean);
  for(const term of terms){
    const m=term.match(/[xyz]/);
    if(m){const i='xyz'.indexOf(m[0]);const c=term.replace(m[0],''); R[i]+=c===''?1:c==='-'?-1:parseNumber(c);}
    else t+=parseNumber(term);
  }
  if(![...R,t].every(Number.isFinite))throw new Error(`Invalid symmetry expression: ${expr}`);
  return {R,t};
}
function parseSpatialOperations(source, fallback=[]){
  const doc=parseCifDocument(source);
  const names=['_space_group_symop_operation_xyz','_symmetry_equiv_pos_as_xyz'];
  let entries=[];
  for(const loop of doc.loops){const name=names.find(n=>loop.tags.includes(n));if(name){entries=loop.rows.map(r=>r[name]);break;}}
  if(!entries.length){for(const name of names) if(doc.scalar[name]){entries=[doc.scalar[name]];break;}}
  if(!entries.length) entries=fallback.length?fallback:['x,y,z'];
  const out=[];
  for(const entry of entries){
    const p=String(entry).split(','); if(p.length!==3)continue;
    try{const parts=p.map(parseLinear);const R=parts.map(x=>x.R),t=parts.map(x=>x.t);if(Math.abs(det(R))!==1)continue;out.push({R,t});}catch(_e){}
  }
  if(!out.some(op=>op.R.every((r,i)=>r.every((x,j)=>x===(i===j?1:0)))&&op.t.every(x=>nearFrac(x,0)))) out.unshift({R:[[1,0,0],[0,1,0],[0,0,1]],t:[0,0,0]});
  return out;
}
export function rationalApprox(q,maxDenom=16,tol=0.007){
  let best=null;
  for(let d=1;d<=maxDenom;d++){
    const n=Math.round(q*d),err=Math.abs(q-n/d);
    if(err<=tol && (!best||d<best.d||d===best.d&&err<best.err))best={n,d,err};
  }
  if(!best) throw new Error(`k=${q} cannot be approximated with denominator <=${maxDenom} (tolerance ${tol}).`);
  return best;
}
function fmt(x){
  const n=clean(x);
  for(let d=1;d<=192;d++){const p=Math.round(n*d);if(Math.abs(n-p/d)<1e-8)return d===1?String(p):`${p}/${d}`;}
  return String(n);
}
function opText(op){
  const expr=op.R.map((row,i)=>{
    let s='';
    row.forEach((c,j)=>{if(Math.abs(c)<1e-10)return;const tok=`${Math.abs(c)===1?'':fmt(Math.abs(c))}${'xyz'[j]}`;s+=(c<0?'-':s?'+':'')+tok;});
    const shift=wrap(op.t[i]);
    if(Math.abs(shift)>1e-9)s+=(s?'+':'')+fmt(shift);
    return s||'0';
  });
  return `${expr.join(',')},${op.parity}`;
}
function spinMatch(a,b,tol=0.0002){return a.every((x,i)=>near(x,b[i],tol*Math.max(1,Math.abs(x),Math.abs(b[i]))));}
function findSite(sites,pos,element,occ){
  return sites.findIndex(s=>s.element===element && near(s.occupancy,occ,1e-5) && s.pos.every((v,i)=>nearFrac(v,pos[i])));
}
function validOperation(sites,op){
  const factor=op.parity*det(op.R);
  for(const s of sites){
    const to=matVec(op.R,s.pos).map((v,i)=>wrap(v+op.t[i]));
    const idx=findSite(sites,to,s.element,s.occupancy);
    if(idx<0 || !spinMatch(matVec(op.R,s.moment).map(x=>x*factor),sites[idx].moment))return false;
  }
  return true;
}
function basis(l){
  const a=Number(l.a),b=Number(l.b),c=Number(l.c),alpha=l.alpha*Math.PI/180,beta=l.beta*Math.PI/180,gamma=l.gamma*Math.PI/180;
  const A=[a,0,0],B=[b*Math.cos(gamma),b*Math.sin(gamma),0];
  const cx=c*Math.cos(beta),cy=c*(Math.cos(alpha)-Math.cos(beta)*Math.cos(gamma))/Math.sin(gamma);
  return [A,B,[cx,cy,Math.sqrt(Math.max(0,c*c-cx*cx-cy*cy))]];
}
function toCrystal(cart,l){
  const [A,B,C]=basis(l).map(v=>{const len=Math.hypot(...v);return v.map(x=>x/len);});
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  const volume=dot(A,cross(B,C));
  if(Math.abs(volume)<1e-10)throw new Error('Invalid cell metric.');
  return [dot(cart,cross(B,C)),dot(cart,cross(C,A)),dot(cart,cross(A,B))].map(x=>x/volume);
}
function fromCrystal(crystal,l){const v=basis(l).map(b=>{const n=Math.hypot(...b);return b.map(x=>x/n);});return [0,1,2].map(i=>v.reduce((s,col,j)=>s+col[i]*crystal[j],0));}
function latticeText(l){return ['a','b','c','alpha','beta','gamma'].map(k=>`_cell_${k.startsWith('angle')?'':'length_'}${k} ${fmt(l[k])}`);}
function catalogOps(sites,parentOps,N){
  const candidates=[];
  const unique=new Set();
  for(const parent of parentOps){
    const R=parent.R.map((row,i)=>row.map((x,j)=>x*N[j]/N[i]));
    if(R.some(row=>row.some(x=>!near(x,Math.round(x),1e-8))))continue;
    const t0=parent.t.map((v,i)=>v/N[i]);
    const seed=sites[0];
    for(const match of sites){
      if(match.element!==seed.element || !near(match.occupancy,seed.occupancy,1e-5))continue;
      const Rpos=matVec(R,seed.pos);
      const t=match.pos.map((v,i)=>wrap(v-Rpos[i]));
      for(const parity of [1,-1]){
        const op={R,t,parity};const key=R.flat().join(',')+';'+t.map(x=>Math.round(x*1e7)).join(',')+';'+parity;
        if(unique.has(key))continue; unique.add(key);
        if(validOperation(sites,op))candidates.push(op);
      }
    }
  }
  // Always include identity, even when the CIF omits its operation loop.
  if(!candidates.some(o=>o.parity===1&&o.R.every((r,i)=>r.every((x,j)=>near(x,i===j?1:0)))&&o.t.every(t=>nearFrac(t,0)))) candidates.unshift({R:[[1,0,0],[0,1,0],[0,0,1]],t:[0,0,0],parity:1});
  return candidates;
}
export function exportCommensurateMcif({source,structure,settings,individualSettings=null,q=[0,0,0],mode='collinear',axis=[0,0,1],chirality='CCW',fallbackOperations=[]}){
  if(structure?.magnetic)throw new Error('For an imported mCIF use the existing moment-update export.');
  if(!Array.isArray(structure?.atoms)||!structure.atoms.length)throw new Error('CIF atomic sites are missing.');
  if(!Array.isArray(q)||q.length!==3||q.some(x=>!Number.isFinite(x)))throw new Error('Invalid propagation vector.');
  const approx=q.map(v=>rationalApprox(v));
  const N=approx.map(p=>p.d);
  const size=N.reduce((a,b)=>a*b,1);
  if(size>128||structure.atoms.length*size>12000)throw new Error(`Magnetic supercell (${N.join(' x ')}) is too large for safe export.`);
  const lattice={...structure.lattice,a:structure.lattice.a*N[0],b:structure.lattice.b*N[1],c:structure.lattice.c*N[2]};
  const norm=Math.hypot(...axis);
  const u=norm>1e-10?axis.map(x=>x/norm):[0,0,1];
  const rotate=(v,angle)=>{
    const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const dot=u.reduce((s,x,i)=>s+x*v[i],0),c=Math.cos(angle),s=Math.sin(angle);
    return v.map((x,i)=>x*c+cross[i]*s+u[i]*dot*(1-c));
  };
  const sites=[];
  const chosen=q.map((v,i)=>approx[i].n/approx[i].d);
  for(let ix=0;ix<N[0];ix++)for(let iy=0;iy<N[1];iy++)for(let iz=0;iz<N[2];iz++){
    for(const [atomIndex,atom] of structure.atoms.entries()){
      const individual=individualSettings?.[`${ix},${iy},${iz}:${atomIndex}`];
      if(individualSettings && !individual) throw new Error(`Missing individual spin for atom ${atomIndex} in cell (${ix},${iy},${iz}).`);
      const setting=individualSettings ? individual : (settings[atom.sourceSiteIndex]||{enabled:false,mx:0,my:0,mz:0});
      const pos0=[atom.x+ix,atom.y+iy,atom.z+iz];
      const pos=pos0.map((v,i)=>wrap(v/N[i]));
      const phase=2*Math.PI*chosen.reduce((s,k,i)=>s+k*pos0[i],0);
      let moment=setting.enabled?[setting.mx,setting.my,setting.mz].map(Number):[0,0,0];
      if(moment.some(v=>!Number.isFinite(v)))throw new Error(`Invalid moment for ${atom.sourceLabel}.`);
      if(setting.enabled && !individualSettings){
        if(mode==='helical')moment=rotate(moment,(chirality==='CW'?1:-1)*phase);
        else if(mode==='sinusoidal')moment=moment.map(v=>v*Math.cos(phase));
        else if(Math.cos(phase)<0)moment=moment.map(v=>-v);
      }
      sites.push({pos,element:atom.element,occupancy:atom.occupancy,moment:toCrystal(moment,lattice),sourceLabel:atom.sourceLabel});
    }
  }
  // Merge duplicate crystallographic atoms; reject incompatible spin assignments.
  const dedup=[];
  for(const s of sites){
    const ix=findSite(dedup,s.pos,s.element,s.occupancy);
    if(ix>=0){if(!spinMatch(dedup[ix].moment,s.moment))throw new Error(`Conflicting moments at overlapping ${s.element} site. Reduce the input symmetry or use per-atom moment settings.`);}
    else dedup.push(s);
  }
  const ops=catalogOps(dedup,parseSpatialOperations(source,fallbackOperations),N);
  const seen=new Set(),reps=[];
  for(let i=0;i<dedup.length;i++){
    if(seen.has(i))continue;
    const site=dedup[i];reps.push(site);
    for(const op of ops){const pos=matVec(op.R,site.pos).map((v,j)=>wrap(v+op.t[j]));const k=findSite(dedup,pos,site.element,site.occupancy);if(k>=0)seen.add(k);}
  }
  const lines=[`data_generated_magnetic_structure`, '# Commensurate magnetic supercell generated from user-entered moments.', '# Magnetic symmetry operators were checked against every decorated atomic site.',`# Original k: ${q.join(' ')}`,
    `_cell_length_a ${fmt(lattice.a)}` ,`_cell_length_b ${fmt(lattice.b)}` ,`_cell_length_c ${fmt(lattice.c)}`,
    `_cell_angle_alpha ${fmt(lattice.alpha)}`,`_cell_angle_beta ${fmt(lattice.beta)}`,`_cell_angle_gamma ${fmt(lattice.gamma)}`,
    "_space_group_magn.name_BNS '?'",'', 'loop_', '_parent_propagation_vector.id', '_parent_propagation_vector.kxkykz', `k1 '[${q.map(fmt).join(' ')}]'`, '',
    'loop_','_space_group_symop_magn_operation.id','_space_group_symop_magn_operation.xyz',...ops.map((o,i)=>`${i+1} '${opText(o)}'`),'',
    'loop_','_atom_site_label','_atom_site_type_symbol','_atom_site_fract_x','_atom_site_fract_y','_atom_site_fract_z','_atom_site_occupancy'];
  reps.forEach((s,i)=>lines.push(`A${i+1} ${s.element} ${s.pos.map(fmt).join(' ')} ${fmt(s.occupancy)}`));
  lines.push('','loop_','_atom_site_moment.label','_atom_site_moment.crystalaxis_x','_atom_site_moment.crystalaxis_y','_atom_site_moment.crystalaxis_z');
  reps.forEach((s,i)=>{if(s.moment.some(x=>Math.abs(x)>1e-8))lines.push(`A${i+1} ${s.moment.map(fmt).join(' ')}`);});
  const text=lines.join('\n')+'\n';
  const check=parseCifStructure(text);
  if(check.atoms.length!==dedup.length)throw new Error(`Export round-trip failed: expected ${dedup.length} atoms, parsed ${check.atoms.length}.`);
  for(const site of dedup){
    const found=check.atoms.find(a=>a.element===site.element&&near(a.occupancy,site.occupancy,1e-5)&&site.pos.every((v,i)=>nearFrac(v,[a.x,a.y,a.z][i])));
    if(!found)throw new Error(`Export round-trip failed: ${site.element} atomic coordinate was lost.`);
    const moment=found.magneticMoment||[0,0,0];
    if(!spinMatch(moment,site.moment,0.0003))throw new Error(`Export round-trip failed: magnetic moment mismatch at ${site.element}.`);
  }
  return {text,supercell:N,approximatedQ:chosen,atomCount:dedup.length,representatives:reps.length,operationCount:ops.length};
}
