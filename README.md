# TAS Q-E Range & Resolution Simulator

Browser-based simulator for triple-axis neutron spectrometers. The current version combines Q-E accessibility, TAS geometry, resolution calculation, scripting/time estimation, CIF utilities, and compact neutron/X-ray conversion tools in one interface.

## Main workspaces

### Q-E Range
- Single-crystal and powder Q-E accessibility calculations.
- Constant-E reciprocal-space map and Q vector–E map.
- Q vector–E Dark-angle overlays remain visible even where they extend outside the Accessible Q region.
- Nuclear/magnetic Bragg peak display, background scattering, and Dark-angle overlays.
- Angle calculation & TAS geometry using the selected instrument sign convention.
- Angle calculation supports Single and Scan modes; Scan interpolates H/K/L/ħω between initial/final points, shows all motor angles in a table, and uses a Point slider to inspect the corresponding TAS geometry.
- Sample-orientation reference by ki ⟂ U, ki ⟂ V, or observed Bragg peak position.
- Bragg-reference warning when the entered HKL is outside the current U-V scattering plane.
- Dark-angle status warnings for the current geometry (`ki blocked`, `kf blocked`, `fixed blocked`).

### Resolution
- TAS resolution calculation with the instrument parameters loaded from JSON.
- Resolution recalculates automatically when its calculation point or instrument settings change; no Calculate button is required.
- Resolution ellipses and matrices for the selected calculation point.

### Script / Time estimate
- With ASET visible, the desktop workspace uses equal-width ASET / Time estimate commands / SPICE macro panes.
- ASET and Time estimate explanatory help is available from compact `Info` buttons; warnings/errors remain visible.
- `→ SPICE` and `← Commands` are explicit one-shot conversions. Editing one side does not automatically overwrite the other side.
- `th2th` is interpreted as a relative S2 scan for Script warning checks; its offsets are evaluated from the S2 position reached by preceding movement commands.
- Command-table editor with drive/scan/scanrel/loop/count/wait/scantitle and supported targets.
- SPICE macro conversion in both directions.
- Time-estimate expressions support arithmetic, parentheses, fractions, and enclosing `loopN` variables (for example `4/6+(loop1-1)*1/6`); SPICE export converts embedded `loopN` references back to `%i`, `%j`, etc.
- Numeric target fields also accept loop arithmetic such as `loop1-1`; nested loop blocks can be reordered by dragging their Index, while Alt-drag adjusts a loop boundary only.
- ASET templates with `<value>` and `<range>` placeholders; scalar `<value>` fields also accept the same loop arithmetic expressions as normal numeric fields.
- MCU timing, movement-time overhead, loop expansion, and duration estimation.
- Reachability diagnostics for applicable commands, including scattering-plane, scattering-triangle, S1/S2 limit, and Dark-angle checks.

### CIF Generator
- CIF preview and reflection table utilities.
- Nuclear structure-factor calculations using the bundled neutron scattering data.

### Toolbox
- Unit conversion and harmonic wavelength/energy table.
- Neutron attenuation tools.
- **S2 conversion**: converts one or more space-separated observed X-ray diffraction S2 (2θ) values to the corresponding d-spacing and neutron S2 for the currently selected fixed Ei/Ef.
  - Presets: Cu Kα1, Mo Kα1, Co Kα1, Fe Kα1, Cr Kα1, Ag Kα1.
  - X-ray wavelength remains editable for custom sources.
  - Neutron wavelength is obtained automatically from the current fixed instrument energy.
  - Inaccessible neutron Bragg conditions are shown as warnings.

## TAS sign conventions

The instrument JSON `configuration.sign` value is used directly.

- `+++`: validated branch inherited from the former application `+-+` behavior.
- `+-+`: pure `+-+` branch; S1 positive is clockwise and S2 positive is clockwise in TAS geometry.
- `-+-`: validated `-+-` branch; S1 positive is counter-clockwise.
- `---`: same physical `-+-` branch for Q-E / Dark-angle geometry, with the S1 encoder reversed so clockwise is positive.


## Code organization

The browser entry point remains `app.js`, but large independent responsibilities are split into ES modules so numerical behavior can be maintained without growing one monolithic file.

- `app.js`: application orchestration, Q-E calculation/rendering, TAS geometry rendering, Resolution UI, and browser event wiring.
- `tas-core.js`: reciprocal-lattice / UB / vector numerical routines.
- `tas-conventions.js`: the validated `+++`, `+-+`, `-+-`, `---` sign-routing and S1/Q conversion helpers. This module is UI-free.
- `resolution-core.js`: resolution numerical calculation.
- `cif-structure.js`: CIF parsing, neutron structure factors, and attenuation data calculations.
- `cif-symmetry.js`: pure reciprocal-space symmetry/star helpers used by the CIF generator.
- `data-loader.js`: JSON/CIF directory discovery and loading for localhost, GitHub Pages, and other static hosts.
- `toolbox.js`: neutron unit conversion, X-ray-to-neutron S2 conversion, and CIF-based attenuation UI.
- `script-workspace.js`: Time estimate, SPICE conversion, ASET editing, and related diagnostics.
- `matrix.js`: small matrix-algebra helpers used by the resolution code.

The modularization is intentionally conservative: the already validated Q-E and TAS-geometry behavior is not re-derived or unified in this refactor; code is moved behind explicit module boundaries first.

## Instrument data

Instrument definitions are loaded from the `instrument/` directory. The current schema can include resolution parameters, component sizes, collimation, distances, fixed-energy configuration, TAS sign, S2 limits, and energy-dependent S2 limits.

Other optional project data are loaded from directories such as `BG_material/` and `sample_environments/` when present.

