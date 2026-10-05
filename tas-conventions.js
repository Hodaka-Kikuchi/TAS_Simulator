// TAS configuration/sign-convention helpers extracted from app.js.
// This module is intentionally UI-free: it contains only numerical/sign logic.

import {
  deg2rad, rad2deg, dot, norm, normalize, sub, scale
} from "./tas-core.js";

export function legacyTasSense(uiSense){
  // Used where the old public sign labels themselves are required (Resolution,
  // displayed S2 sign, schematic left/right placement).
  if(uiSense==="+++") return "+-+";
  if(uiSense==="---") return "-+-"; // --- shares the validated -+- physical branch
  return uiSense;
}
export function calculationTasSense(uiSense){
  if(uiSense==="+++") return "-+-"; // exact former user-facing +-+ behavior
  if(uiSense==="+-+") return "+-+"; // native/pure +-+ branch from reference code
  if(uiSense==="-+-") return "+-+"; // existing validated user-facing -+- mapping
  if(uiSense==="---") return "+-+"; // same physical branch as -+-, S1 encoder sign is reversed separately
  return uiSense;
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

// Pure +-+ (HODACA) uses the opposite detector-side Q_lab convention from the
// legacy +++ / validated -+- branches.  Keep the legacy helper above unchanged
// so +++ and -+- remain byte-for-byte equivalent in their angle calibration.
// For pure +-+, positive S2 is on the +transverse side and positive S1 is CW.
export function tasPhiLabDegForUiSense(ki,kf,s2deg,uiSense){
  if(uiSense!=="+-+") return tasPhiLabDeg(ki,kf,s2deg);
  const t=deg2rad(s2deg);
  const qx=+kf*Math.sin(t);
  const qz= ki-kf*Math.cos(t);
  return rad2deg(Math.atan2(qx,qz));
}

// Crystal in-plane azimuth convention used by the sample S1 encoder.
//
// The +++ instrument's driving software uses the right-handed crystal
// convention that is obtained from the entered plane by reversing the V-side
// transverse axis (equivalently, entering V -> -V for the angle calibration).
// Keep the user's U/V values themselves unchanged: W, reciprocal-space plots,
// and resolution still describe the entered scattering plane.  Only the
// azimuth used to convert between crystal Q and the S1 motor is mirrored.
// This is an angular reflection phi -> -phi, NOT a blanket +/-180 deg shift.
export function tasCrystalAzimuthHandedness(uiSense){
  return uiSense==="+++" ? -1 : +1;
}
export function tasCrystalPhiDeg(q,ex,ey,uiSense,{allowZeroProjection=false}={}){
  const x=dot(q,ex);
  const y=tasCrystalAzimuthHandedness(uiSense)*dot(q,ey);
  if(Math.hypot(x,y)<1e-12){
    if(allowZeroProjection) return 0;
    throw new Error('Calculation Q has no in-plane component and cannot define the TAS sample orientation.');
  }
  return rad2deg(Math.atan2(y,x));
}
export function tasPlotPhiFromCrystalPhi(phiDeg,uiSense){
  return wrap180(tasCrystalAzimuthHandedness(uiSense)*Number(phiDeg));
}

export function calcQ0(s1,s2,ki,kf,s1Offset,refS1,QrefXY,sense,s1Calibration=null){
  if(s1Calibration){
    // Exact inverse of tasMotorAngles() S1 calibration:
    //
    //   S1 = S1ref + (omegaTarget-omegaRef)/c2Sign
    //
    // therefore
    //
    //   omegaTarget = omegaRef + c2Sign*(S1-S1ref)
    //
    // tasMotorAngles() deliberately uses the positive |S2| branch for the S1
    // orientation calibration in both TAS configurations, so do the same here.
    const qMag=Math.sqrt(Math.max(0,ki*ki+kf*kf-2*ki*kf*Math.cos(deg2rad(s2))));
    const omegaTarget=s1Calibration.omegaRef
      + s1Calibration.c2Sign*(s1-s1Calibration.refS1);
    // Do not apply any extra Q-space mirror/arc correction here.
    // Angle calculation already defines the calibrated relation between
    // S1, |S2| and the reciprocal-space azimuth.  Using its exact inverse
    // keeps the Q-E boundary on the same HKL side as Angle calculation.
    let phiTarget;
    if(s1Calibration.uiSense==="-+-" || s1Calibration.uiSense==="---"){
      // IMPORTANT: preserve the original -+- inverse calculation exactly.
      // Do not route -+- through the +++ handedness helpers.
      phiTarget=deg2rad(
        wrap180(tasPhiLabDegForUiSense(ki,kf,s2,s1Calibration.uiSense)-omegaTarget)
      );
    }else{
      const phiCrystal=wrap180(
        tasPhiLabDegForUiSense(ki,kf,s2,s1Calibration.uiSense)-omegaTarget
      );
      // +++ uses the corrected right-handed crystal azimuth. +-+ is unchanged.
      phiTarget=deg2rad(tasPlotPhiFromCrystalPhi(phiCrystal,s1Calibration.uiSense));
    }
    return [qMag*Math.cos(phiTarget),qMag*Math.sin(phiTarget)];
  }

  // Fallback only when a usable S1 reference calibration is unavailable.
  const kiAngle=deg2rad(-s1+s1Offset+refS1);
  const kfAngle=deg2rad(s2-s1+s1Offset+refS1);
  let q=[ki*Math.sin(kiAngle)-kf*Math.sin(kfAngle),
         ki*Math.cos(kiAngle)-kf*Math.cos(kfAngle)];
  if(sense==="+-+" && norm(QrefXY)>1e-10){
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
