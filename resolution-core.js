import {
  zeros, eye, transpose, add, sub, matmul, matvec, diag, blockDiag, inverse,
  solve, submatrix, swapRowsCols, symmetrize, choleskyPositiveDefinite,
  det3, dot, norm, cross, normalize, eigSym2
} from './matrix.js';

const PI=Math.PI;
const D2R=PI/180;
const R2D=180/PI;
const GAUSS_SIGMA_FROM_FWHM=0.4246609;
const E2K2=2.072;
const E2K2_RES=2.072142;

const sind=d=>Math.sin(d*D2R), cosd=d=>Math.cos(d*D2R), tand=d=>Math.tan(d*D2R);
const asind=x=>Math.asin(x)*R2D, acosd=x=>Math.acos(x)*R2D, atand=x=>Math.atan(x)*R2D;

export function RL_calc(lc){
  const {a,b,c,alpha,beta,gamma}=lc;
  const ca=cosd(alpha), cb=cosd(beta), cg=cosd(gamma);
  const V0=Math.sqrt(1-ca*ca-cb*cb-cg*cg+2*ca*cb*cg);
  const V=a*b*c*V0;
  const alphaStar=acosd((cb*cg-ca)/(sind(beta)*sind(gamma)));
  const betaStar =acosd((ca*cg-cb)/(sind(alpha)*sind(gamma)));
  const gammaStar=acosd((ca*cb-cg)/(sind(alpha)*sind(beta)));
  const n_a=2*PI/V*b*c*sind(alpha);
  const n_b=2*PI/V*a*c*sind(beta);
  const n_c=2*PI/V*a*b*sind(gamma);
  const astar=[n_a,0,0];
  const bstar=[n_b*cosd(gammaStar),n_b*sind(gammaStar),0];
  const cstarX=cosd(betaStar);
  const cstarY=(cosd(alphaStar)-cosd(betaStar)*cosd(gammaStar))/sind(gammaStar);
  const cstarZ=Math.sqrt(Math.max(0,1-cstarX*cstarX-cstarY*cstarY));
  const cstar=[n_c*cstarX,n_c*cstarY,n_c*cstarZ];
  for(const v of [astar,bstar,cstar]) for(let i=0;i<3;i++) if(Math.abs(v[i])<=1e-6) v[i]=0;
  return {astar,bstar,cstar,alpha_star:alphaStar,beta_star:betaStar,gamma_star:gammaStar,n_a,n_b,n_c,V,V0};
}



function gcdInt(a,b){
  a=Math.abs(Math.trunc(a)); b=Math.abs(Math.trunc(b));
  while(b){ const t=a%b; a=b; b=t; }
  return a||1;
}

function canonicalDirectionHKL(v){
  const w=v.map(Number);
  for(const x of w){
    if(Math.abs(x)>1e-12){
      if(x<0) return w.map(y=>-y);
      break;
    }
  }
  return w;
}

function roundDirectionKey(v){ return v.map(x=>Math.round(Number(x)*1e12)/1e12); }
function lexCompareDirection(a,b){
  for(let i=0;i<Math.min(a.length,b.length);i++){
    if(a[i]<b[i]) return -1;
    if(a[i]>b[i]) return 1;
  }
  return a.length-b.length;
}

// Deterministic scattering-plane normal, matching the Q-E range convention.
// Swapping the entered U and V must not flip the physical front/back side of
// the scattering plane.  The entered U remains the first display axis; only
// the sign of the orthogonal in-plane V axis is adjusted when necessary.
function fixedPlaneNormal(rl,U,V){
  const G=[
    [rl.astar[0], rl.bstar[0], rl.cstar[0]],
    [rl.astar[1], rl.bstar[1], rl.cstar[1]],
    [rl.astar[2], rl.bstar[2], rl.cstar[2]],
  ];
  const qU=matvec(G,U.map(Number)), qV=matvec(G,V.map(Number));
  let n=normalize(cross(qU,qV));

  // SPICE-like deterministic front side: in reciprocal Cartesian space,
  // make the first significant component of the plane normal positive.
  // This is independent of the entered U/V order.  Examples for cubic:
  //   (100),(010) -> +z  (kept)
  //   (100),(001) -> -y, therefore flip -> +y, so inputs are swapped
  //   to (001),(100) by normalizeScatteringPlaneHKL().
  for(const x of n){
    if(Math.abs(x)>1e-12){
      if(x<0) n=n.map(v=>-v);
      break;
    }
  }
  return n;
}

