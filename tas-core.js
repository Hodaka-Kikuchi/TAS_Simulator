// tas-core.js
// Pure browser-side numerical routines translated from RL_calc.py and UB_calc.py.

export const PI = Math.PI;
export const EPS = 1e-12;

export function deg2rad(x) { return x * PI / 180; }
export function rad2deg(x) { return x * 180 / PI; }
export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

export function add(a,b) { return a.map((x,i)=>x+b[i]); }
export function sub(a,b) { return a.map((x,i)=>x-b[i]); }
export function scale(a,s) { return a.map(x=>x*s); }
export function dot(a,b) { return a.reduce((s,x,i)=>s+x*b[i],0); }
export function norm(a) { return Math.sqrt(dot(a,a)); }
export function cross(a,b) {
  return [
    a[1]*b[2]-a[2]*b[1],
    a[2]*b[0]-a[0]*b[2],
    a[0]*b[1]-a[1]*b[0]
  ];
}
export function normalize(a, message="zero vector") {
  const n = norm(a);
  if (n < EPS) throw new Error(message);
  return scale(a,1/n);
}
export function matVec(M,v) {
  return M.map(row => dot(row,v));
}
export function matMul(A,B) {
  const Bt = B[0].map((_,j)=>B.map(row=>row[j]));
  return A.map(row=>Bt.map(col=>dot(row,col)));
}
export function transpose(A) {
  return A[0].map((_,j)=>A.map(row=>row[j]));
}
export function columnStack(cols) {
  return cols[0].map((_,i)=>cols.map(c=>c[i]));
}
export function cleanArray(a, tol=EPS) {
  return a.map(x => Math.abs(x) <= tol ? 0 : x);
}
export function cleanMatrix(A, tol=EPS) {
  return A.map(row=>cleanArray(row,tol));
}
export function lexCompare(a,b) {
  for (let i=0;i<Math.min(a.length,b.length);i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length-b.length;
}
export function round12(x) { return Math.round(x*1e12)/1e12; }

export function canonicalDirection(vec) {
  const w = vec.map(Number);
  for (const x of w) {
    if (Math.abs(x) > EPS) {
      if (x < 0) return w.map(v=>-v);
      break;
    }
  }
  return w;
}

export function RL_calc(lc) {
  const a=+lc.a, b=+lc.b, c=+lc.c;
  const alpha=+lc.alpha, beta=+lc.beta, gamma=+lc.gamma;
  const ar=deg2rad(alpha), br=deg2rad(beta), gr=deg2rad(gamma);
  const ca=Math.cos(ar), cb=Math.cos(br), cg=Math.cos(gr);
  const sa=Math.sin(ar), sb=Math.sin(br), sg=Math.sin(gr);

  if (Math.min(Math.abs(sa),Math.abs(sb),Math.abs(sg)) < EPS) {
    throw new Error("Invalid lattice angles.");
  }
  const V0sq = 1-ca*ca-cb*cb-cg*cg+2*ca*cb*cg;
  if (V0sq <= 0) {
    throw new Error("Invalid lattice parameters: unit-cell volume is zero or imaginary.");
  }
  const V0=Math.sqrt(V0sq);
  const V=a*b*c*V0;
  const acosd = x => rad2deg(Math.acos(clamp(x,-1,1)));
  const alphaStar = acosd((cb*cg-ca)/(sb*sg));
  const betaStar  = acosd((ca*cg-cb)/(sa*sg));
  const gammaStar = acosd((ca*cb-cg)/(sa*sb));

  const na=2*PI/V*b*c*sa;
  const nb=2*PI/V*a*c*sb;
  const nc=2*PI/V*a*b*sg;

  const asr=deg2rad(alphaStar), bsr=deg2rad(betaStar), gsr=deg2rad(gammaStar);

  let astar=[na,0,0];
  let bstar=[nb*Math.cos(gsr), nb*Math.sin(gsr), 0];

  const cx=nc*Math.cos(bsr);
  const cy=nc*(Math.cos(asr)-Math.cos(bsr)*Math.cos(gsr))/Math.sin(gsr);
  const czsq=nc*nc-cx*cx-cy*cy;
  if (czsq < -1e-12) throw new Error("Failed to construct c* vector.");
  let cstar=[cx,cy,Math.sqrt(Math.max(0,czsq))];

  astar=cleanArray(astar); bstar=cleanArray(bstar); cstar=cleanArray(cstar);
  return {
    astar, bstar, cstar,
    alpha_star: alphaStar, beta_star: betaStar, gamma_star: gammaStar,
    n_a: na, n_b: nb, n_c: nc, V, V0
  };
}


function solve3(A,b) {
  const M=A.map((row,i)=>[...row.map(Number),Number(b[i])]);
  for(let col=0;col<3;col++) {
    let piv=col;
    for(let r=col+1;r<3;r++) if(Math.abs(M[r][col])>Math.abs(M[piv][col])) piv=r;
    if(Math.abs(M[piv][col])<EPS) throw new Error("Singular reciprocal basis.");
    if(piv!==col) [M[col],M[piv]]=[M[piv],M[col]];
    const d=M[col][col];
    for(let j=col;j<4;j++) M[col][j]/=d;
    for(let r=0;r<3;r++) if(r!==col) {
      const f=M[r][col];
      for(let j=col;j<4;j++) M[r][j]-=f*M[col][j];
    }
  }
  return M.map(row=>row[3]);
}

function orientNormalByDominantHKL(normal, rl) {
  let n=normalize(normal);
  const G=[
    [rl.astar[0],rl.bstar[0],rl.cstar[0]],
    [rl.astar[1],rl.bstar[1],rl.cstar[1]],
    [rl.astar[2],rl.bstar[2],rl.cstar[2]],
  ];
  const w=solve3(G,n);
  const maxAbs=Math.max(...w.map(x=>Math.abs(x)));
  const tieTol=Math.max(EPS,maxAbs*1e-12);
  for(const x of w) {
    if(Math.abs(Math.abs(x)-maxAbs)<=tieTol) {
      if(x<0) n=scale(n,-1);
      break;
    }
  }
  return n;
}

export function UB_calc(lc, rl) {
  const sv1=lc.sv1.map(Number), sv2=lc.sv2.map(Number);
  const B = columnStack([rl.astar,rl.bstar,rl.cstar]).map(row=>row.map(x=>x/(2*PI)));

  if (norm(sv1)<EPS) throw new Error("sv1 must not be zero.");
  if (norm(sv2)<EPS) throw new Error("sv2 must not be zero.");

  const qu=matVec(B,sv1), qv=matVec(B,sv2);
  const nu=norm(qu), nv=norm(qv);
  if (nu<EPS) throw new Error("sv1 gives a zero reciprocal-space vector.");
  if (nv<EPS) throw new Error("sv2 gives a zero reciprocal-space vector.");

  const e1=scale(qu,1/nu);
  let fixed=cross(qu,qv);
  if (norm(fixed)<EPS) throw new Error("sv1 and sv2 must define a non-degenerate scattering plane.");
  fixed=orientNormalByDominantHKL(fixed,rl);

  let normal=cross(qu,qv);
  if (norm(normal)<EPS) throw new Error("sv1 and sv2 must not be parallel.");
  if (dot(normal,fixed)<0) normal=scale(normal,-1);

  const e3=normalize(normal);
  const e2=normalize(cross(e3,e1));
  let U=[e1,e2,e3];
  let UB=matMul(U,B);

  U=cleanMatrix(U); UB=cleanMatrix(UB);
  return {U,B:cleanMatrix(B),UB};
}

export function makeSpiceScatteringPlaneBasis(rl,uHkl,vHkl) {
  const U=uHkl.map(Number), V=vHkl.map(Number);
  if (norm(U)<EPS) throw new Error("U vector must not be zero.");
  if (norm(V)<EPS) throw new Error("V vector must not be zero.");

  const qU=add(add(scale(rl.astar,U[0]),scale(rl.bstar,U[1])),scale(rl.cstar,U[2]));
  const qV=add(add(scale(rl.astar,V[0]),scale(rl.bstar,V[1])),scale(rl.cstar,V[2]));
  const ex=normalize(qU,"U vector gives a zero reciprocal-space vector.");

  let fixed=cross(qU,qV);
  if (norm(fixed)<EPS) throw new Error("U and V must define a non-degenerate scattering plane.");
  fixed=orientNormalByDominantHKL(fixed,rl);
  let normal=cross(qU,qV);
  if (norm(normal)<EPS) throw new Error("U and V must not be parallel.");
  if (dot(normal,fixed)<0) normal=scale(normal,-1);
  const ez=normalize(normal);
  const ey=normalize(cross(ez,ex));
  return {ex,ey,ez};
}

export function reciprocalVectors(a,b,c,alpha,beta,gamma) {
  const ar=deg2rad(alpha), br=deg2rad(beta), gr=deg2rad(gamma);
  const A=[a,0,0];
  const B=[b*Math.cos(gr),b*Math.sin(gr),0];
  const cx=c*Math.cos(br);
  const cy=c*(Math.cos(ar)-Math.cos(br)*Math.cos(gr))/Math.sin(gr);
  const cz=Math.sqrt(Math.max(0,c*c-cx*cx-cy*cy));
  const C=[cx,cy,cz];
  const vol=dot(A,cross(B,C));
  if (Math.abs(vol)<EPS) throw new Error("Invalid lattice parameters.");
  return {
    astar:scale(cross(B,C),2*PI/vol),
    bstar:scale(cross(C,A),2*PI/vol),
    cstar:scale(cross(A,B),2*PI/vol)
  };
}

export function linspace(a,b,n) {
  if (n<=1) return [a];
  return Array.from({length:n},(_,i)=>a+(b-a)*i/(n-1));
}
export function arange(start,stop,step) {
  const out=[];
  if (step===0) throw new Error("step must not be zero");
  if (step>0) for(let x=start;x<stop-1e-12;x+=step) out.push(x);
  else for(let x=start;x>stop+1e-12;x+=step) out.push(x);
  return out;
}
export function interpExtrap(xp,yp,x) {
  if (xp.length!==yp.length || xp.length===0) throw new Error("Invalid interpolation table.");
  if (xp.length===1) return yp[0];
  let i=0;
  if (x<=xp[0]) i=0;
  else if (x>=xp[xp.length-1]) i=xp.length-2;
  else {
    while(i<xp.length-2 && x>xp[i+1]) i++;
  }
  const t=(x-xp[i])/(xp[i+1]-xp[i]);
  return yp[i]+t*(yp[i+1]-yp[i]);
}
