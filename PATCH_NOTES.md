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

## v74 Toolbox S2 conversion
- Added a compact **S2 conversion** card to Toolbox for converting an observed X-ray diffraction S2 (2theta) to the corresponding neutron S2 for the current fixed Ei/Ef.
- X-ray source presets: Cu Kα1, Mo Kα1, Co Kα1, Fe Kα1, Cr Kα1, and Ag Kα1. Selecting a source fills its wavelength automatically; the wavelength remains editable and switches the source to Custom when manually changed.
- The neutron wavelength is derived automatically from the current Instrument configuration fixed energy.
- Conversion preserves the observed d-spacing using Bragg's law. If the neutron wavelength cannot satisfy the Bragg condition, a warning is shown instead of a result.
- Existing TAS/Q-E/Angle/Dark-angle numerical calculations are unchanged.

## v75 documentation / S2 conversion cleanup
- Removed the successful-result helper text that displayed the derived d-spacing and neutron wavelength below **S2 conversion**. Warning messages remain available in the same area.
- Replaced the accumulated historical README with a concise description of the current simulator, its workspaces, sign conventions, data layout, and local-use instructions.


## v76 Script th2th state tracking
- Script/Time estimate warning evaluation now treats `th2th` as a relative scan of S2.
- Each `th2th` point is checked at `base S2 + offset`, where base S2 is reconstructed from the most recent preceding position-defining Script command.
- State tracking recognizes preceding absolute/relative S2, `br`, HKLE drive/scan, QE scan, and prior `th2th` end positions.
- If no preceding position-defining command establishes S2, a warning is shown instead of treating the th2th values as absolute S2.
- Numerical TAS/Q-E/Dark-angle calculations are unchanged; only Script state tracking and warning evaluation were modified.


## v77 Script state-tracking hotfix
- Fixed `ReferenceError: timePreviousS2Position is not defined` introduced in v76.
- The Script S2 state-tracking logic and th2th relative-scan behavior are otherwise unchanged.
- No TAS/Q-E/Dark-angle/Resolution calculation logic was changed.

## v78 Script expression evaluation / Plot resize hotfix
- Extended Script / Time estimate fixed-value expressions to support `+`, `-`, `*`, `/`, parentheses, fractions, and enclosing `loopN` variables.
- SPICE imports such as `4/6+(%i-1)*1/6` are converted to `4/6+(loop1-1)*1/6` and evaluated separately for each loop iteration.
- Existing three-value scan ranges such as `6 -0.4 0.1` retain their previous interpretation.
- Plotly resize calls now run only for connected, displayed plots with non-zero dimensions, and asynchronous resize rejections are handled to avoid `Resize must be passed a displayed plot div element.` console errors.
- No TAS / Q-E / Angle / Dark-angle / Resolution numerical calculation logic was changed.

## v79 SPICE macro loop-expression export
- Fixed Time estimate -> SPICE macro conversion so `loopN` references are translated even when embedded inside arithmetic expressions.
- Example: `4/6+(loop1-1)*1/6` now exports as `4/6+(%i-1)*1/6` inside the matching first loop.
- Existing `scantitle` loop-variable conversion is unchanged.
- No TAS / Q-E / Angle / Dark-angle / Resolution numerical calculation logic was changed.

## v80 Script loop expressions / nested-loop reordering
- Single-value Script / Time estimate fields now use the same arithmetic parser as scan fixed values, so expressions such as `loop1-1`, `(loop2+1)/6`, and `4/6` are accepted wherever a numeric target value is valid.
- Loop references inside those expressions stay bound to their enclosing loop pair and are renumbered when nested loops are reordered.
- Normal index drag of `loopN` / `endloopN` now moves the complete paired loop block, including nested contents, so nested loops can be reordered as units without breaking their structure.
- Alt-drag on a loop boundary retains the boundary-only scope-resize behavior.
- No TAS / Q-E / Angle / Dark-angle / Resolution numerical calculation logic was changed.