// Canonicalize the entered scattering-plane pair itself.  If preserving the
// user's U/V order would require flipping the calculated in-plane V axis to
// keep the deterministic front-facing normal, swap U and V instead.  This
// keeps simple positive directions visually natural, e.g.
//   entered U=(0,1,0), V=(1,0,0) -> used U=(1,0,0), V=(0,1,0).
export function normalizeScatteringPlaneHKL(rl, sv1, sv2){
  const U=sv1.map(Number), V=sv2.map(Number);
  if(norm(U)<1e-12) throw new Error('U must not be zero.');
  if(norm(V)<1e-12) throw new Error('V must not be zero.');
  const G=[
    [rl.astar[0], rl.bstar[0], rl.cstar[0]],
    [rl.astar[1], rl.bstar[1], rl.cstar[1]],
    [rl.astar[2], rl.bstar[2], rl.cstar[2]],
  ];
  const qU=matvec(G,U), qV=matvec(G,V);
  if(norm(qU)<1e-12 || norm(qV)<1e-12) throw new Error('U and V must give non-zero reciprocal-space vectors.');
  const uvNormal=cross(qU,qV);
  if(norm(uvNormal)<1e-12) throw new Error('U and V must define a non-degenerate scattering plane.');
  const fixed=fixedPlaneNormal(rl,U,V);
  return dot(uvNormal,fixed)<0
    ? {U:V.slice(),V:U.slice(),swapped:true}
    : {U:U.slice(),V:V.slice(),swapped:false};
}

function compactDirectionHKL(v){
  const s=Math.max(...v.map(x=>Math.abs(x)));
  if(!(s>1e-12)) throw new Error('Cannot normalize a zero reciprocal-space direction.');
  const w=v.map(x=>Math.abs(x/s)<1e-12?0:x/s);

  // Prefer a compact integer representation for simple rational directions.
  // IMPORTANT: do not flip the sign. The direction inherited from the
  // original V is preserved so that (U, V_perp, W) keeps the same handedness.
  for(let d=1;d<=24;d++){
    const z=w.map(x=>Math.round(x*d));
    if(w.every((x,i)=>Math.abs(x*d-z[i])<1e-9)){
      let g=0;
      for(const x of z){
        if(x!==0) g=g===0?Math.abs(x):gcdInt(g,x);
      }
      return z.map(x=>x/(g||1));
    }
  }

  return w.map(x=>Math.abs(x)<1e-12?0:Number(x.toPrecision(8)));
}

export function inferOrthogonalInPlaneHKL(rl, sv1, sv2){
  const U=sv1.map(Number), V=sv2.map(Number);
  if(norm(U)<1e-12) throw new Error('U must not be zero.');
  if(norm(V)<1e-12) throw new Error('V must not be zero.');

  const G=[
    [rl.astar[0], rl.bstar[0], rl.cstar[0]],
    [rl.astar[1], rl.bstar[1], rl.cstar[1]],
    [rl.astar[2], rl.bstar[2], rl.cstar[2]],
  ];

  const qU=matvec(G,U);
  const qV=matvec(G,V);
  if(norm(qU)<1e-12) throw new Error('U gives a zero reciprocal-space vector.');
  if(norm(qV)<1e-12) throw new Error('V gives a zero reciprocal-space vector.');

  // Gram-Schmidt in physical reciprocal Cartesian space.
  // The remaining component retains the direction of the user's original V.
  const uu=dot(qU,qU);
  let qVperp=qV.map((x,i)=>x-dot(qV,qU)/uu*qU[i]);
  if(norm(qVperp)<1e-12){
    throw new Error('U and V must define a non-degenerate scattering plane.');
  }

  // Keep the same front-facing plane normal regardless of U/V input order.
  // This may flip V_perp (e.g. U=(0,1,0), V=(1,0,0) -> V_perp=(-1,0,0)).
  const fixed=fixedPlaneNormal(rl,U,V);
  if(dot(cross(qU,qVperp),fixed)<0) qVperp=qVperp.map(x=>-x);

  const vPerp=solve(G,qVperp);
  return compactDirectionHKL(vPerp);
}

