# v66 sign-convention correction

- `+++` now preserves the complete former user-facing `+-+` behavior, including Angle calculation and TAS geometry placement.
- Restored a separate native `+-+` branch using the supplied reference-code convention: M/S/A signs `(+,-,+)` and `c2Sign=+1` for S1, giving clockwise-positive S1.
- Native `+-+` Q-E boundaries use the supplied reference `calcQ0` motor formula rather than the later instrument-specific exact-inverse calibration.
- `-+-` keeps its existing behavior.
- Instrument JSON sign values are read as written; a JSON `+++` selects `+++`.
- No Sample-orientation controls or unrelated features were removed.

## v68 pure +-+ S1 fix without touching validated +++ / -+-
- Rebased the sign work on v66 so validated +++ and -+- numerical/display behavior is preserved.
- Fixed the v67 `uiSense is not defined` regression in `tasMotorAngles()` by carrying the raw UI sign in resolution/geometry config and defining it locally before use.
- Pure +-+ only: S1 encoder is clockwise-positive. Hexagonal HK0 calibration therefore maps 100 @ S1=0 deg to 010 @ S1=+60 deg.
- Pure +-+ only: matching S1 convention is used for virtual ki-perpendicular/parallel orientation references, Q-E S1 calibration, geometry quick-orientation targeting, and sample-attached Dark-angle display rotation.
- JSON files are unchanged.

## v69 pure +-+ TAS Geometry U/V handedness
- Changed only the TAS Geometry U/V display for the pure `+-+` sign.
- Pure `+-+` now rotates the crystallographic U/V frame with the same clockwise-positive `phiRef - phiTarget` convention as its sample-attached Dark angle.
- Hexagonal check: with `(1,0,0)` referenced at S1 = 0°, moving to `(0,1,0)` rotates the displayed U/V frame by 60° clockwise.
- `+++` and `-+-` calculation/display branches are unchanged from v68.

## v70 pure +-+ HODACA angle calibration
- Corrected only the pure `+-+` branch; `+++` and `-+-` retain their v69 behavior.
- Pure `+-+` now uses positive physical S2 in Angle calculation.
- Added a pure-`+-+` Q_lab azimuth convention with the transverse component on the opposite detector side while keeping positive S1 clockwise.
- The S1/Q inverse used by the Q-E range now uses the same pure-`+-+` calibration as Angle calculation.
- Regression target: with the recovered HODACA geometry, `(0,0,3) @ S1=-59.36 deg` maps `(1.5,0,0)` to approximately `S1=+54.2 deg`, `S2=+109.2 deg` at 3.635 meV.

## v71 pure +-+ S2 display / schematic direction
- Pure `+-+` now displays S2 as positive in Angle calculation / result summaries.
- Pure `+-+` TAS Geometry draws positive S2 clockwise.
- `+++` and `-+-` display and drawing branches are unchanged.

## v72 Bragg orientation plane warning
- Added a non-blocking warning for Sample orientation > Bragg peak position when the entered reference HKL is outside the current U-V scattering plane.
- The warning updates live when lattice parameters, U/V, or the reference h/k/l values change.
- Uses the existing `hklInCurrentScatteringPlane()` test; no TAS angle, Q-E, Resolution, or Dark-angle calculation was changed.

## v73 Script reachability and Dark-angle warnings
- Added non-invasive validation warnings for Script / Time estimate motion commands without changing TAS, Q-E, resolution, or Dark-angle numerical calculations.
- HKLE / br / QE targets now warn when the selected Ei/Ef cannot form a scattering triangle, or when the resulting |S2| is below the current S2 minimum or above the energy-dependent instrument S2 maximum.
- HKLE / br points also warn when the resolved HKL lies outside the current U-V scattering plane.
- Angle calculation & TAS geometry now reports `ki blocked`, `kf blocked`, and/or `fixed blocked` when the current HKLE point falls inside the already-calculated Dark-angle masks.
- Script HKLE / br commands use the same existing Dark-angle masks and report the corresponding block warning. These warnings propagate to SPICE line highlighting / diagnostics through the existing validation system.
- +++, +-+, and -+- angle / geometry calculations are unchanged.
