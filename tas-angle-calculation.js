// TAS angle-calculation core extracted from app.js / resolution-ui.js.
// This module owns orientation-reference normalization and HKL/E -> TAS motor angles.
// UI/result rendering remains in the calling modules.
export function createTasAngleCalculation(deps){
  const {
    $, PI, angleDiffDeg, clamp, dot, hklToQ, makeSpiceScatteringPlaneBasis, norm, normalize, num, rad2deg,
    scale, selectedS1Sign, selectedTasSense, sub, tasConvention, tasConventionFromLegacyUiSense,
    tasCrystalPhiDegForConvention, tasPhiLabDegForConvention, wrap180
  }=deps;

function canonicalOrientationMode(rl, rawMode=null){
  const mode=rawMode ?? ($('orientationReference')?.value || 'bragg');
  if(mode==='bragg' || mode==='perpU' || mode==='perpV') return mode;
  if(mode!=='parallelU' && mode!=='parallelV') return mode;

  const U=[num('Uh'),num('Uk'),num('Ul')];
  const V=[num('Vh'),num('Vk'),num('Vl')];
  const qU=hklToQ(rl,U), qV=hklToQ(rl,V);
  const u2=dot(qU,qU), v2=dot(qV,qV);
  if(!(u2>1e-20) || !(v2>1e-20)) return mode;

  const perpToU=sub(qV,scale(qU,dot(qV,qU)/u2)); // entered V side
  const perpToV=sub(qU,scale(qV,dot(qU,qV)/v2)); // entered U side
  if(norm(perpToU)<=1e-12 || norm(perpToV)<=1e-12) return mode;

  const parallelAxis=normalize(mode==='parallelU' ? qU : qV);
  const equivalentPerpAxis=normalize(mode==='parallelU' ? perpToV : perpToU);

  // Collapse only when the two labels really are the same directed physical
  // orientation. Non-orthogonal U/V cases remain distinct.
  if(dot(parallelAxis,equivalentPerpAxis) > 1-1e-10){
    return mode==='parallelU' ? 'perpV' : 'perpU';
  }
  return mode;
}

// Convert every orientation-reference mode into the original Reference-Q
// calibration pair {HKL, S1}.  Downstream geometry intentionally stays on the
// validated Reference-Q pipeline.
//
// For ki perpendicular U/V, imagine observing the elastic U/V Bragg peak.  In
// the usual theta--2theta geometry the sample is theta=S2/2 away from the
// ki-perpendicular condition.  Therefore, if ki perpendicular U/V is defined as
// the new S1=0, that virtual Bragg observation has S1_ref = -S2_ref/2.
function effectiveOrientationReference(rl, fixedEnergyMeV=null, conventionOverride=null){
  const rawMode=$('orientationReference')?.value || 'bragg';
  const mode=canonicalOrientationMode(rl,rawMode);
  if(mode==='bragg'){
    return {mode,hkl:[num('refh'),num('refk'),num('refl')],s1:num('refs1')};
  }
  const usesV=mode==='perpV' || mode==='parallelV';
  const isParallel=mode==='parallelU' || mode==='parallelV';
  const hkl=usesV
    ? [num('Vh'),num('Vk'),num('Vl')]
    : [num('Uh'),num('Uk'),num('Ul')];
  const qNorm=norm(hklToQ(rl,hkl));
  const E=Number(fixedEnergyMeV);
  if(!(qNorm>1e-12)) throw new Error(`${usesV?'V':'U'} must define a non-zero reciprocal-space vector.`);
  if(!(E>0)) throw new Error('A positive reference energy is required for ki orientation.');
  const k=Math.sqrt(E/2.072);
  const arg=qNorm/(2*k);
  if(arg>1+1e-10) throw new Error(`${usesV?'V':'U'} Bragg peak is inaccessible at the selected reference energy.`);
  const s2Ref=2*rad2deg(Math.asin(clamp(arg,-1,1)));

  // The virtual Bragg reference follows the selected physical Sense and encoder polarity.
  let convention;
  if(conventionOverride && typeof conventionOverride==="object" && "sense" in conventionOverride){
    convention=tasConvention(conventionOverride.sense,conventionOverride.s1sign);
  }else if(typeof conventionOverride==="string"){
    const legacy=tasConventionFromLegacyUiSense(conventionOverride);
    convention=tasConvention(legacy.sense,legacy.s1sign);
  }else{
    convention=tasConvention(selectedTasSense(),selectedS1Sign());
  }
  // The virtual Bragg reference follows the same S2 motor polarity as the
  // selected instrument convention.  Keep the reference zero and motor sign
  // separate instead of routing through the historical four-state labels.
  const c2Sign=-convention.s2EncoderSign;
  let s1Ref=-c2Sign*0.5*s2Ref;
  // ki ∥ U/V uses the same virtual elastic Bragg reference as ki ⟂ U/V,
  // but moves the S1=0 sample orientation by +90 degrees about the plane normal.
  if(isParallel) s1Ref+=c2Sign*90;
  return {mode,hkl,s1:wrap180(s1Ref),s2Ref};
}

function tasMotorAngles(calc,b){
  const em=b.config.energy_mode;
  let Ei,Ef;
  if(em==='Ei fixed'){
    Ei=Number(b.config.Ei);
    Ef=Ei-Number(calc.hw);
  }else{
    Ef=Number(b.config.Ef);
    Ei=Ef+Number(calc.hw);
  }
  if(!(Ei>0) || !(Ef>0)) throw new Error('Ei and Ef must be positive to calculate TAS angles.');

  const ki=Math.sqrt(Ei/2.072);
  const kf=Math.sqrt(Ef/2.072);

  const braggAngle=(E,d,label)=>{
    const k=Math.sqrt(E/2.072);
    const arg=(2*PI/Number(d))/(2*k);
    if(arg>1+1e-12 || arg<-1-1e-12){
      throw new Error(`${label} Bragg condition is inaccessible at the selected energy.`);
    }
    return rad2deg(Math.asin(clamp(arg,-1,1)));
  };

  let m1abs=braggAngle(Ei,b.mos.d_mono,'Monochromator');
  let a1abs=braggAngle(Ef,b.mos.d_ana,'Analyzer');
  if(b.config.geometry==='anti-W') a1abs=-a1abs;

  const convention=tasConvention(
    b.config.sense ?? selectedTasSense(),
    b.config.s1sign ?? selectedS1Sign()
  );
  const m1=convention.monoSign*m1abs;
  const m2=2*m1;
  const a1=convention.analyzerSign*a1abs;
  const a2=2*a1;

  const target=[Number(calc.h),Number(calc.k),Number(calc.l)];
  const Qt=hklToQ(b.rl,target);
  const QtNorm=norm(Qt);
  if(QtNorm<1e-12) throw new Error('Q = 0 cannot define TAS sample angles.');

  const cosS2=(ki*ki+kf*kf-QtNorm*QtNorm)/(2*ki*kf);
  if(cosS2<-1-1e-10 || cosS2>1+1e-10){
    throw new Error('The requested Q and energy transfer are kinematically inaccessible.');
  }
  const s2abs=rad2deg(Math.acos(clamp(cosS2,-1,1)));
  // S2 encoder polarity is derived from physical Sense and S1 encoder polarity.
  const s2=convention.s2EncoderSign*s2abs;

  // Reference-Q calibration of S1.
  // The entered Reference Q is observed at refs1 in the elastic condition.
  const U=b.lc.sv1, V=b.lc.sv2;
  const {ex,ey}=makeSpiceScatteringPlaneBasis(b.rl,U,V);
  const qAngle=(q,{allowZeroProjection=false}={})=>
    tasCrystalPhiDegForConvention(
      q,ex,ey,convention.sense,convention.s1sign,{allowZeroProjection}
    );

  // Reference Q is needed only for the optional S1/S2 angle calibration.
  // A bad Reference Q must never suppress an otherwise valid resolution result.
  const fixedE=em==='Ei fixed' ? Number(b.config.Ei) : Number(b.config.Ef);
  const orientationRef=effectiveOrientationReference(b.rl,fixedE,convention);
  const ref=orientationRef.hkl;
  const Qr=hklToQ(b.rl,ref);
  const QrNorm=norm(Qr);

  if(QrNorm<1e-12){
    return {Ei,Ef,m1,m2,s1:null,s2,a1,a2,
      warning:'Reference Q is zero; S1 is unavailable.'};
  }

  const k0=Math.sqrt(fixedE/2.072);
  const cosRef=(2*k0*k0-QrNorm*QrNorm)/(2*k0*k0);
  if(cosRef<-1-1e-10 || cosRef>1+1e-10){
    return {Ei,Ef,m1,m2,s1:null,s2,a1,a2,
      warning:'Reference Q is outside the measurable range at the selected reference energy; S1 is unavailable.'};
  }
  const s2Ref=convention.s2EncoderSign*rad2deg(Math.acos(clamp(cosRef,-1,1)));

  // S1 is a physical sample-axis encoder calibration and must not change when
  // the TAS sign configuration is switched.  The validated -+- convention
  // uses the positive scattering branch, so use that same branch for the S1
  // UB/reference calculation in both -+- and +-+.  Only the displayed/physical
  // S2 motor angle above retains senseS.
  const s2ForS1=rad2deg(Math.acos(clamp(cosS2,-1,1)));
  const s2RefForS1=rad2deg(Math.acos(clamp(cosRef,-1,1)));

  // Match the validated Python UB/reference geometry exactly.  In the
  // canonical PDF frame, +z is the incident beam and +x is the in-plane
  // transverse direction.  For a horizontal detector:
  //   Q_lab = (-kf*sin(S2), 0, ki-kf*cos(S2))
  // and the physical sample rotation is
  //   omega = atan2(Qlab_x,Qlab_z) - atan2(Q0_x,Q0_z).
  // Reference Q determines omega_ref only; the encoder offset is then
  // transferred to the target by S1 = S1_ref + (omega_target-omega_ref).
  // makeSpiceScatteringPlaneBasis gives ex along entered U and ey along the
  // entered-V side of the in-plane transverse direction.  These correspond to PDF z and
  // PDF x respectively, so atan2(ey,ex) is atan2(Q0_x,Q0_z).
  const phiTarget=qAngle(Qt);
  const phiRef=qAngle(Qr,{allowZeroProjection:true});
  const omegaTarget=wrap180(tasPhiLabDegForConvention(ki,kf,s2ForS1,convention.sense,convention.s1sign)-phiTarget);
  const omegaRef=wrap180(tasPhiLabDegForConvention(k0,k0,s2RefForS1,convention.sense,convention.s1sign)-phiRef);

  // The validated Python simulation uses C2_TO_OMEGA_SIGN = +1 for its
  // native scattering sense.  The opposite TAS sign configuration is the
  // left/right-mirrored instrument, so its sample encoder must run with the
  // opposite C2->omega sign.  Without this factor +-+ and -+- collapse onto
  // the same S1 solution after the signed-S2 geometry is formed.
  //
  //   omega = omega_ref + c2Sign * (S1-S1_ref)
  //   S1    = S1_ref + (omega-omega_ref)/c2Sign
  //
  // Sample encoder conversion is provided by the common convention object.
  const c2Sign=convention.c2ToOmegaSign;
  const s1=orientationRef.s1 + angleDiffDeg(omegaTarget,omegaRef)/c2Sign;

  return {Ei,Ef,m1,m2,s1,s2,a1,a2,warning:''};
}


  return {
    canonicalOrientationMode,
    effectiveOrientationReference,
    tasMotorAngles
  };
}