export function inferOutOfPlaneHKL(rl, sv1, sv2){
  const U=sv1.map(Number), V=sv2.map(Number);
  if(norm(U)<1e-12) throw new Error('U must not be zero.');
  if(norm(V)<1e-12) throw new Error('V must not be zero.');

  // Reciprocal-lattice basis in Cartesian reciprocal space:
  //
  //     Q = h a* + k b* + l c*
  //
  // The physical out-of-plane direction is defined by Q_U x Q_V,
  // not by a simple cross product of the Miller-index triples.
  const G=[
    [rl.astar[0], rl.bstar[0], rl.cstar[0]],
    [rl.astar[1], rl.bstar[1], rl.cstar[1]],
    [rl.astar[2], rl.bstar[2], rl.cstar[2]],
  ];

  const qU=matvec(G,U);
  const qV=matvec(G,V);
  if(norm(qU)<1e-12) throw new Error('U gives a zero reciprocal-space vector.');
  if(norm(qV)<1e-12) throw new Error('V gives a zero reciprocal-space vector.');

  const qWraw=cross(qU,qV);
  if(norm(qWraw)<1e-12) throw new Error('U and V must define a non-degenerate scattering plane.');

  // Use a deterministic front-facing normal so swapping U and V does not
  // reverse W.  This is the same convention used by the Q-E range view.
  const qW=fixedPlaneNormal(rl,U,V);

  // Express the physical normal again in reciprocal-lattice coordinates.
  let w=solve(G,qW);

  // HKL coefficients have an arbitrary common scale.  Use a deterministic
  // convention: the largest absolute coefficient is 1.
  const s=Math.max(...w.map(x=>Math.abs(x)));
  if(!(s>1e-12)) throw new Error('Failed to determine the out-of-plane direction.');
  w=w.map(x=>Math.abs(x/s)<1e-12?0:x/s);

  return w;
}

export function UB_calc(lc,rl){
  const sv1=lc.sv1.map(Number), sv2=lc.sv2.map(Number);
  if(norm(sv1)<1e-12) throw new Error('sv1 must not be zero.');
  if(norm(sv2)<1e-12) throw new Error('sv2 must not be zero.');
  const basis=[rl.astar,rl.bstar,rl.cstar];
  const qOf=hkl=>[0,1,2].map(j=>hkl[0]*basis[0][j]+hkl[1]*basis[1][j]+hkl[2]*basis[2][j]);
  const q1=qOf(sv1), q2=qOf(sv2);
  if(norm(q1)<1e-12) throw new Error('sv1 gives a zero reciprocal-space vector.');
  if(norm(q2)<1e-12) throw new Error('sv2 gives a zero reciprocal-space vector.');
  const U1=normalize(q1);
  const q2perp=q2.map((x,i)=>x-dot(U1,q2)*U1[i]);
  if(norm(q2perp)<1e-12) throw new Error('sv1 and sv2 must not be parallel.');
  const U3=fixedPlaneNormal(rl,sv1,sv2);
  const U2=normalize(cross(U3,U1));
  const U=[U1,U2,U3];
  const B=[
    [rl.astar[0],rl.bstar[0],rl.cstar[0]],
    [rl.astar[1],rl.bstar[1],rl.cstar[1]],
    [rl.astar[2],rl.bstar[2],rl.cstar[2]],
  ].map(r=>r.map(x=>x/(2*PI)));
  const UB=matmul(U,B);
  for(const M of [U,B,UB]) for(let i=0;i<3;i++) for(let j=0;j<3;j++) if(Math.abs(M[i][j])<=1e-12) M[i][j]=0;
  return {U,B,UB};
}

