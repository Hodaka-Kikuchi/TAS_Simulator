export function createQEPlot(deps){
  const {$, PI, deg2rad, rad2deg, clamp, dot, norm, scale, add, linspace, num, parseNumericValue, checkedValue, currentInstrument, formatHKL, hklToQ, makeSpiceScatteringPlaneBasis, effectiveOrientationReference, updateS2MaxDisplayForQERange, renderGeometry, collectResolutionBase, tasMotorAngles, tasConvention, selectedTasSense, selectedS1Sign, tasConventionFromLegacyUiSense, backgroundColor, backgroundPowderPeaks, powderS2ForQAtHW, representativePowderHklText, selectedBackgrounds, selectedQAtS2, safeResizePlot, scatteringPlaneWarningMessage, setScatteringPlaneWarning, sfThresholdFraction, syncSingleNavigation, backgroundMaterials, getSingleCache, getPowderCache}=deps;
function singleMarkerSizes(fullSpan,visibleSpan,peakCount){
  // Keep dense thermal maps readable at the full view, then grow markers smoothly
  // as the user zooms in. Sizes remain bounded so neither view becomes extreme.
  const density=Math.max(0.50,Math.min(1,Math.sqrt(90/Math.max(90,peakCount||0))));
  const zoom=Math.max(1,Math.sqrt(Math.max(1,fullSpan/Math.max(visibleSpan,1e-9))));
  const scale=Math.min(1.55,density*zoom);
  return {nuclear:Math.max(5,12*scale),magnetic:Math.max(3.0,7*scale),star:Math.max(3.5,9*scale)};
}

function singleNuclearLabelStyle(fullSpan,visibleSpan){
  // Scale both font size and marker-to-label clearance with zoom.  A fixed
  // fraction of the visible Q span looks progressively tighter in screen pixels
  // once the text/markers grow, so increase that fraction as we zoom in.
  const span=Math.min(fullSpan,Math.max(1e-9,Number(visibleSpan)||fullSpan));
  const zoom=Math.max(1,fullSpan/span);
  const logZoom=Math.max(0,Math.log2(zoom));
  const fontSize=Math.min(20,11+2.5*logZoom);
  const offsetFraction=Math.min(0.055,0.022+0.006*logZoom);
  const offset=Math.max(span*offsetFraction,fullSpan*0.0015);
  return {offset,fontSize};
}


// Unified Q-E Range calculation.


function bindSingleZoomLabelScaling(cache,Qplot){
  const gd=$("singlePlot");
  if(!gd || typeof gd.on!=="function") return;
  if(gd.__tasLabelRelayoutHandler && typeof gd.removeListener==="function")
    gd.removeListener("plotly_relayout",gd.__tasLabelRelayoutHandler);
  const fullSpan=2*Qplot;
  const applyOffset=span=>{
    const idx=(gd.data||[]).findIndex(tr=>tr.meta==="nuclear-labels");
    if(idx<0) return;
    const style=singleNuclearLabelStyle(fullSpan,span);
    // Keep the label trace point-for-point aligned with the currently visible
    // nuclear peaks.  Using all cache.Gpoints here caused Plotly reset/double-click
    // to pair a shorter text array with a longer x/y array, visually piling labels
    // against one side of the plot.
    const threshold=cache.cifStructure ? sfThresholdFraction() : 0;
    const pts=cache.Gpoints.filter(p=>p.label!=="" && (!cache.cifStructure || !Number.isFinite(p.sfNorm) || p.sfNorm>threshold));
    const unit=currentQEMapUnit();
    const qpts=pts.map(p=>qeXYForUnit(cache,[p.x,p.y],unit));
    Plotly.restyle(gd,{
      x:[qpts.map(p=>p[0])],
      y:[qpts.map(p=>p[1]+style.offset)],
      "textfont.size":style.fontSize
    },[idx]);
  };
  const handler=ev=>{
    if(ev?.["xaxis.autorange"]===true || ev?.["yaxis.autorange"]===true){ applyOffset(fullSpan); return; }
    const x0=Number(ev?.["xaxis.range[0]"]),x1=Number(ev?.["xaxis.range[1]"]);
    const y0=Number(ev?.["yaxis.range[0]"]),y1=Number(ev?.["yaxis.range[1]"]);
    if(Number.isFinite(x0)&&Number.isFinite(x1)){ applyOffset(Math.abs(x1-x0)); return; }
    if(Number.isFinite(y0)&&Number.isFinite(y1)){ applyOffset(Math.abs(y1-y0)); return; }
    requestAnimationFrame(()=>{
      const xRange=gd?._fullLayout?.xaxis?.range;
      const yRange=gd?._fullLayout?.yaxis?.range;
      if(Array.isArray(xRange) && xRange.length>=2 && Number.isFinite(Number(xRange[0])) && Number.isFinite(Number(xRange[1]))){
        applyOffset(Math.abs(Number(xRange[1])-Number(xRange[0])));
      }else if(Array.isArray(yRange) && yRange.length>=2 && Number.isFinite(Number(yRange[0])) && Number.isFinite(Number(yRange[1]))){
        applyOffset(Math.abs(Number(yRange[1])-Number(yRange[0])));
      }
    });
  };
  gd.__tasLabelRelayoutHandler=handler;
  gd.on("plotly_relayout",handler);
}

function bindSingleZoomMarkerScaling(cache,Qplot){
  const gd=$("singlePlot");
  if(!gd || typeof gd.on!=="function") return;
  if(gd.__tasMarkerRelayoutHandler && typeof gd.removeListener==="function")
    gd.removeListener("plotly_relayout",gd.__tasMarkerRelayoutHandler);
  const fullSpan=2*Qplot, peakCount=cache.Gpoints.length+cache.magPoints.length;
  const applySizes=span=>{
    // Never let a zoom-out span larger than the original view make markers smaller
    // than their initial density-scaled size.
    span=Math.min(fullSpan,Math.max(1e-9,Number(span)||fullSpan));
    const sizes=singleMarkerSizes(fullSpan,span,peakCount);
    const updates=[],indices=[];
    (gd.data||[]).forEach((tr,j)=>{
      if(tr.name==="Nuclear Bragg peaks"){updates.push(sizes.nuclear);indices.push(j);}
      else if(/^Magnetic Bragg peaks: k\d+$/.test(tr.name||"")){
        const k=Number((tr.name||"").match(/k([123])$/)?.[1]||1);
        updates.push(k===3?sizes.star:sizes.magnetic);indices.push(j);
      }
    });
    indices.forEach((idx,n)=>Plotly.restyle(gd,{"marker.size":updates[n]},[idx]));
  };
  const handler=ev=>{
    // Reset/Autoscale events do not always contain explicit range[0]/range[1].
    // Handle them explicitly, otherwise the enlarged zoom-in marker size can remain.
    if(ev?.["xaxis.autorange"]===true || ev?.["yaxis.autorange"]===true){
      applySizes(fullSpan);
      return;
    }
    const x0=Number(ev?.["xaxis.range[0]"]),x1=Number(ev?.["xaxis.range[1]"]);
    const y0=Number(ev?.["yaxis.range[0]"]),y1=Number(ev?.["yaxis.range[1]"]);
    if(Number.isFinite(x0)&&Number.isFinite(x1)){ applySizes(Math.abs(x1-x0)); return; }
    if(Number.isFinite(y0)&&Number.isFinite(y1)){ applySizes(Math.abs(y1-y0)); return; }

    // Some Plotly zoom-out/reset paths only expose the final range through _fullLayout.
    // Read it after Plotly has finished applying the relayout event.
    requestAnimationFrame(()=>{
      const xr=gd?._fullLayout?.xaxis?.range, yr=gd?._fullLayout?.yaxis?.range;
      if(Array.isArray(xr)&&xr.length===2&&xr.every(Number.isFinite)) applySizes(Math.abs(xr[1]-xr[0]));
      else if(Array.isArray(yr)&&yr.length===2&&yr.every(Number.isFinite)) applySizes(Math.abs(yr[1]-yr[0]));
      else applySizes(fullSpan);
    });
  };
  gd.__tasMarkerRelayoutHandler=handler; gd.on("plotly_relayout",handler);
}

// Preserve the actual Plotly viewport across data recalculations.
// uirevision alone is not sufficient here because these layouts explicitly
// provide fresh axis ranges on every Plotly.react() call.
function currentPlotRanges(id){
  const gd=$(id);
  const xr=gd?._fullLayout?.xaxis?.range;
  const yr=gd?._fullLayout?.yaxis?.range;
  const valid=r=>Array.isArray(r)&&r.length===2&&r.every(v=>Number.isFinite(Number(v)));
  return {
    x:valid(xr)?xr.map(Number):null,
    y:valid(yr)?yr.map(Number):null
  };
}


// Higher-order wavelength contamination warning.
// A label "nki-mkf" denotes an elastic event for the contaminating harmonics,
// n*ki and m*kf.  Since E is proportional to k^2, the condition is
// n^2 Ei = m^2 Ef.  We compare the currently displayed apparent hbar-omega
// (Ei-Ef) with those discrete conditions.
function qeSpurionWarnings(cache, hw){
  if(!Number.isFinite(hw)) return [];
  const list=Array.isArray(cache?.hwList) ? cache.hwList.map(Number).filter(Number.isFinite) : [];
  if(!list.length) return [];

  const fixedEf=Number(cache?.Ef);
  const fixedEi=Number(cache?.Ei);
  const candidates=[];

  // Convention used in the warning label:
  // "nki-mkf" corresponds to ki/kf = n/m.
  // Therefore Ei/Ef = (n/m)^2.
  //
  // Only include an incident higher-order component while its energy
  // n^2 * Ei is <= 100 meV, since the reactor spectrum is negligible above it.
  // The upper n bound below is intentionally generous; the 100-meV test is
  // the actual cutoff.
  for(let n=2;n<=12;n++){
    for(let m=1;m<n;m++){
      let hws, EiAtSpurion, EfAtSpurion;
      const r=(n/m)*(n/m);

      if(cache.energyMode==="Ef fixed"){
        if(!(fixedEf>0)) continue;
        EfAtSpurion=fixedEf;
        EiAtSpurion=fixedEf*r;
        hws=EiAtSpurion-EfAtSpurion;
      }else{
        if(!(fixedEi>0)) continue;
        EiAtSpurion=fixedEi;
        EfAtSpurion=fixedEi/r;
        hws=EiAtSpurion-EfAtSpurion;
      }

      if(!(EiAtSpurion>0) || !(EfAtSpurion>0) || !Number.isFinite(hws)) continue;
      if(n*n*EiAtSpurion > 100 + 1e-9) continue;

      // Reduce duplicate ratios (e.g. 4/2 == 2/1); keep the lowest-order label.
      if(candidates.some(x=>Math.abs(x.hw-hws)<1e-9)) continue;
      candidates.push({label:`${n}ki-${m}kf`,hw:hws});
    }
  }

  // Warn on the two sampled hbar-omega points nearest each theoretical spurion.
  // This makes a 0.1-meV grid show the warning on two adjacent points.
  const hits=[];
  for(const cand of candidates){
    const nearest=list
      .map((v,idx)=>({v,idx,d:Math.abs(v-cand.hw)}))
      .sort((a,b)=>a.d-b.d || a.idx-b.idx)
      .slice(0,Math.min(2,list.length));
    if(nearest.some(p=>Math.abs(p.v-hw)<1e-9)) hits.push(cand);
  }
  return hits;
}

function updateQESpurionWarning(cache,index){
  const box=$("qeSpurionWarning");
  if(!box || !cache?.hwList?.length) return;
  const i=Math.max(0,Math.min(Number(index)||0,cache.hwList.length-1));
  const hw=Number(cache.hwList[i]);
  const hits=qeSpurionWarnings(cache,hw);
  box.textContent=hits.length ? `Spurion warning: ${hits.map(x=>x.label).join(", ")}` : "";
  box.classList.toggle("active",hits.length>0);
}

function updateGeometrySpurionWarning(cache, hw){
  const box=$("geometrySpurionWarning");
  if(!box) return;
  const hits=qeSpurionWarnings(cache,Number(hw));
  box.textContent=hits.length ? `Spurion warning: ${hits.map(x=>x.label).join(", ")}` : "";
  box.classList.toggle("active",hits.length>0);
}

function currentQEMapUnit(){
  return $('qeMapUnit')?.value==='rlu' ? 'rlu' : 'ainv';
}

function qePlaneRluBasis(cache){
  const uq=hklToQ(cache.rl,cache.U), vq=hklToQ(cache.rl,cache.V);
  return {
    ux:dot(uq,cache.ex), uy:dot(uq,cache.ey),
    vx:dot(vq,cache.ex), vy:dot(vq,cache.ey)
  };
}

function qeXYForUnit(cache,p,unit=currentQEMapUnit()){
  const x=Number(p?.[0]), y=Number(p?.[1]);
  if(unit!=='rlu') return [x,y];
  const b=qePlaneRluBasis(cache);
  const det=b.ux*b.vy-b.uy*b.vx;
  if(Math.abs(det)<1e-12) return [x,y];
  return [(x*b.vy-y*b.vx)/det,(b.ux*y-b.uy*x)/det];
}

function qePointInPolygon(point,polygon){
  const x=point[0], y=point[1];
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const xi=polygon[i][0], yi=polygon[i][1], xj=polygon[j][0], yj=polygon[j][1];
    const cross=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-30)+xi);
    if(cross) inside=!inside;
  }
  return inside;
}

