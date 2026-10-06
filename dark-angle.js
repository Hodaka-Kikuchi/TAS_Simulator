export function createDarkAngle(deps){
  const {
    $, num, darkAssetSlots, darkAssetIds, currentDarkRangeCount, checkedValue,
    canonicalOrientationMode, norm, hklToQ, rad2deg, clamp,
    effectiveOrientationReference, dot, tasConvention, selectedTasSense, selectedS1Sign,
    linspace, deg2rad, qePointInPolygon
  }=deps;

  function getDarkAssets(){
    const assets=[];
    for(const slot of darkAssetSlots()){
      const ids=darkAssetIds(slot);
      if(!$(ids.enable)?.checked) continue;
      const rotation=num(ids.rotation);
      const ranges=[];
      for(let i=0;i<currentDarkRangeCount(slot);i++){
        ranges.push([num(ids.from(i)),num(ids.to(i)),num(ids.offset(i))+rotation]);
      }
      assets.push({slot,key:$(ids.se)?.value||"",ref:checkedValue(ids.ref)||"Reference Q",refHkl:[num(ids.refH),num(ids.refK),num(ids.refL)],ranges});
    }
    return assets;
  }

  function darkSampleRangeForConvention(rawRange,convention){
    const [from,to,offset]=rawRange.map(Number);
    const crystalSign=convention.s1EncoderSign;
    if(crystalSign<0) return [-to,-from,-offset];
    return [from,to,offset];
  }

  function directBeamOrientationCorrection(rl,energyMode,Ei,Ef,sense){
    const orientationMode=canonicalOrientationMode(
      rl,$('orientationReference')?.value || 'bragg'
    );
    if(orientationMode==='bragg') return 0;

    const refHkl=(orientationMode==='perpV' || orientationMode==='parallelV')
      ? [num("Vh"),num("Vk"),num("Vl")]
      : [num("Uh"),num("Uk"),num("Ul")];
    const qRef=norm(hklToQ(rl,refHkl));
    const E0=energyMode==="Ef fixed"?Ef:Ei;
    if(!(qRef>1e-12) || !(E0>0)) return 0;

    const k0=Math.sqrt(E0/2.072);
    const arg=qRef/(2*k0);
    if(arg>1+1e-10) return 0;

    const halfS2Ref=rad2deg(Math.asin(clamp(arg,-1,1)));
    const parallelOffset=(orientationMode==='parallelU' || orientationMode==='parallelV') ? -90 : 0;
    return +halfS2Ref+parallelOffset;
  }

  function rebuildGeometryMatchedDarkPolygons(cache,conventionInput){
    const convention=(conventionInput && typeof conventionInput==="object" && "sense" in conventionInput)
      ? tasConvention(conventionInput.sense,conventionInput.s1sign)
      : tasConvention(selectedTasSense(),selectedS1Sign());
    if(!cache?.addDark) return cache;

    const {rl,ex,ey,energyMode,Ei,Ef,hwList,S2list,darkAssets}=cache;
    if(!rl || !ex || !ey || !Array.isArray(hwList) || !Array.isArray(S2list)) return cache;

    const S2min=num("S2min");
    const fixedEnergy=energyMode==="Ei fixed" ? Ei : Ef;
    const armSign=convention.sampleScatteringSign;
    const darkCrystalSign=convention.s1EncoderSign;
    const directBaseSign=convention.sense==="+-+" ? -1 : +1;

    const planePhi=hkl=>{
      const q=hklToQ(rl,hkl||[0,0,0]);
      const x=dot(q,ex), y=dot(q,ey);
      return Math.hypot(x,y)<1e-12 ? null : Math.atan2(y,x);
    };

    let orientationPhi=null, directQToKi=0;
    try{
      const orientationRef=effectiveOrientationReference(rl,fixedEnergy,convention);
      orientationPhi=planePhi(orientationRef.hkl);
      const qRef=hklToQ(rl,orientationRef.hkl), qRefNorm=norm(qRef);
      if(qRefNorm>1e-12 && Number.isFinite(fixedEnergy) && fixedEnergy>0){
        const kRef=Math.sqrt(fixedEnergy/2.072);
        const thetaRef=Math.asin(clamp(qRefNorm/(2*kRef),-1,1));
        directQToKi=Math.PI/2-thetaRef;
      }
    }catch(_err){
      orientationPhi=null;
      directQToKi=0;
    }

    const darkKF=[], darkKI=[];
    for(let hwIndex=0; hwIndex<hwList.length; hwIndex++){
      const hw=Number(hwList[hwIndex]);
      let EiHw,EfHw;
      if(energyMode==="Ef fixed"){ EiHw=Ef+hw; EfHw=Ef; }
      else { EiHw=Ei; EfHw=Ei-hw; }

      const hwKF=[], hwKI=[];
      if(!(EiHw>0) || !(EfHw>0)){
        darkKF.push(hwKF); darkKI.push(hwKI); continue;
      }

      const ki=0.6947*Math.sqrt(EiHw), kf=0.6947*Math.sqrt(EfHw);
      const S2max=Number(S2list[hwIndex]);
      if(!Number.isFinite(S2max)){
        darkKF.push(hwKF); darkKI.push(hwKI); continue;
      }
      const s2dark=linspace(S2min,S2max,200);

      const boundaryPoint=(s2deg,darkDeg,phiBase,beam,referenceCorrectionDeg=0)=>{
        const s2=deg2rad(s2deg);
        const kfRay=armSign*s2;
        const qx=ki-kf*Math.cos(kfRay);
        const qy=-kf*Math.sin(kfRay);
        const qMag=Math.hypot(qx,qy);
        const qLab=Math.atan2(qy,qx);
        const rayAngle=beam==="kf" ? kfRay : Math.PI;
        const phiTarget=qLab-rayAngle+phiBase
          +deg2rad(referenceCorrectionDeg)
          +darkCrystalSign*deg2rad(darkDeg);
        return [qMag*Math.cos(phiTarget),qMag*Math.sin(phiTarget)];
      };

      for(const asset of (darkAssets||[])){
        if(asset.ref==="Fixed") continue;

        let phiBase=null;
        if(asset.ref==="Reference Q"){
          phiBase=planePhi(asset.refHkl||[0,0,0]);
          if(phiBase==null) continue;
        }else if(asset.ref==="Direct beam"){
          if(orientationPhi==null) continue;
          phiBase=orientationPhi+directBaseSign*directQToKi;
        }else continue;

        for(const rawRange of asset.ranges||[]){
          let [from,to,offset]=rawRange.map(Number);
          if(from===0 && to===0) continue;
          let d0=offset+from, d1=offset+to;
          if(d1<d0) d1+=360;

          const rawDirectBeamCorrection=asset.ref==="Direct beam"
            ? directBeamOrientationCorrection(rl,energyMode,Ei,Ef,convention)
            : 0;
          const referenceCorrection=asset.ref==="Direct beam" ? -rawDirectBeamCorrection : 0;

          const makePolygon=beam=>{
            const fromCurve=s2dark.map(s2=>boundaryPoint(s2,d0,phiBase,beam,referenceCorrection));
            const toCurve=s2dark.map(s2=>boundaryPoint(s2,d1,phiBase,beam,referenceCorrection));
            const top=linspace(d0,d1,100).map(d=>boundaryPoint(S2max,d,phiBase,beam,referenceCorrection));
            const bottom=linspace(d1,d0,100).map(d=>boundaryPoint(S2min,d,phiBase,beam,referenceCorrection));
            return [...fromCurve,...top,...[...toCurve].reverse(),...bottom];
          };
          hwKF.push(makePolygon("kf"));
          hwKI.push(makePolygon("ki"));
        }
      }
      darkKF.push(hwKF); darkKI.push(hwKI);
    }

    cache.darkKF=darkKF;
    cache.darkKI=darkKI;
    return cache;
  }

  function qeDarkBlockWarningsForHKLE(cache,hkl,hw){
    if(!cache?.addDark || !Array.isArray(hkl) || hkl.length!==3) return [];
    const energy=Number(hw);
    if(!Number.isFinite(energy) || !Array.isArray(cache.hwList) || !cache.hwList.length) return [];
    try{
      const q=hklToQ(cache.rl,hkl.map(Number));
      const p=[dot(q,cache.ex),dot(q,cache.ey)];
      if(!p.every(Number.isFinite)) return [];
      let index=0, best=Infinity;
      for(let i=0;i<cache.hwList.length;i++){
        const delta=Math.abs(Number(cache.hwList[i])-energy);
        if(delta<best){ best=delta; index=i; }
      }
      const blocked=(polygons)=>Array.isArray(polygons) && polygons.some(poly=>qePointInPolygon(p,poly));
      const warnings=[];
      if(blocked(cache.darkKI?.[index])) warnings.push('ki blocked');
      if(blocked(cache.darkKF?.[index])) warnings.push('kf blocked');
      if(blocked(cache.darkFixed?.[index])) warnings.push('fixed blocked');
      return warnings;
    }catch(_err){ return []; }
  }

  return {
    getDarkAssets,
    darkSampleRangeForConvention,
    directBeamOrientationCorrection,
    rebuildGeometryMatchedDarkPolygons,
    qeDarkBlockWarningsForHKLE
  };
}