## v81 ASET <value> expression validation fix
- Fixed the remaining legacy ASET `<value>` validator that still accepted only plain numbers or a bare `loopN` token.
- ASET scalar fields now use the same arithmetic-expression parser as the rest of Script / Time estimate, so forms such as `loop1-1`, `(loop2+1)/6`, and `4/6+(loop1-1)*1/6` validate correctly when their loop references are in scope.
- Loop-reference metadata is preserved so reordering and SPICE round-tripping stay consistent.
- No TAS / Q-E / Angle / Dark-angle / Resolution numerical calculation logic was changed.

## v82 scantitle quote handling
- Time estimate `scantitle` entries no longer require surrounding double quotes.
- SPICE macro generation now adds exactly one pair of double quotes automatically.
- Existing quoted entries are accepted without producing doubled quotes.
- SPICE macro import strips the outer `scantitle` quotes before populating Time estimate commands.
- Removed development backup/debug files from the distribution folder.

## v83 Script UI safety and layout
- When ASET is visible, the Script workspace uses an equal 1:1:1 width ratio for ASET / Time estimate commands / SPICE macro on desktop widths.
- The ASET template placeholder now shows `scan device <range>` instead of `scan e <range>`.
- Commands -> SPICE and SPICE -> Commands are now explicit one-shot conversions only. Editing either side never automatically overwrites the other side after an arrow conversion.
- Non-warning explanatory help for ASET and Time estimate / Calc MCU is hidden behind `Info` buttons. Warning and error messages remain directly visible.
- No TAS angle, Q-E, Dark-angle, or Resolution calculation logic was changed.


## v84 Script readability
- Enlarged the Info buttons.
- In Script / Time estimate, moved the Time estimate Info button to the left of Hide ASET.
- Enlarged ASET Info help text.
- Enlarged SPICE macro editor text and matching line-number/backdrop text.
- No calculation logic changes.


## v85 ASET Info presentation
- Changed only the ASET help presentation in Script / Time estimate.
- The ASET Info button now opens the same bordered Info-panel style used by Time estimate Info.
- ASET help text/content is unchanged; calculation and command conversion logic are unchanged.

## v86
- GitHub Pages no longer probes missing optional `BG_material/`, `sample_environments/`, or legacy `instruments/` directories at startup, eliminating their noisy 404 requests.
- The unified `instrument/` source and calculation logic are unchanged.


## v87 S2 conversion multi-peak input
- `Observed X-ray S2 (deg)` now accepts multiple values separated by spaces.
- Each input peak is converted independently using the selected X-ray wavelength and current fixed neutron Ei/Ef.
- Results are shown in a compact table with X-ray S2, d-spacing, and neutron S2.
- Peaks with no neutron Bragg solution are flagged per row.
- No TAS angle, Q-E, Dark-angle, or Resolution calculation logic was changed.


## v88 S2 conversion layout
- Restored the S2 conversion controls to a single horizontal row.
- Reordered result columns to X-ray S2, Neutron S2, d, so d-spacing appears last.
- Conversion calculations are unchanged.

## v89 S2 conversion single-row layout
- Restored S2 conversion to one horizontal row with six fields: X-ray source, X-ray wavelength, observed X-ray S2, neutron wavelength, neutron S2, and d.
- Neutron wavelength, neutron S2, and d are read-only.
- Multiple observed X-ray S2 values remain supported; converted neutron S2 and d values are shown as space-separated values in their read-only fields.

## v90 Q vector-E BG material overlay
- Q vector-E map now overlays selected BG material powder reflections.
- Each BG powder |Q| ring is intersected with the selected HKL path; every real intersection is drawn at the corresponding path coordinate.
- If one powder ring intersects the path twice, both lines are shown.
- BG line color/intensity and hover information reuse the existing Powder Q-E conventions.
- No Angle, TAS geometry, Q-E reachability, dark-angle, or resolution calculation logic was changed.

## v91 Q vector–E legend and HKL ticks
- Matched Q vector–E legend ordering to the Constant E map: Accessible Q, BG materials, then dark-angle overlays.
- Extended HKL tick detection across the full displayed Q-vector horizontal range, not only between HKL1 and HKL2.
- Every displayed-axis point where h, k, and l are all integers is now added as an HKL tick label.
- No Q–E reachability, angle, dark-angle, or resolution calculation logic was changed.