function qeVectorHKL(which){
  return [num(`qeVecH${which}`),num(`qeVecK${which}`),num(`qeVecL${which}`)];
}

function qeMapHeaderTitle(cache){
  const energyText=cache.energyMode==="Ef fixed"?`Ef=${cache.Ef.toFixed(2)} meV`:`Ei=${cache.Ei.toFixed(2)} meV`;
  const lam=cache.lambdaHalf?" | λ/2":"";
  const plane=`(${cache.U.join(",")})-(${cache.V.join(",")})`;
  const spaceGroup=`#${cache.sampleSpaceGroup?.number ?? 1} ${cache.sampleSpaceGroup?.hm ?? "P1"}`;
  const lattice=`a=${cache.lc.a.toFixed(3)}, b=${cache.lc.b.toFixed(3)}, c=${cache.lc.c.toFixed(3)} Å, `+
    `α=${cache.lc.alpha.toFixed(1)}, β=${cache.lc.beta.toFixed(1)}, γ=${cache.lc.gamma.toFixed(1)}°`;
  return `${cache.inst.name||"Instrument"} | ${energyText}${lam} | Scattering plane: ${plane}<br>`+
    `${spaceGroup} | ${lattice}`;
}

function renderQEVectorMap(cache){
  const plot=$('qeVectorPlot'), msg=$('qeVectorMessage');
  if(!plot || !cache || cache.powder) return;
  try{
    const a=qeVectorHKL(0), b=qeVectorHKL(1), dh=b.map((v,i)=>v-a[i]);
    const planeWarnings=[];
    const w0=scatteringPlaneWarningMessage(a,'HKL 1');
    const w1=scatteringPlaneWarningMessage(b,'HKL 2');
    if(w0) planeWarnings.push(w0.replace(/^Warning:\s*/,''));
    if(w1) planeWarnings.push(w1.replace(/^Warning:\s*/,''));
    setScatteringPlaneWarning('qeVectorPlaneWarning',planeWarnings.length?`Warning: ${planeWarnings.join(' / ')}`:'');
    const dhNorm=Math.hypot(...dh);
    if(!(dhNorm>1e-12)) throw new Error('HKL 1 and HKL 2 must be different points.');
    const qa=hklToQ(cache.rl,a), qb=hklToQ(cache.rl,b);
    const p0=[dot(qa,cache.ex),dot(qa,cache.ey)], p1=[dot(qb,cache.ex),dot(qb,cache.ey)];
    const dx=p1[0]-p0[0], dy=p1[1]-p0[1], lineLen=Math.hypot(dx,dy);
    if(!(lineLen>1e-12)) throw new Error('The selected HKL points do not define a line in the scattering plane.');
    const ux=dx/lineLen, uy=dy/lineLen;
    const qLimit=1.2*Math.max(...cache.QmaxList);
    const proj=p0[0]*ux+p0[1]*uy;
    const perp2=Math.max(0,p0[0]*p0[0]+p0[1]*p0[1]-proj*proj);
    const reach=Math.sqrt(Math.max(0,qLimit*qLimit-perp2));
    const sMin=-proj-reach, sMax=-proj+reach;
    const ns=260;
    const sVals=linspace(sMin,sMax,ns);
    // Q vector–E uses the line parameter t directly:
    // HKL(t) = HKL1 + t (HKL2 - HKL1).  This makes the horizontal
    // coordinate independent of the Constant-E map unit selector.
    const xVals=sVals.map(v=>v/lineLen);
    const z=[], darkKiZ=[], darkKfZ=[], darkFixedZ=[], hover=[];
    for(let i=0;i<cache.hwList.length;i++){
      const row=[], kiRow=[], kfRow=[], fixedRow=[], hrow=[];
      const region=cache.regions[i];
      const darkKi=cache.darkKI[i]||[], darkKf=cache.darkKF[i]||[], darkFixed=cache.darkFixed[i]||[];
      for(const sv of sVals){
        const pt=[p0[0]+sv*ux,p0[1]+sv*uy];
        const geometric=qePointInPolygon(pt,region);
        // Dark-angle geometry is an independent display layer.  Do not clip it
        // to the Accessible-Q polygon: a blocked motor geometry can lie outside
        // the currently reachable S1 envelope and should still be visible on
        // the Q-vector–E map when it falls inside the displayed axes.
        const inKi=darkKi.some(poly=>qePointInPolygon(pt,poly));
        const inKf=darkKf.some(poly=>qePointInPolygon(pt,poly));
        const inFixed=darkFixed.some(poly=>qePointInPolygon(pt,poly));
        // Keep the underlying accessible region yellow and draw dark-angle
        // regions as explicit colored overlays, including outside Accessible Q.
        row.push(geometric?1:0);
        kiRow.push(inKi?1:null);
        kfRow.push(inKf?1:null);
        fixedRow.push(inFixed?1:null);
        const t=sv/lineLen;
        const hkl=a.map((v,k)=>v+t*dh[k]);
        let status='';
        if(inKi || inKf || inFixed){
          const labels=[];
          if(inKi) labels.push('dark angle: ki side');
          if(inKf) labels.push('dark angle: kf side');
          if(inFixed) labels.push('dark angle: fixed');
          status=`<br>${labels.join(', ')}`;
        }
        hrow.push(`HKL = (${hkl.map(v=>v.toFixed(3)).join(', ')})<br>ℏω = ${cache.hwList[i].toFixed(2)} meV${status}`);
      }
      z.push(row); darkKiZ.push(kiRow); darkKfZ.push(kfRow); darkFixedZ.push(fixedRow); hover.push(hrow);
    }
    const endX=1;
    const tMin=sMin/lineLen, tMax=sMax/lineLen;
    let firstTick=Math.ceil(tMin-1e-9), lastTick=Math.floor(tMax+1e-9);
    const tickCount=Math.max(0,lastTick-firstTick+1);
    const tickStep=Math.max(1,Math.ceil(tickCount/9));
    let tickTs=[];
    for(let t=firstTick;t<=lastTick;t+=tickStep) tickTs.push(t);
    for(const t of [0,1]) if(t>=tMin-1e-9 && t<=tMax+1e-9 && !tickTs.some(x=>Math.abs(x-t)<1e-8)) tickTs.push(t);

    // Add every integer-HKL point across the full *displayed* horizontal range,
    // not only between HKL1 (t=0) and HKL2 (t=1).  A point is labelled when
    // h, k and l are all integers simultaneously.  Using the most strongly
    // varying component to enumerate candidates also catches fractional t,
    // e.g. (0,0,0)->(2,2,0) gives (1,1,0) at t=0.5.
    const varying=dh.map((v,i)=>[Math.abs(v),i]).sort((x,y)=>y[0]-x[0])[0][1];
    const hklAtTMin=a[varying]+tMin*dh[varying];
    const hklAtTMax=a[varying]+tMax*dh[varying];
    const lo=Math.ceil(Math.min(hklAtTMin,hklAtTMax)-1e-9);
    const hi=Math.floor(Math.max(hklAtTMin,hklAtTMax)+1e-9);
    for(let n=lo;n<=hi;n++){
      const t=(n-a[varying])/dh[varying];
      if(t<tMin-1e-9 || t>tMax+1e-9) continue;
      const hkl=a.map((v,k)=>v+t*dh[k]);
      if(hkl.every(v=>Math.abs(v-Math.round(v))<1e-8) && !tickTs.some(x=>Math.abs(x-t)<1e-8)) tickTs.push(t);
    }
    tickTs.sort((x,y)=>x-y);
    const fmtHkl=v=>{
      const r=Math.round(v);
      return Math.abs(v-r)<1e-8 ? String(r) : Number(v.toFixed(3)).toString();
    };
    const tickVals=tickTs.slice();
    const tickText=tickTs.map(t=>`(${a.map((v,k)=>fmtHkl(v+t*dh[k])).join(',')})`);
    const traces=[{
      type:'heatmap',x:xVals,y:cache.hwList,z,
      zmin:0,zmax:1,showscale:false,hoverinfo:'text',text:hover,
      colorscale:[[0,'rgba(255,255,255,0)'],[0.499,'rgba(255,255,255,0)'],[0.5,'rgba(255,222,105,0.72)'],[1,'rgba(255,222,105,0.72)']],
      name:'Accessible Q–E',showlegend:false
    },{
      type:'scatter',mode:'markers',x:[null],y:[null],hoverinfo:'skip',
      marker:{size:11,symbol:'square',color:'rgba(255,222,105,0.90)',line:{color:'#c7a62c',width:1}},
      name:'Accessible Q',showlegend:true,legendrank:0
    }];
    const addDarkOverlay=(mask,name,color,legendrank)=>{
      if(!mask.some(row=>row.some(v=>v===1))) return;
      traces.push({type:'heatmap',x:xVals,y:cache.hwList,z:mask,zmin:0,zmax:1,showscale:false,hoverinfo:'skip',
        colorscale:[[0,color],[1,color]],name,showlegend:true,legendrank});
    };
    // Keep legend ordering consistent with the Constant E map: Accessible Q,
    // background materials, then dark-angle overlays.

    // Overlay selected BG-material powder reflections on the Q-vector path.
    // A powder reflection is a |Q| = const ring/sphere.  Intersect that with
    // the selected reciprocal-space line p(s)=p0+s*u; each real intersection
    // becomes a vertical line in the t (= s/lineLen) coordinate.  This is a
    // display-only overlay and reuses the same BG powder peak calculation and
    // intensity convention as the Powder Q-E map.
    const qVectorLimit=Math.max(
      Math.hypot(p0[0]+sMin*ux,p0[1]+sMin*uy),
      Math.hypot(p0[0]+sMax*ux,p0[1]+sMax*uy)
    );
    for(const bg of selectedBackgrounds()){
      const material=backgroundMaterials.get(bg.key);
      const visiblePeaks=backgroundPowderPeaks(material,qVectorLimit);
      let bgLegendShown=false;
      for(const peak of visiblePeaks){
        const discriminant=peak.q*peak.q-perp2;
        if(discriminant < -1e-10) continue;
        const root=Math.sqrt(Math.max(0,discriminant));
        const roots=[-proj-root,-proj+root];
        const uniqueRoots=[];
        for(const sv of roots){
          if(sv < sMin-1e-9 || sv > sMax+1e-9) continue;
          if(uniqueRoots.some(v=>Math.abs(v-sv)<1e-8)) continue;
          uniqueRoots.push(sv);
        }
        for(const sv of uniqueRoots){
          const t=sv/lineLen;
          const x=[], y=[], customdata=[];
          let open=false;
          for(const w of cache.hwList){
            const s2=powderS2ForQAtHW(peak.q,w);
            if(!Number.isFinite(s2)){
              if(open){ x.push(null); y.push(null); customdata.push(null); open=false; }
              continue;
            }
            const hkl=a.map((v,k)=>v+t*dh[k]);
            x.push(t); y.push(w);
            customdata.push([
              `BG${bg.index+1}: ${bg.key}<br>${representativePowderHklText(peak)}<br>I/Imax = ${peak.relativeIntensity.toFixed(3)}<br>HKL path = (${hkl.map(v=>v.toFixed(3)).join(', ')})`,
              peak.q,
              `${s2.toFixed(3)}°`
            ]);
            open=true;
          }
          if(open){ x.push(null); y.push(null); customdata.push(null); }
          if(!x.length) continue;
          traces.push({
            type:'scatter',mode:'lines',x,y,customdata,
            name:`BG${bg.index+1}: ${bg.key}`,
            legendgroup:`background-scattering-${bg.index}`,
            showlegend:!bgLegendShown,
            legendrank:10+bg.index,
            line:{
              color:backgroundColor(bg.slot,0.20+0.75*peak.relativeIntensity),
              width:1.5
            },
            hovertemplate:`%{customdata[0]}<br>Q = %{customdata[1]:.4f} Å⁻¹<br>ħω = %{y:.3f} meV<br>S2 = %{customdata[2]}<extra></extra>`
          });
          bgLegendShown=true;
        }
      }
    }

    addDarkOverlay(darkKiZ,'Dark angle (ki side)','rgba(75,190,105,0.55)',20);
    addDarkOverlay(darkKfZ,'Dark angle (kf side)','rgba(75,170,235,0.55)',21);
    addDarkOverlay(darkFixedZ,'Dark angle (fixed)','rgba(95,105,220,0.50)',22);

    // Plotly's native axis grid is rendered behind data traces, so colored
    // heatmap overlays can obscure it.  Build a matching set of grid lines as
    // top-layer shapes so the grid stays readable over Accessible-Q, BG and
    // dark-angle colors as well as the white background.
    const hwMax=Math.max(0,...cache.hwList);
    const niceGridStep=max=>{
      if(!(max>0)) return 1;
      const raw=max/8, power=Math.pow(10,Math.floor(Math.log10(raw)));
      const scaled=raw/power;
      const candidates=[1,2,5,10];
      const nice=candidates.reduce((best,value)=>
        Math.abs(value-scaled)<Math.abs(best-scaled)?value:best
      ,candidates[0]);
      return nice*power;
    };
    const yGridStep=niceGridStep(hwMax);
    const yGridVals=[];
    for(let y=0;y<=hwMax+1e-9;y+=yGridStep) yGridVals.push(Number(y.toFixed(12)));
    if(hwMax>0 && !yGridVals.some(y=>Math.abs(y-hwMax)<1e-9)) yGridVals.push(hwMax);
    const frontGridShapes=[
      ...tickVals.map(x=>({type:'line',xref:'x',yref:'paper',x0:x,x1:x,y0:0,y1:1,layer:'above',line:{color:'rgba(105,115,125,0.50)',width:1}})),
      ...yGridVals.map(y=>({type:'line',xref:'paper',yref:'y',x0:0,x1:1,y0:y,y1:y,layer:'above',line:{color:'rgba(105,115,125,0.50)',width:1}}))
    ];

    Plotly.react(plot,traces,{
      uirevision:'qeVector-hkl',
      plot_bgcolor:'#fff',paper_bgcolor:'#fff',
      title:{text:qeMapHeaderTitle(cache),x:0.5,xanchor:'center',font:{size:16}},
      xaxis:{title:{text:'HKL along selected Q vector',font:{size:15}},tickmode:'array',tickvals:tickVals,ticktext:tickText,tickangle:0,zeroline:false,showgrid:false,showline:true,linecolor:'#555',linewidth:1.2,mirror:true},
      yaxis:{title:{text:'ℏω (meV)',font:{size:15}},range:[0,hwMax],tickmode:'array',tickvals:yGridVals,zeroline:false,showgrid:false,showline:true,linecolor:'#555',linewidth:1.2,mirror:true},
      shapes:[
        ...frontGridShapes,
        {type:'line',x0:0,x1:0,y0:0,y1:1,yref:'paper',layer:'above',line:{color:'black',width:1,dash:'dot'}},
        {type:'line',x0:endX,x1:endX,y0:0,y1:1,yref:'paper',layer:'above',line:{color:'black',width:1,dash:'dot'}}
      ],
      annotations:[
        {x:0,xref:'x',y:1.002,yref:'paper',text:'HKL 1',showarrow:false,yanchor:'bottom',font:{size:12}},
        {x:endX,xref:'x',y:1.002,yref:'paper',text:'HKL 2',showarrow:false,yanchor:'bottom',font:{size:12}}
      ],
      legend:{orientation:'h',x:0.5,xanchor:'center',y:-0.19,yanchor:'top'},
      margin:{l:66,r:30,t:126,b:96}
    },{responsive:true});
    if(msg) msg.textContent='';
  }catch(err){
    if(msg) msg.textContent=err?.message||String(err);
    try{Plotly.purge(plot);}catch(_e){}
  }
}