function qFromUB(UB,hkl){ return matvec(UB,hkl).map(x=>2*PI*x); }

function schur2(RM, keep){
  const all=[0,1,2,3], elim=all.filter(i=>!keep.includes(i));
  const M=submatrix(RM,keep,keep);
  if(elim.length===0) return M;
  const B=submatrix(RM,keep,elim), C=submatrix(RM,elim,elim);
  return sub(M,matmul(matmul(B,inverse(C)),transpose(B)));
}

function ellipsePoints(M2, scaleX=1, scaleY=1, n=181){
  const S=symmetrize(M2), {values,vectors}=eigSym2(S), c=2*Math.log(2);
  if(values.some(v=>v<=0)) throw new Error('Ellipse matrix is not positive definite.');
  const r=[Math.sqrt(c/values[0]),Math.sqrt(c/values[1])];
  const x=[],y=[];
  for(let i=0;i<n;i++){
    const t=2*PI*i/(n-1), local=[r[0]*Math.cos(t),r[1]*Math.sin(t)];
    const p=matvec(vectors,local); x.push(p[0]/scaleX); y.push(p[1]/scaleY);
  }
  return {x,y};
}

function findMaxAlongAxis(RM,idx){
  RM=symmetrize(RM);
  if(!choleskyPositiveDefinite(RM)) throw new Error('RM must be positive definite to define a bounded resolution ellipsoid.');
  const e=Array(RM.length).fill(0); e[idx]=1;
  const direction=solve(RM,e), a=direction[idx];
  if(!(a>0)) throw new Error('Failed to obtain a positive projected variance.');
  const c=2*Math.log(2);
  return {max:Math.sqrt(c*a), coords:direction.map(x=>Math.sqrt(c/a)*x)};
}
function coherentFwhm(RM,idx){
  const a=RM[idx][idx]; if(!(a>0)) throw new Error(`RM[${idx},${idx}] must be positive.`);
  return 2*Math.sqrt(2*Math.log(2)/a);
}
function rot4(theta,tilt=0){
  const ct=Math.cos(theta), st=Math.sin(theta), cp=Math.cos(tilt), sp=Math.sin(tilt);
  const Rt=[[ct,-st,0,0],[st,ct,0,0],[0,0,1,0],[0,0,0,1]];
  const Rp=[[cp,0,0,-sp],[0,1,0,0],[0,0,1,0],[sp,0,0,cp]];
  return matmul(Rp,Rt);
}