## Local use

Run a local HTTP server from the project directory, for example:

```bash
python -m http.server 8888
```

Then open:

```text
http://localhost:8888/
```

After replacing JavaScript/CSS/HTML files, use a hard refresh (`Ctrl + Shift + R`) if the browser has cached an older version.


## GitHub Pages data loading
The unified `instrument/` directory is the primary instrument source. Optional `BG_material/`, `sample_environments/`, and legacy `instruments/` directories are not probed automatically on GitHub Pages when they are not part of the deployment, preventing unnecessary 404 requests.


## v88
- S2 conversion controls are shown on one row; result columns are X-ray S2, Neutron S2, then d-spacing.

## v89
- S2 conversion uses a single-row six-field layout. Neutron wavelength, neutron S2, and d are read-only; multiple peak results are shown space-separated.

### Q vector-E background material overlay
When BG materials are selected, their powder reflection lines are also shown on the Q vector-E map at the intersections between each powder |Q| ring and the selected HKL path.

### v91 display refinements
Q vector–E uses the same legend ordering as Constant E and labels every integer-HKL point within the displayed horizontal range.

### Angle calculation scan display
Scan mode provides equal-width initial/final HKL/energy inputs and Points, followed by Table and TAS geometry views. The table is scrollable, while TAS geometry provides the Point slider for inspecting individual scan points.

### Angle scan table
The Scan table uses compact 3-decimal H/K/L/ħω columns. Rows may be clicked for table-only highlighting. Status reports motor-range and kinematic reachability warnings as well as Dark-angle blocks.

### Data directories
At startup, the current version loads instrument JSON, BG-material CIF data, and sample-environment/Dark-angle JSON data. On GitHub Pages, file discovery uses the current Pages repository contents directly, so separate `index.json` manifests are not required for these directories.

## v98 UI update
- The Angle calculation Scan table uses `No.` labels, highlights warning/error Status cells in vermilion, and keeps the selected row synchronized with the TAS geometry scan position.


### Scan UI state
The Angle calculation Scan table uses vermilion row highlighting for non-empty Status values while keeping Status text black. The Single/Scan and Table/TAS geometry tab selections are stored locally and restored on reload.

## v100 UI note
Angle calculation Scan warning rows use a pale vermilion highlight, and the `Single / Scan` plus `Table / TAS geometry` tab selections are restored from browser-local state after reload.

### Scattering-plane warnings
Q vector–E, Angle calculation, and Resolution warn when user-entered HKL points do not lie in the current U–V scattering plane. Scan modes check the interpolated scan points as well. These are non-blocking UI warnings and do not alter the underlying calculation methods.

### Q vector–E input responsiveness
HKL1/HKL2 editing uses a short debounce and updates only the Q vector–E display instead of rebuilding the full simulator state on every keystroke.

### Angle Scan input responsiveness
Angle calculation Scan Initial/Final H/K/L/ħω and Points inputs use a short debounce while typing to avoid unnecessary full simulator recalculation.

### Resolution update behavior
Resolution Single updates automatically. Resolution Scan uses an explicit **Calculate** button so editing scan, lattice, and instrument parameters remains responsive. Hidden Q-E plots are not rebuilt while the Resolution tab is active; they refresh when Q-E Range is opened.

### Resolution calculation
Resolution Single and Scan calculations are explicit. Edit the calculation point or scan conditions, then press `Calculate`; this avoids expensive resolution work while other inputs are being edited.

### v107 UI note
Resolution Single displays H, K, L, ħω, and Calculate on one row.

## v108
- Resolution Scan slider navigation now preserves calculated plots/results and only changes the displayed scan point.


### Interactive calculation behavior
- Resolution Single updates automatically after a short input debounce.
- Resolution Scan is calculated only when **Calculate** is pressed.
- Q vector–E HKL1/HKL2 updates are debounced while typing and apply immediately when the edit is committed.


### v110 UI note
Dark-angle enable checkboxes now use one blue accent consistently, and Dark angle labels use normal font weight.


## Manual
The bundled `TAS_Simulator_Manual.html` can be opened from the `Manual` link in the application header.

### v112 note
BG material row count and selections are persisted locally and restored on reload.

## Local parameters
PLANE-TAS restores browser-local UI settings after configuration data are loaded. This includes dynamic BG and Dark-angle layouts, ordinary editable controls, checkboxes/selects, and the principal tab selections. Local file inputs are not restorable by the browser and must be selected again after reload.

## v114
- Resolution uses explicit `Calculate` buttons in both Single and Scan modes for stable, predictable updates and lighter UI interaction.

## v115
- User Manual layout now expands responsively on wide screens instead of being limited to 980 px.


### v116 UI note
- The bundled user manual now expands to the full browser-tab width with responsive side padding.

## v117 UI behavior
Resolution Single updates automatically; Resolution Scan remains Calculate-driven. Returning from Time estimate to Angle calculation & TAS geometry now forces the geometry plot to be rebuilt from the current calculation cache, preventing a blank plot after hidden-tab recalculations.


## v118
- Resolution Single now uses four equal-width H/K/L/ħω fields across one row.

### Plot display recovery
The main Plotly views (Constant E, Q vector–E, Single/Scan TAS geometry, and Resolution plots) are refreshed when their hidden tab/pane becomes visible, preventing blank plots caused by rendering while the container had no display size.

## v120
Q vector–E display keeps the ħω axis anchored at 0 meV regardless of BG overlays, and grid lines remain visible in non-accessible white regions.

## v122
Q vector–E map grid lines are now rendered above colored overlays for consistent visibility across the entire plot.