function setQEMapTab(name){
  const vector=name==='vector';
  $('qeMapTabConstant')?.classList.toggle('active',!vector);
  $('qeMapTabVector')?.classList.toggle('active',vector);
  $('qeMapTabConstant')?.setAttribute('aria-selected',String(!vector));
  $('qeMapTabVector')?.setAttribute('aria-selected',String(vector));
  $('qeConstantMapPane')?.classList.toggle('hidden',vector);
  $('qeVectorMapPane')?.classList.toggle('hidden',!vector);
  try{localStorage.setItem('tas-qe-map-tab-v1',vector?'vector':'constant');}catch(_e){}
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    // Re-render the newly visible Q-E plot rather than relying on resize.
    // Plotly cannot resize a graph that was intentionally skipped while its
    // pane was hidden.  Reusing the current cache keeps this display-only.
    if(vector){
      { const singleCache=getSingleCache(); if(singleCache) renderQEVectorMap(singleCache); }
    }else if(checkedValue('sampleMode')==='single'){
      { const singleCache=getSingleCache(); if(singleCache) renderSingle(singleCache,Number($('hwSlider')?.value)||0); }
    }else if(getPowderCache()){
      // Powder Constant-E has no separate render-only function; its cached plot
      // should already exist, so resize it once visible.  If it does not, the
      // common visible-plot recovery below will request one recalculation.
      safeResizePlot($('powderPlot'));
    }
  }));
}