export function calcResolution(lc,rl,col,mos,config,approximation,focusing,geom,calc,unitMode='rlu'){
  const gm1=!!col.gm_1st;
  let div1h=col.div_1st_h, div1v=col.div_1st_v;
  const div1m=col.div_1st_m;
  const {div_2nd_h:div2h,div_2nd_v:div2v,div_3rd_h:div3h,div_3rd_v:div3v,div_4th_h:div4h,div_4th_v:div4v}=col;
  const MHF=!!focusing.monochromator.horizontal.enabled, MVF=!!focusing.monochromator.vertical.enabled;
  const AHF=!!focusing.analyzer.horizontal.enabled, AVF=!!focusing.analyzer.vertical.enabled;
  const numMh=focusing.monochromator.horizontal.blades, numMv=focusing.monochromator.vertical.blades;
  const numAh=focusing.analyzer.horizontal.blades, numAv=focusing.analyzer.vertical.blades;
  const {L0,L1,L2,L3,beam_width,beam_height,mono_width,mono_height,mono_thickness,ana_width,ana_height,ana_thickness,det_width,det_height}=geom;
  const {d_mono,mos_mono_h,mos_mono_v,mos_sam_h,mos_sam_v,d_ana,mos_ana_h,mos_ana_v}=mos;
  const energyMode=config.energy_mode, geometry=config.geometry, sense=config.sign_config, method=approximation.method;
  let Ei=energyMode==='Ei fixed' ? config.Ei : config.Ef+calc.hw;
  let Ef=energyMode==='Ei fixed' ? config.Ei-calc.hw : config.Ef;
  if(!(Ei>0&&Ef>0)) throw new Error(`Ei and Ef must be positive. Ei=${Ei}, Ef=${Ef}`);

  const ub=UB_calc(lc,rl), UB=ub.UB;
  if(det3(ub.U)<=0) throw new Error('Orientation matrix U is not right handed.');
  const hkl=[calc.h,calc.k,calc.l], Qsample=qFromUB(UB,hkl), qnorm=norm(Qsample);
  if(qnorm<1e-12) throw new Error('Q = 0 cannot define the local TAS resolution coordinate system.');
  const kiCal=Math.sqrt(Ei/E2K2), kfCal=Math.sqrt(Ef/E2K2);
  let cosPhi=(kiCal*kiCal+kfCal*kfCal-qnorm*qnorm)/(2*kiCal*kfCal);
  if(cosPhi < -1-1e-10 || cosPhi > 1+1e-10) throw new Error('The requested Q and energy transfer are kinematically inaccessible.');
  cosPhi=Math.max(-1,Math.min(1,cosPhi));
  const phiCal=acosd(cosPhi);
  const monoArg=(2*PI/d_mono)/(2*kiCal), anaArg=(2*PI/d_ana)/(2*kfCal);
  if(Math.abs(monoArg)>1 || Math.abs(anaArg)>1) throw new Error('Monochromator/analyzer Bragg condition is inaccessible for the selected energy.');
  let C1abs=asind(monoArg), C3abs=asind(anaArg);
  if(geometry==='anti-W') C3abs=-C3abs;
  let sm,ss,sa;
  if(sense==='+-+') [sm,ss,sa]=[+1,-1,+1];
  else if(sense==='-+-') [sm,ss,sa]=[-1,+1,-1];
  else throw new Error(`Unsupported TAS sign configuration: ${sense}`);
  const A1=sm*2*C1abs, A2=ss*phiCal, A3=sa*2*C3abs;
  const thetaM=A1/2, thetaS=A2/2, thetaA=A3/2;
  const ki=Math.sqrt(Ei/E2K2), kf=Math.sqrt(Ef/E2K2);
  const Q=Math.sqrt(ki*ki+kf*kf-2*ki*kf*cosd(A2));
  const phi=Math.atan2(-kf*sind(2*thetaS),ki-kf*cosd(2*thetaS))*R2D;

  let alpha1,beta1;
  if(!gm1){ alpha1=div1h/60/180*PI*GAUSS_SIGMA_FROM_FWHM; beta1=div1v/60/180*PI*GAUSS_SIGMA_FROM_FWHM; }
  else {
    const NA=6.022e23, ro=8.908, MNi=58.69, bc=1.03e-12, lambda=Math.sqrt(81.81/Ei)*1e-8;
    const val=lambda*Math.sqrt(NA*ro/MNi*bc/PI);
    if(Math.abs(val)>1) throw new Error('Supermirror divergence expression is outside arcsin domain.');
    div1h=div1m*2*asind(val)*60; div1v=div1h;
    alpha1=div1h/60/180*PI*GAUSS_SIGMA_FROM_FWHM; beta1=alpha1;
  }
  const alpha2=div2h/60/180*PI*GAUSS_SIGMA_FROM_FWHM;
  let alpha3;
  if(AHF){ const W=ana_width*numAh*sind(A3), af=2*atand((W/2)/L2); alpha3=af/180*PI*GAUSS_SIGMA_FROM_FWHM*Math.sqrt(8*Math.log(2)/12); }
  else alpha3=div3h/60/180*PI*GAUSS_SIGMA_FROM_FWHM;
  const alpha4=div4h/60/180*PI*GAUSS_SIGMA_FROM_FWHM;
  const beta2=div2v/60/180*PI*GAUSS_SIGMA_FROM_FWHM, beta3=div3v/60/180*PI*GAUSS_SIGMA_FROM_FWHM, beta4=div4v/60/180*PI*GAUSS_SIGMA_FROM_FWHM;
  const etaM=mos_mono_h/60/180*PI*GAUSS_SIGMA_FROM_FWHM, etaMp=mos_mono_v/60/180*PI*GAUSS_SIGMA_FROM_FWHM;
  const etaA=mos_ana_h/60/180*PI*GAUSS_SIGMA_FROM_FWHM, etaAp=mos_ana_v/60/180*PI*GAUSS_SIGMA_FROM_FWHM;
  const etaS=mos_sam_h/60/180*PI*GAUSS_SIGMA_FROM_FWHM, etaSp=mos_sam_v/60/180*PI*GAUSS_SIGMA_FROM_FWHM;
  const positive=[alpha1,alpha2,beta1,beta2,alpha3,alpha4,beta3,beta4,etaM,etaMp,etaA,etaAp];
  if(positive.some(x=>!Number.isFinite(x)||Math.abs(x)<1e-15)) throw new Error('Collimation and crystal mosaic values must be non-zero for the resolution calculation.');

  const G=diag([alpha1,alpha2,beta1,beta2,alpha3,alpha4,beta3,beta4].map(x=>1/(x*x)));
  const F=diag([etaM,etaMp,etaA,etaAp].map(x=>1/(x*x)));
  const A=zeros(6,8), C=zeros(4,8), B=zeros(4,6);
  A[0][0]=ki/(2*tand(thetaM)); A[0][1]=-A[0][0]; A[3][4]=kf/(2*tand(thetaA)); A[3][5]=-A[3][4];
  A[1][1]=ki; A[2][3]=ki; A[4][4]=kf; A[5][6]=kf;
  B[0][0]=cosd(phi); B[0][1]=sind(phi); B[0][3]=-cosd(phi-2*thetaS); B[0][4]=-sind(phi-2*thetaS);
  B[1][0]=-B[0][1]; B[1][1]=B[0][0]; B[1][3]=-B[0][4]; B[1][4]=B[0][3]; B[2][2]=1; B[2][5]=-1;
  B[3][0]=2*E2K2_RES*ki; B[3][3]=-2*E2K2_RES*kf;
  C[0][0]=0.5; C[0][1]=0.5; C[2][4]=0.5; C[2][5]=0.5;
  C[1][2]=1/(2*sind(thetaM)); C[1][3]=-C[1][2]; C[3][6]=1/(2*sind(thetaA)); C[3][7]=-C[3][6];

  const term=inverse(add(G,matmul(matmul(transpose(C),F),C)));
  const HF=matmul(matmul(A,term),transpose(A));
  let Minv;
  if(method==='Popovici'){
    const bshape=diag([beam_width*beam_width,beam_height*beam_height]);
    const mshape=diag([(mono_thickness)**2,(numMh*mono_width)**2,(numMv*mono_height)**2]);
    const psi=thetaS-phi, rot=[[cosd(psi),sind(psi),0],[-sind(psi),cosd(psi),0],[0,0,1]];
    const sshape=matmul(matmul(rot,eye(3)),transpose(rot));
    const ashape=diag([(ana_thickness)**2,(numAh*ana_width)**2,(numAv*ana_height)**2]);
    const dshape=diag([det_width*det_width,det_height*det_height]);
    const S=inverse(blockDiag(bshape,mshape,sshape,ashape,dshape));
    const f=(Lx,Ly)=>1/(1/Lx+1/Ly);
    const Vcurv=(Lx,Ly,th)=>2*f(Lx,Ly)*Math.abs(sind(th));
    const Hcurv=(Lx,Ly,th)=>2*f(Lx,Ly)/Math.abs(sind(th));
    const monorv=MVF?Vcurv(L0,L1,thetaM):1e10, monorh=MHF?Hcurv(L0,L1,thetaM):1e10;
    const anarv=AVF?Vcurv(L2,L3,thetaA):1e10, anarh=AHF?Hcurv(L2,L3,thetaA):1e10;
    const T=zeros(4,13), D=zeros(8,13);
    T[0][0]=-1/(2*L0); T[0][2]=cosd(thetaM)*(1/L1-1/L0)/2; T[0][3]=sind(thetaM)*(1/L0+1/L1-2/(monorh*sind(thetaM)))/2; T[0][5]=sind(thetaS)/(2*L1); T[0][6]=cosd(thetaS)/(2*L1);
    T[1][1]=-1/(2*L0*sind(thetaM)); T[1][4]=(1/L0+1/L1-2*sind(thetaM)/monorv)/(2*sind(thetaM)); T[1][7]=-1/(2*L1*sind(thetaM));
    T[2][5]=sind(thetaS)/(2*L2); T[2][6]=-cosd(thetaS)/(2*L2); T[2][8]=cosd(thetaA)*(1/L3-1/L2)/2; T[2][9]=sind(thetaA)*(1/L2+1/L3-2/(anarh*sind(thetaA)))/2; T[2][11]=1/(2*L3);
    T[3][7]=-1/(2*L2*sind(thetaA)); T[3][10]=(1/L2+1/L3-2*sind(thetaA)/anarv)/(2*sind(thetaA)); T[3][12]=-1/(2*L3*sind(thetaA));
    D[0][0]=-1/L0; D[0][2]=-cosd(thetaM)/L0; D[0][3]=sind(thetaM)/L0; D[2][1]=D[0][0]; D[2][4]=-D[0][0];
    D[1][2]=cosd(thetaM)/L1; D[1][3]=sind(thetaM)/L1; D[1][5]=sind(thetaS)/L1; D[1][6]=cosd(thetaS)/L1;
    D[3][4]=-1/L1; D[3][7]=-D[3][4]; D[4][5]=sind(thetaS)/L2; D[4][6]=-cosd(thetaS)/L2; D[4][8]=-cosd(thetaA)/L2; D[4][9]=sind(thetaA)/L2;
    D[6][7]=-1/L2; D[6][10]=-D[6][7]; D[5][8]=cosd(thetaA)/L3; D[5][9]=sind(thetaA)/L3; D[5][11]=1/L3; D[7][10]=-D[5][11]; D[7][12]=D[5][11];
    const STFT=add(S,matmul(matmul(transpose(T),F),T));
    const core1=matmul(matmul(D,inverse(STFT)),transpose(D));
    const core2=add(inverse(core1),G);
    const inner=inverse(core2);
    Minv=matmul(matmul(matmul(matmul(B,A),inner),transpose(A)),transpose(B));
  } else if(method==='Cooper-Nathans'){
    if(AHF){
      const P=inverse(HF); P[4][4]=(1/(kf*alpha3))**2; P[3][4]=0; P[3][3]=(tand(thetaA)/(etaA*kf))**2; P[4][3]=0;
      Minv=matmul(matmul(B,inverse(P)),transpose(B));
    } else Minv=matmul(matmul(B,HF),transpose(B));
  } else throw new Error(`Unknown approximation: ${method}`);

  let RM=swapRowsCols(inverse(Minv),[0,1,3,2]);
  let RMinv=inverse(RM); RMinv[1][1]+=Q*Q*etaS*etaS; RMinv[3][3]+=Q*Q*etaSp*etaSp; RM=inverse(RMinv);

  const sv2Orth=inferOrthogonalInPlaneHKL(rl,lc.sv1,lc.sv2);
  const Qx=qFromUB(UB,lc.sv1), Qy=qFromUB(UB,sv2Orth), Qz=qFromUB(UB,lc.sv3);
  const qxNorm=norm(Qx), qyNorm=norm(Qy), qzNorm=norm(Qz), qvNorm=norm(Qsample);
  if(Math.min(qxNorm,qyNorm,qzNorm)<1e-12) throw new Error('U, V and W reciprocal-space directions must be non-zero.');
  const sampleNormal=[0,0,1], qOut=dot(Qsample,sampleNormal);
  if(Math.abs(qOut)>1e-8*Math.max(qvNorm,1)) throw new Error('Calculation Q is out of plane: the requested resolution point lies outside the scattering plane defined by U and V. Reference Q may be out of plane because it is used only for the S1 offset.');
  const Qplane=Qsample.map((x,i)=>x-qOut*sampleNormal[i]), eX=normalize(Qplane), eZ=sampleNormal, eY=normalize(cross(eZ,eX));
  if(dot(cross(eX,eY),eZ)<1-1e-10) throw new Error('Failed to construct a right-handed local resolution basis.');
  const getThetaTilt=axis=>{ const ah=normalize(axis), x=dot(ah,eX),y=dot(ah,eY),z=dot(ah,eZ); return [-Math.atan2(y,x),-Math.atan2(z,Math.hypot(x,y))]; };
  const [tu,pu]=getThetaTilt(Qx), [tv,pv]=getThetaTilt(Qy), [tw,pw]=getThetaTilt(Qz);
  const transform=R=>matmul(matmul(R,RM),transpose(R));
  const RM_U=transform(rot4(tu,pu)), RM_V=transform(rot4(tv,pv)), RM_W=transform(rot4(tw,pw));
  const maxU=findMaxAlongAxis(RM_U,0).max, maxV=findMaxAlongAxis(RM_V,0).max, maxW=findMaxAlongAxis(RM_W,0).max, maxE=findMaxAlongAxis(RM_U,2).max;

  // Coherent widths use one consistent 4D definition in the orthogonal
  // (U, V, E, W) frame: when evaluating one axis, the other three
  // coordinates are fixed to zero.  For a Gaussian resolution function
  // exp(-1/2 x^T RM_U x), this is the FWHM of the corresponding 1D cut
  // through the origin and therefore depends only on RM_U[idx][idx].
  //
  //   Ucoh: V = E = W = 0
  //   Vcoh: U = E = W = 0
  //   Ecoh: U = V = W = 0
  //   Wcoh: U = V = E = 0
  const sliceUEMatrix=submatrix(RM_U,[0,2],[0,2]);
  const sliceVEMatrix=submatrix(RM_U,[1,2],[1,2]);
  const sliceWEMatrix=submatrix(RM_U,[3,2],[3,2]);

  const widths={
    U:2*maxU, V:2*maxV, W:2*maxW, E:2*maxE,
    Ucoh:coherentFwhm(RM_U,0),
    Vcoh:coherentFwhm(RM_U,1),
    Wcoh:coherentFwhm(RM_U,3),
    Ecoh:coherentFwhm(RM_U,2)
  };
  const normU=unitMode==='rlu'?qxNorm:1, normV=unitMode==='rlu'?qyNorm:1, normW=unitMode==='rlu'?qzNorm:1;
  const display={U:widths.U/normU,V:widths.V/normV,W:widths.W/normW,E:widths.E,Ucoh:widths.Ucoh/normU,Vcoh:widths.Vcoh/normV,Wcoh:widths.Wcoh/normW,Ecoh:widths.Ecoh};
  const scale=1.2, lim={U:maxU*scale/normU,V:maxV*scale/normV,W:maxW*scale/normW,E:maxE*scale};
  const projUE=ellipsePoints(schur2(RM_U,[0,2]),normU,1), sliceUE=ellipsePoints(sliceUEMatrix,normU,1);
  const projVE=ellipsePoints(schur2(RM_U,[1,2]),normV,1), sliceVE=ellipsePoints(sliceVEMatrix,normV,1);
  const projWE=ellipsePoints(schur2(RM_U,[3,2]),normW,1), sliceWE=ellipsePoints(sliceWEMatrix,normW,1);
  const projUV=ellipsePoints(schur2(RM_U,[0,1]),normU,normV), sliceUV=ellipsePoints(submatrix(RM_U,[0,1],[0,1]),normU,normV);
  return {RM,RM_U,RM_V,RM_W, widths,display,lim,
    ellipses:{projUE,sliceUE,projVE,sliceVE,projWE,sliceWE,projUV,sliceUV},
    qNorms:{U:qxNorm,V:qyNorm,W:qzNorm},
    displayAxes:{U:lc.sv1.slice(),V:sv2Orth,W:lc.sv3.slice()},
    angles:{A1,A2,A3,thetaM,thetaS,thetaA,phi}, energies:{Ei,Ef}, UB};
}
