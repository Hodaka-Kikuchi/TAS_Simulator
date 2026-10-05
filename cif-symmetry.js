// Pure CIF reciprocal-space symmetry helpers extracted from app.js.

export function cifSymRationalNumber(raw){
  let s=String(raw??"").replace(/\*/g,"").trim();
  if(!s || s==="+") return 1;
  if(s==="-") return -1;
  if(s.startsWith("/")) return 1/Number(s.slice(1));
  if(s.startsWith("+/")) return 1/Number(s.slice(2));
  if(s.startsWith("-/")) return -1/Number(s.slice(2));
  if(s.includes("/")){
    const parts=s.split("/");
    if(parts.length===2){
      const a=Number(parts[0]), b=Number(parts[1]);
      return b ? a/b : NaN;
    }
  }
  return Number(s);
}

export function cifSymmetryLinearMatrix(op){
  const parts=String(op||"").split(",");
  if(parts.length!==3) throw new Error(`Unsupported symmetry operation: ${op}`);
  return parts.map(expr=>{
    let s=String(expr).toLowerCase().replace(/\s+/g,"").replace(/−/g,"-");
    s=s.replace(/-/g,"+-");
    if(s.startsWith("+")) s=s.slice(1);
    const row=[0,0,0];
    for(const term of s.split("+").filter(Boolean)){
      const m=term.match(/[xyz]/);
      if(!m) continue; // translation part
      const idx={x:0,y:1,z:2}[m[0]];
      const coeff=cifSymRationalNumber(term.replace(m[0],""));
      if(!Number.isFinite(coeff)) throw new Error(`Unsupported symmetry term: ${term}`);
      row[idx]+=coeff;
    }
    return row;
  });
}

export function inverse3x3(m){
  const [a,b,c]=m[0], [d,e,f]=m[1], [g,h,i]=m[2];
  const A=e*i-f*h, B=-(d*i-f*g), C=d*h-e*g;
  const D=-(b*i-c*h), E=a*i-c*g, F=-(a*h-b*g);
  const G=b*f-c*e, H=-(a*f-c*d), I=a*e-b*d;
  const det=a*A+b*B+c*C;
  if(Math.abs(det)<1e-12) throw new Error("A space-group symmetry matrix is singular.");
  return [[A,D,G],[B,E,H],[C,F,I]].map(row=>row.map(x=>x/det));
}

export function reciprocalSymmetryMatrices(sg){
  const out=[], seen=new Set();
  for(const op of (sg?.operations||["x,y,z"])){
    const R=cifSymmetryLinearMatrix(op);
    const inv=inverse3x3(R);
    const T=[
      [inv[0][0],inv[1][0],inv[2][0]],
      [inv[0][1],inv[1][1],inv[2][1]],
      [inv[0][2],inv[1][2],inv[2][2]]
    ].map(row=>row.map(x=>Math.abs(x-Math.round(x))<1e-9?Math.round(x):x));
    const key=T.flat().map(x=>Number(x).toFixed(9)).join(",");
    if(!seen.has(key)){ seen.add(key); out.push(T); }
  }
  return out;
}

export function transformReflectionHkl(M,hkl){
  const v=M.map(row=>row[0]*hkl[0]+row[1]*hkl[1]+row[2]*hkl[2]);
  return v.map(x=>{
    const y=Math.abs(x-Math.round(x))<1e-8?Math.round(x):x;
    return Object.is(y,-0)?0:y;
  });
}

export function hklKey(hkl){ return hkl.map(x=>Math.round(Number(x))).join(","); }
export function compareHkl(a,b){
  for(let i=0;i<3;i++){
    const d=Number(a[i])-Number(b[i]);
    if(Math.abs(d)>1e-12) return d;
  }
  return 0;
}
export function firstNonzeroPositive(hkl){
  for(const x of hkl){ if(x!==0) return x>0; }
  return true;
}
export function canonicalReflectionHkl(star){
  return [...star].sort((a,b)=>{
    const ap=firstNonzeroPositive(a), bp=firstNonzeroPositive(b);
    if(ap!==bp) return ap?-1:1;
    // Prefer the conventional representative with the largest h, then k, then l.
    for(let i=0;i<3;i++) if(a[i]!==b[i]) return b[i]-a[i];
    return 0;
  })[0];
}

export function reflectionStar(hkl,reciprocalOps){
  const map=new Map();
  for(const M of reciprocalOps){
    const p=transformReflectionHkl(M,hkl).map(x=>{const y=Math.round(x);return Object.is(y,-0)?0:y;});
    const n=p.map(x=>x===0?0:-x);
    map.set(hklKey(p),p);
    map.set(hklKey(n),n); // Friedel pair: useful powder/full-pattern multiplicity.
  }
  return [...map.values()];
}
