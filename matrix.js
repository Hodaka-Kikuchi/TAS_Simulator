export const EPS = 1e-12;

export function zeros(r, c){ return Array.from({length:r}, ()=>Array(c).fill(0)); }
export function eye(n){ const A=zeros(n,n); for(let i=0;i<n;i++) A[i][i]=1; return A; }
export function clone(A){ return A.map(row=>row.slice()); }
export function transpose(A){
  const r=A.length, c=A[0].length, T=zeros(c,r);
  for(let i=0;i<r;i++) for(let j=0;j<c;j++) T[j][i]=A[i][j];
  return T;
}
export function add(A,B){ return A.map((row,i)=>row.map((x,j)=>x+B[i][j])); }
export function sub(A,B){ return A.map((row,i)=>row.map((x,j)=>x-B[i][j])); }
export function scale(A,s){ return A.map(row=>row.map(x=>x*s)); }
export function matmul(A,B){
  const r=A.length, k=A[0].length, c=B[0].length;
  if(B.length!==k) throw new Error(`matmul shape mismatch ${r}x${k} * ${B.length}x${c}`);
  const C=zeros(r,c);
  for(let i=0;i<r;i++) for(let p=0;p<k;p++){
    const aip=A[i][p];
    for(let j=0;j<c;j++) C[i][j]+=aip*B[p][j];
  }
  return C;
}
export function matvec(A,v){ return A.map(row=>row.reduce((s,x,j)=>s+x*v[j],0)); }
export function diag(vals){ const A=zeros(vals.length, vals.length); vals.forEach((v,i)=>A[i][i]=v); return A; }
export function blockDiag(...blocks){
  const nr=blocks.reduce((s,b)=>s+b.length,0), nc=blocks.reduce((s,b)=>s+b[0].length,0);
  const out=zeros(nr,nc); let r0=0,c0=0;
  for(const b of blocks){
    for(let i=0;i<b.length;i++) for(let j=0;j<b[0].length;j++) out[r0+i][c0+j]=b[i][j];
    r0+=b.length; c0+=b[0].length;
  }
  return out;
}
export function inverse(A){
  const n=A.length;
  if(!A.every(r=>r.length===n)) throw new Error('inverse requires square matrix');
  const M=A.map((row,i)=>row.slice().concat(eye(n)[i]));
  for(let col=0; col<n; col++){
    let piv=col;
    for(let r=col+1;r<n;r++) if(Math.abs(M[r][col])>Math.abs(M[piv][col])) piv=r;
    if(Math.abs(M[piv][col])<EPS) throw new Error('Singular matrix');
    if(piv!==col) [M[piv],M[col]]=[M[col],M[piv]];
    const d=M[col][col];
    for(let j=0;j<2*n;j++) M[col][j]/=d;
    for(let r=0;r<n;r++) if(r!==col){
      const f=M[r][col]; if(f===0) continue;
      for(let j=0;j<2*n;j++) M[r][j]-=f*M[col][j];
    }
  }
  return M.map(r=>r.slice(n));
}
export function solve(A,b){ return matvec(inverse(A),b); }
export function submatrix(A, rows, cols){ return rows.map(i=>cols.map(j=>A[i][j])); }
export function swapRowsCols(A, order){ return order.map(i=>order.map(j=>A[i][j])); }
export function symmetrize(A){ return scale(add(A,transpose(A)),0.5); }
export function choleskyPositiveDefinite(A){
  const S=symmetrize(A), n=S.length, L=zeros(n,n);
  for(let i=0;i<n;i++) for(let j=0;j<=i;j++){
    let s=S[i][j];
    for(let k=0;k<j;k++) s-=L[i][k]*L[j][k];
    if(i===j){ if(!(s>1e-12)) return false; L[i][j]=Math.sqrt(s); }
    else L[i][j]=s/L[j][j];
  }
  return true;
}
export function det3(A){
  return A[0][0]*(A[1][1]*A[2][2]-A[1][2]*A[2][1])
       - A[0][1]*(A[1][0]*A[2][2]-A[1][2]*A[2][0])
       + A[0][2]*(A[1][0]*A[2][1]-A[1][1]*A[2][0]);
}
export function dot(a,b){ return a.reduce((s,x,i)=>s+x*b[i],0); }
export function norm(v){ return Math.hypot(...v); }
export function cross(a,b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
export function normalize(v){ const n=norm(v); if(n<EPS) throw new Error('Cannot normalize zero vector'); return v.map(x=>x/n); }
export function outer(a,b){ return a.map(x=>b.map(y=>x*y)); }

export function eigSym2(A){
  const a=A[0][0], b=0.5*(A[0][1]+A[1][0]), d=A[1][1];
  const tr=a+d, disc=Math.hypot(a-d,2*b);
  const l1=(tr+disc)/2, l2=(tr-disc)/2;

  // Robust eigenvector construction for nearly diagonal / nearly
  // degenerate 2x2 symmetric matrices.  The previous implementation
  // could try to normalize a vector of order 1e-13, which triggered
  // "Cannot normalize zero vector" for high-symmetry cases such as
  // cubic (1,1,0).
  const scale=Math.max(1,Math.abs(a),Math.abs(d),Math.abs(b),Math.abs(l1));
  const tol=1e-12*scale;

  let v1;
  if(Math.abs(b)<=tol){
    // Matrix is effectively diagonal.  For the exactly degenerate case
    // either Cartesian direction is a valid eigenvector.
    v1 = a>=d ? [1,0] : [0,1];
  } else {
    // Use whichever algebraically equivalent form has the larger norm.
    const c1=[b,l1-a];
    const c2=[l1-d,b];
    const candidate=norm(c1)>=norm(c2) ? c1 : c2;
    const n=norm(candidate);
    v1 = n<=tol ? [1,0] : candidate.map(x=>x/n);
  }

  const v2=[-v1[1],v1[0]];
  return {
    values:[l1,l2],
    vectors:[[v1[0],v2[0]],[v1[1],v2[1]]]
  };
}