function renderSingle(cache,index=0){
  const unit=currentQEMapUnit();
  const plotNode=$("singlePlot");
  const keptView=plotNode?.dataset?.qeUnit===unit ? currentPlotRanges("singlePlot") : {x:null,y:null};
  const i=Math.max(0,Math.min(index,cache.regions.length-1));
  const rawBoundary=cache.regions[i];
  const T=p=>qeXYForUnit(cache,p,unit);
  const boundary=rawBoundary.map(T);
  const transformedG=cache.Gpoints.map(p=>({...p,...(()=>{const q=T([p.x,p.y]);return {x:q[0],y:q[1]};})()}));
  const transformedMag=cache.magPoints.map(p=>({...p,...(()=>{const q=T([p.x,p.y]);return {x:q[0],y:q[1]};})()}));
  const allViewPoints=[...boundary,...transformedG.map(p=>[p.x,p.y]),...transformedMag.map(p=>[p.x,p.y])];
  const qMax = Math.max(0, ...allViewPoints.map(p => Math.hypot(p[0], p[1])));

  const s2Min = num("S2min");
  const s2Max = cache.S2list[i];
  const Qplot=Math.max(1e-6,1.15*Math.max(...allViewPoints.map(p=>Math.max(Math.abs(p[0]),Math.abs(p[1]))),1));
  const initialMarkerSizes=singleMarkerSizes(2*Qplot,2*Qplot,cache.Gpoints.length+cache.magPoints.length);

  const sfThreshold=cache.cifStructure ? sfThresholdFraction() : 0;
  const visibleGpoints=cache.cifStructure
    ? transformedG.filter(p=>!p.label || !Number.isFinite(p.sfNorm) || p.sfNorm>sfThreshold)
    : transformedG;

  const traces=[
    {
      x:boundary.map(p=>p[0]),
      y:boundary.map(p=>p[1]),
      fill:"toself",
      name:`Accessible Q (${s2Min.toFixed(0)}° ≤ S2 ≤ ${s2Max.toFixed(0)}°)`,
      mode:"lines",
      line:{width:0},
      fillcolor:"rgba(255,215,0,0.20)"
    },
    {
      x:[null], y:[null], mode:"markers", name:"Nuclear Bragg peaks",
      marker:{color:"black",size:initialMarkerSizes.nuclear},
      hoverinfo:"skip",
      meta:"nuclear-legend",
      zorder:0
    },
    {
      x:visibleGpoints.map(p=>p.x),
      y:visibleGpoints.map(p=>p.y),
      mode:"markers",
      name:"Nuclear Bragg peaks",
      showlegend:false,
      meta:"nuclear-data",
      zorder:0,
      marker:cache.cifStructure ? {
        color:visibleGpoints.map(p=>Number.isFinite(p.sfNorm)?p.sfNorm:0),
        colorscale:[[0,"rgb(245,245,245)"],[0.25,"rgb(205,205,205)"],[0.5,"rgb(150,150,150)"],[0.75,"rgb(85,85,85)"],[1,"rgb(0,0,0)"]],
        cmin:0,cmax:Math.max(0.01,Math.min(1,Number($("sfColorMaxSlider")?.value)||1)),
        showscale:true,
        colorbar:{title:{text:"|F_N|² / max",side:"right",font:{size:15}},tickfont:{size:14},thickness:16,len:0.62,x:1.02,y:0.52},
        size:initialMarkerSizes.nuclear,
        line:{color:"rgba(80,80,80,0.55)",width:0.4}
      } : {color:"black",size:initialMarkerSizes.nuclear},
      hovertext:visibleGpoints.map(p=>{
        if(!cache.cifStructure || !p.label) return p.label;
        const raw=Number.isFinite(p.sf2)?p.sf2:0, rel=Number.isFinite(p.sfNorm)?p.sfNorm:0;
        return `${p.label}<br>|F<sub>N</sub>|² = ${(raw/100).toPrecision(6)} barn<br>|F<sub>N</sub>|² / max = ${rel.toFixed(4)}`;
      }),
      hovertemplate:"%{hovertext}<extra></extra>"
    },
  ];
  if($("displayNuclearLabels")?.checked){
    const labelPts=visibleGpoints.filter(p=>p.label!=="");
    const labelStyle=singleNuclearLabelStyle(2*Qplot,2*Qplot);
    traces.push({
      x:labelPts.map(p=>p.x),
      y:labelPts.map(p=>p.y+labelStyle.offset),
      mode:"text",
      text:labelPts.map(p=>p.label),
      textposition:"middle center",
      textfont:{color:"black",size:labelStyle.fontSize},
      showlegend:false,
      hoverinfo:"skip",
      meta:"nuclear-labels",
      zorder:0
    });
  }
  // Keep propagation vectors visually distinct by marker shape while retaining
  // one magnetic-peak color.  The symbol sequence cycles only if many k vectors
  // are added; the propagation-vector index remains explicit in the legend.
  const magneticSymbols=["circle","x","star","diamond","cross","triangle-up","square","diamond-open","triangle-down","pentagon"];
  const magneticIndices=[...new Set(transformedMag.map(p=>Number(p.qIndex)).filter(Number.isFinite))].sort((a,b)=>a-b);
  for(const qIndex of magneticIndices){
    const pts=transformedMag.filter(p=>p.qIndex===qIndex);
    if(!pts.length) continue;
    const symbol=magneticSymbols[(qIndex-1)%magneticSymbols.length];
    traces.push({
      x:pts.map(p=>p.x),y:pts.map(p=>p.y),mode:"markers",name:`Magnetic Bragg peaks: k${qIndex}`,
      marker:{color:"red",size:symbol==="star"?initialMarkerSizes.star:initialMarkerSizes.magnetic,symbol},
      hovertext:pts.map(p=>p.label),hovertemplate:"%{hovertext}<extra></extra>",
      zorder:10
    });
  }
  const selectedS2=syncSingleNavigation(cache,i);
  const selectedQ=selectedQAtS2(cache,i,selectedS2);
  if(Number.isFinite(selectedQ)){
    const phi=linspace(0,2*PI,361);
    const ringPts=phi.map(t=>T([selectedQ*Math.cos(t),selectedQ*Math.sin(t)]));
    traces.push({x:ringPts.map(p=>p[0]),y:ringPts.map(p=>p[1]),mode:"lines",name:`S2 = ${selectedS2.toFixed(1)}°`,showlegend:false,line:{color:"black",width:1.2,dash:"solid"},hovertemplate:`S2 = ${selectedS2.toFixed(1)}°<br>Q = ${selectedQ.toFixed(3)} Å⁻¹<extra></extra>`});
  }
  for(const ring of cache.ringData){
    const pts=ring.x.map((x,j)=>T([x,ring.y[j]]));
    traces.push({
      x:pts.map(p=>p[0]),y:pts.map(p=>p[1]),mode:"lines",showlegend:false,
      line:{color:ring.color,width:1.5},hovertemplate:ring.hover+"<extra></extra>"
    });
  }
  // Match the Powder view: show one legend entry for each selected BG slot
  // without duplicating a legend item for every individual powder ring.
  for(const bg of selectedBackgrounds()){
    traces.push({
      x:[null],y:[null],mode:"lines",
      name:`BG${bg.index+1}: ${bg.key}`,
      line:{color:backgroundColor(bg.slot,1),width:1.5},
      hoverinfo:"skip",showlegend:true
    });
  }
  if(cache.addDark){
    let fixedLegend=false, kfLegend=false, kiLegend=false;
    for(const r of (cache.darkKI[i]||[])){
      traces.push({x:r.map(p=>T(p)[0]),y:r.map(p=>T(p)[1]),fill:"toself",name:"Dark angle (ki side)",showlegend:!kiLegend,legendgroup:"dark-ki",mode:"lines",line:{width:0},fillcolor:"rgba(0,255,0,0.15)",hoverinfo:"skip"});
      kiLegend=true;
    }
    for(const r of (cache.darkKF[i]||[])){
      traces.push({x:r.map(p=>T(p)[0]),y:r.map(p=>T(p)[1]),fill:"toself",name:"Dark angle (kf side)",showlegend:!kfLegend,legendgroup:"dark-kf",mode:"lines",line:{width:0},fillcolor:"rgba(80,190,255,0.25)",hoverinfo:"skip"});
      kfLegend=true;
    }
    for(const r of (cache.darkFixed[i]||[])){
      traces.push({x:r.map(p=>T(p)[0]),y:r.map(p=>T(p)[1]),fill:"toself",name:"Dark angle (fixed)",showlegend:!fixedLegend,legendgroup:"dark-fixed",mode:"lines",line:{width:0},fillcolor:"rgba(0,0,255,0.15)",hoverinfo:"skip"});
      fixedLegend=true;
    }
  }

  const title=qeMapHeaderTitle(cache);

  // Plotly draws later traces on top. Keep the nuclear legend entry where it is,
  // but render the actual nuclear markers/labels last so BG1-BG4 and other
  // line traces cannot cover them.
  const nuclearTop=traces.filter(tr=>tr.meta==="nuclear-data" || tr.meta==="nuclear-labels");
  if(nuclearTop.length){
    for(let j=traces.length-1;j>=0;j--){
      if(traces[j].meta==="nuclear-data" || traces[j].meta==="nuclear-labels") traces.splice(j,1);
    }
    traces.push(...nuclearTop);
  }

  Plotly.react("singlePlot",traces,{
    // Preserve user zoom/pan when controls trigger a recalculation.
    uirevision:`singlePlot-${unit}`,
    title:{text:title,x:0.5,xanchor:"center",font:{size:16}},
    xaxis:{title:{text:unit==='rlu'?"U coordinate (r.l.u.)":"Qx (Å⁻¹)",font:{size:16}},tickfont:{size:14},range:keptView.x||[-Qplot,Qplot],tickmode:"auto",nticks:10,showgrid:true,gridcolor:"#c3c9cf",gridwidth:1,zeroline:true,zerolinecolor:"#777",showline:true,linecolor:"#555",linewidth:1.2,mirror:true,constrain:"domain"},
    yaxis:{title:{text:unit==='rlu'?"V coordinate (r.l.u.)":"Qy (Å⁻¹)",font:{size:16}},tickfont:{size:14},range:keptView.y||[-Qplot,Qplot],tickmode:"auto",nticks:10,showgrid:true,gridcolor:"#c3c9cf",gridwidth:1,zeroline:true,zerolinecolor:"#777",showline:true,linecolor:"#555",linewidth:1.2,mirror:true,scaleanchor:"x",scaleratio:1,constrain:"domain"},
    // UI-only spacing: reclaim a little space above the plot, while reserving
    // more room below so the x-axis title and horizontal legend do not crowd.
    margin:{l:60,r:cache.cifStructure?88:20,t:92,b:96},
    legend:{orientation:"h",x:0.5,xanchor:"center",y:-0.16,yanchor:"top"}
  },{responsive:true});
  if(plotNode) plotNode.dataset.qeUnit=unit;
  bindSingleZoomMarkerScaling(cache,Qplot);
  bindSingleZoomLabelScaling(cache,Qplot);

  const hwDisplay=$("hwValue");
  if(hwDisplay) hwDisplay.textContent=`${cache.hwList[i].toFixed(1)} meV`;
  const hwEntry=$("hwEntry");
  if(hwEntry && document.activeElement!==hwEntry) hwEntry.value=cache.hwList[i].toFixed(1);
  updateQESpurionWarning(cache,i);
  updateS2MaxDisplayForQERange(cache,i);
  renderGeometry(cache,i);
  if(!$('qeVectorMapPane')?.classList.contains('hidden')) renderQEVectorMap(cache);
}

