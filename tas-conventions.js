// TAS configuration/sign-convention helpers extracted from app.js.
// This module is intentionally UI-free: it contains only numerical/sign logic.

import {
  deg2rad, rad2deg, dot, norm, normalize, sub, scale
} from "./tas-core.js";


export function normalizeTasSense(value){
  return (value==="-+-" || value==="---") ? "-+-" : "+-+";
}

export function normalizeS1Sign(value){
  return String(value??"").trim().toLowerCase()==="cw" ? "cw" : "ccw";
}

// One source of truth for TAS scattering sense and sample-axis encoder polarity.
// Physical scattering geometry is selected by `sense`; S1 encoder polarity is
// independent and is selected by `s1sign`.  S2 polarity follows from both:
//   S2 sign = sample-scattering sign (middle sign of Sense) * S1 polarity.
// This gives the validated instrument combinations:
//   +-+ / CCW -> S2 -,  +-+ / CW -> S2 +
//   -+- / CCW -> S2 +,  -+- / CW -> S2 -
export function tasConvention(sense,s1sign="ccw"){
  const physicalSense=normalizeTasSense(sense);
  const motorSign=normalizeS1Sign(s1sign);
  const s1EncoderSign=motorSign==="ccw" ? +1 : -1; // physical CCW -> motor + for CCW-positive
  const monoSign=physicalSense==="+-+" ? +1 : -1;
  const sampleScatteringSign=physicalSense==="+-+" ? -1 : +1;
  const analyzerSign=monoSign;
  const s2EncoderSign=sampleScatteringSign*s1EncoderSign;

  // Crystal/Q-space handedness is a property of physical scattering Sense;
  // encoder polarity is handled independently by s1EncoderSign.
  const crystalAzimuthHandedness=physicalSense==="+-+" ? -1 : +1;
  const ccwC2ToOmegaSign=physicalSense==="+-+" ? -1 : +1;
  const c2ToOmegaSign=ccwC2ToOmegaSign*s1EncoderSign;

  return {
    sense:physicalSense,
    s1sign:motorSign,
    s1EncoderSign,
    monoSign,
    sampleScatteringSign,
    analyzerSign,
    s2EncoderSign,
    crystalAzimuthHandedness,
    ccwC2ToOmegaSign,
    c2ToOmegaSign
  };
}




export function wrap180(x){
  let y=(Number(x)+180)%360;
  if(y<0) y+=360;
  return y-180;
}

export function angleDiffDeg(a,b){
  return wrap180(Number(a)-Number(b));
}

export function tasPhiLabDeg(ki,kf,s2deg){
  const t=deg2rad(s2deg);
  const qx=-kf*Math.sin(t);
  const qz= ki-kf*Math.cos(t);
  return rad2deg(Math.atan2(qx,qz));
}


// Canonical physical Q_lab convention for the refactored Sense/S1-sign model.
// It intentionally depends on scattering Sense only; changing S1 encoder
// polarity must never mirror reciprocal-space geometry.
export function tasPhiLabDegForConvention(ki,kf,s2deg,sense,s1sign="ccw"){
  void s1sign;
  normalizeTasSense(sense);
  return tasPhiLabDeg(ki,kf,s2deg);
}

// Crystal in-plane azimuth convention used by the sample S1 encoder.

export function tasCrystalPhiDegForConvention(q,ex,ey,sense,s1sign="ccw",{allowZeroProjection=false}={}){
  const handedness=tasConvention(sense,s1sign).crystalAzimuthHandedness;
  const x=dot(q,ex), y=handedness*dot(q,ey);
  if(Math.hypot(x,y)<1e-12){
    if(allowZeroProjection) return 0;
    throw new Error('Calculation Q has no in-plane component and cannot define the TAS sample orientation.');
  }
  return rad2deg(Math.atan2(y,x));
}
export function tasPlotPhiFromCrystalPhiForConvention(phiDeg,sense,s1sign="ccw"){
  return wrap180(tasConvention(sense,s1sign).crystalAzimuthHandedness*Number(phiDeg));
}

export function calcQ0(s1,s2,ki,kf,s1Offset,refS1,QrefXY,sense,s1Calibration=null){
  if(s1Calibration){
    // Exact inverse of tasMotorAngles() S1 calibration.  The calibration carries
    // the physical Sense/S1-sign convention directly; no legacy four-state
    // label participates in this conversion.
    const qMag=Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(deg2rad(s2))));
    const omegaTarget=s1Calibration.omegaRef
      + s1Calibration.c2Sign*(s1-s1Calibration.refS1);
    const physicalSense=normalizeTasSense(s1Calibration.sense ?? sense);
    const motorSign=normalizeS1Sign(s1Calibration.s1sign);
    const handedness=Number.isFinite(Number(s1Calibration.crystalAzimuthHandedness))
      ? Number(s1Calibration.crystalAzimuthHandedness)
      : tasConvention(physicalSense,motorSign).crystalAzimuthHandedness;
    const phiCrystal=wrap180(
      tasPhiLabDegForConvention(ki,kf,s2,physicalSense,motorSign)-omegaTarget
    );
    const phiTarget=deg2rad(wrap180(handedness*phiCrystal));
    return [qMag*Math.cos(phiTarget),qMag*Math.sin(phiTarget)];
  }

  // Fallback only when a usable S1 reference calibration is unavailable.
  const kiAngle=deg2rad(-s1+s1Offset+refS1);
  const kfAngle=deg2rad(s2-s1+s1Offset+refS1);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];
  // The old fallback reflection belonged to the physical -+- geometry; express
  // it directly in physical Sense rather than through the swapped calculation key.
  if(normalizeTasSense(sense)==="-+-" && norm(QrefXY)>1e-10){
    const eQ=normalize(QrefXY);
    q=sub(scale(eQ,2*dot(q,eQ)),q);
  }
  return q;
}

export function calcQDark(s1,s2,ki,kf,s1Offset,QrefXY,sense,energyMode=null){
  const kiAngle=deg2rad(-s1+s1Offset);
  const kfAngle=deg2rad(s2-s1+s1Offset);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];

  // Keep the already-validated elastic handedness mapping first.  For +-+ this
  // is the existing reflection about Reference Q; -+- uses the raw geometry.
  // Apply exactly the same mapping to the corresponding elastic-Q vector so it
  // can serve as the local angular reference for the inelastic correction.
  const kElastic=energyMode ? ((energyMode==="Ef fixed") ? kf : ki) : null;
  let qElastic=energyMode ? [kElastic*(Math.sin(kiAngle)-Math.sin(kfAngle)),
                             kElastic*(Math.cos(kiAngle)-Math.cos(kfAngle))] : null;

  if(sense==="+-+" && norm(QrefXY)>1e-10){
    const eQ=normalize(QrefXY);
    q=sub(scale(eQ,2*dot(q,eQ)),q);
    if(qElastic) qElastic=sub(scale(eQ,2*dot(qElastic,eQ)),qElastic);
  }

  // The elastic dark regions are correct for both senses.  Away from hw=0 the
  // ki-kf triangle's azimuthal displacement has the opposite sign to the TAS
  // geometry in BOTH senses.  Reflect only that inelastic displacement about
  // the sense-correct elastic-Q direction.  At hw=0 q==qElastic, so this is an
  // exact identity and cannot move the validated elastic boundaries.
  if(qElastic && norm(qElastic)>1e-10){
    const e0=normalize(qElastic);
    q=sub(scale(e0,2*dot(q,e0)),q);
  }
  return q;
}