## v93 Angle calculation Single / Scan
- Added Single / Scan tabs inside Angle calculation & TAS geometry for Single-crystal samples.
- Single keeps the existing H/K/L/ħω target and Set U/V / orientation buttons, but removes the separate ħω slider.
- Scan adds initial and final H/K/L/ħω entries plus Points, matching the Resolution scan-style input pattern.
- Added a Point slider; the selected interpolated scan point drives the existing TAS geometry drawing.
- Scan angle results are shown as a table for every point, with the selected point highlighted and existing warning information retained.
- Scan mode does not show Set U/V / orientation shortcut buttons.
- Existing TAS motor-angle, Q-E, dark-angle, and resolution calculation formulas are unchanged.

## v94 Angle calculation scan UI
- Unified the Single / Scan tabs with the same tab design used by the main Angle calculation & TAS geometry / Time estimate tabs.
- Scan input fields now use equal-width columns; the cell below Points is intentionally left blank.
- Added matching Table / TAS geometry tabs below the scan inputs.
- Table view uses a white background and scrolls within its frame when the result table is wider/taller than the available area.
- TAS geometry view contains the Point slider and the existing TAS geometry plot.
- Existing angle/motor calculations are unchanged.

## v95 Scan table readability and status
- Scan table rows can now be clicked to highlight a row independently of the TAS geometry Point slider.
- H/K/L/ħω are shown to 3 decimal places with narrower columns.
- Increased scan-table text and cell sizing for readability while retaining scroll overflow.
- Scan Status now reports S1 out of range, S2 out of range, and No scattering triangle, in addition to existing Dark-angle warnings.
- Angle/motor calculation formulas are unchanged.
## v96 Q vector-E Dark-angle display outside Accessible Q
- Q vector-E Dark-angle overlays are no longer clipped to the Accessible Q polygon.
- Dark angle (ki/kf/fixed) regions are displayed anywhere they intersect the currently displayed Q-vector–E axes.
- The Accessible Q calculation itself is unchanged.


## v97 data-loader repair
- Restored GitHub Pages loading for `BG_material` CIF files and `sample_environments` JSON files (including Dark-angle definitions).
- GitHub Pages now discovers JSON/CIF files from the current Pages repository via the GitHub contents API before trying any manifest, so missing `index.json` files no longer generate startup 404s.
- Removed the v86 behavior that skipped BG/sample-environment loading entirely on GitHub Pages.
- GitHub repository discovery follows the current Pages owner/repository and uses the repository default branch rather than hard-coding `main`.
- Instrument/Angle/Q-E/Resolution calculation logic is unchanged.

## v98 Scan table No./status/geometry linkage
- Renamed the Angle calculation scan table first column from `Point` to `No.`.
- Status cells with warnings/errors are now shown in vermilion and bold.
- Clicking a table row now selects the same scan No. for TAS geometry and updates the geometry slider.
- Moving the TAS geometry slider highlights the matching table row.
- Angle calculation formulas and reachability logic are unchanged.


## v99 Scan table warning rows and tab persistence
- Scan table Status text is black again. Rows with any Status are highlighted with a vermilion background.
- Table row selection remains synchronized with the TAS geometry No. slider; warning rows retain their vermilion highlight and show a selection outline.
- The added Single/Scan tab and Table/TAS geometry tab now persist their last selected state in localStorage and are restored on reload.
- No angle, Q-E, dark-angle, or resolution calculation formulas were changed.

## v100 Angle scan row color and tab persistence
- Softened the warning-row highlight in the Angle calculation Scan table to a pale vermilion background while keeping Status text black.
- Strengthened persistence for the Angle calculation `Single / Scan` and Scan output `Table / TAS geometry` tabs.
- Geometry sub-tab state is now stored both in dedicated localStorage keys and in right-panel state, then re-applied after dynamic UI/right-panel restoration so initialization cannot reset it.
- No TAS calculation logic was changed.
