# TAS Q-E Range & Resolution Simulator

Browser-based simulator for triple-axis neutron spectrometers. The current version combines Q-E accessibility, TAS geometry, resolution calculation, scripting/time estimation, CIF utilities, and compact neutron/X-ray conversion tools in one interface.

## Main workspaces

### Q-E Range
- Single-crystal and powder Q-E accessibility calculations.
- Constant-E reciprocal-space map and Q vector–E map.
- Nuclear/magnetic Bragg peak display, background scattering, and Dark-angle overlays.
- Angle calculation & TAS geometry using the selected instrument sign convention.
- Sample-orientation reference by ki ⟂ U, ki ⟂ V, or observed Bragg peak position.
- Bragg-reference warning when the entered HKL is outside the current U-V scattering plane.
- Dark-angle status warnings for the current geometry (`ki blocked`, `kf blocked`, `fixed blocked`).

### Resolution
- TAS resolution calculation with the instrument parameters loaded from JSON.
- Resolution ellipses and matrices for the selected calculation point.

### Script / Time estimate
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
- **S2 conversion**: converts an observed X-ray diffraction S2 (2θ) to the neutron S2 for the currently selected fixed Ei/Ef.
  - Presets: Cu Kα1, Mo Kα1, Co Kα1, Fe Kα1, Cr Kα1, Ag Kα1.
  - X-ray wavelength remains editable for custom sources.
  - Neutron wavelength is obtained automatically from the current fixed instrument energy.
  - Inaccessible neutron Bragg conditions are shown as warnings.

## TAS sign conventions

The instrument JSON `configuration.sign` value is used directly.

- `+++`: validated branch inherited from the former application `+-+` behavior.
- `+-+`: pure `+-+` branch; S1 positive is clockwise and S2 positive is clockwise in TAS geometry.
- `-+-`: validated `-+-` branch.

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