function qeGeometryAngles(cache, senseOverride=null, uiSenseOverride=null, calcOverride=null){
  const calc=calcOverride || {h:num("geomH"),k:num("geomK"),l:num("geomL"),hw:num("geomHW")};
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
  let convention=tasConvention(selectedTasSense(),selectedS1Sign());
  if(uiSenseOverride && typeof uiSenseOverride==="object" && "sense" in uiSenseOverride){
    convention=tasConvention(uiSenseOverride.sense,uiSenseOverride.s1sign);
  }else if(uiSenseOverride){
    const legacy=tasConventionFromLegacyUiSense(uiSenseOverride);
    convention=tasConvention(legacy.sense,legacy.s1sign);
  }
  b.config.sense=convention.sense;
  b.config.s1sign=convention.s1sign;
  b.config.sign_config=convention.sense;
  void senseOverride; // legacy argument retained for call-site compatibility
  const angles=tasMotorAngles(calc,b);
  const Ei=cache.energyMode==="Ei fixed" ? cache.Ei : cache.Ef+calc.hw;
  const Ef=cache.energyMode==="Ei fixed" ? cache.Ei-calc.hw : cache.Ef;
  return {calc,angles,Ei,Ef,ki:Math.sqrt(Ei/2.072),kf:Math.sqrt(Ef/2.072)};
}


  return {
    currentPlotRanges,
    qeSpurionWarnings,
    updateQESpurionWarning,
    updateGeometrySpurionWarning,
    currentQEMapUnit,
    qePlaneRluBasis,
    qeXYForUnit,
    qePointInPolygon,
    qeVectorHKL,
    qeMapHeaderTitle,
    renderQEVectorMap,
    setQEMapTab,
    renderSingle,
    qeGeometryAngles,
  };
}
