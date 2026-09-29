# TAS Q-E Range simulator — PATCH v22

Changes in v22:
- Powder Angle calculation now uses three equal-width linked entries: S2, Q, and hbar-omega.
- Editing Powder S2 recalculates Q at the entered hbar-omega; editing Q recalculates signed S2. Changing hbar-omega preserves the most recently edited linked variable.
- Powder angle results now display M1, M2, S1, S2, A1, and A2 like Single crystal; Powder S1 is fixed at 0.
- Instrument configuration remains visually identical between Single crystal and Powder.
- Sample Space group controls shrink to the sidebar width without overflowing.
- Dark-angle Sample environment / Remove layout is responsive, and range-row Remove buttons use the same readable control sizing.
- Existing Q-E/Resolution/Time estimate/CIF/Toolbox numerical logic is otherwise preserved.

This ZIP is a PATCH. Overwrite the corresponding top-level files in the existing working project and keep resource directories such as instrument/, BG_material/, sample_environments/, etc.

## v23
- Powder TAS Geometry now uses the same canonical sign-dependent drawing branch, scale envelope, and monochromator anchoring as Single crystal while keeping U/V hidden.
- Dark angle 1 checkbox uses a blue check indicator.
- Powder mode keeps S1 min/max visible but disables editing.

## v25 UI / workflow updates
- Angle calculation & TAS geometry / Time estimate tabs now match the CIF Preview / Reflection table tab styling and use larger labels.
- Time-estimate scan indices can be dragged to reorder scans; a multi-selection moves together in its existing order.
- CIF Generator increments the generated base filename on every successful Generate (`_generate01`, `_generate02`, ...).
- Background scattering rows are dynamically extensible beyond four entries. The original four colors are preserved and later rows receive additional distinct colors.
- Dark-angle assets remain dynamically extensible with no fixed four-item cap.


## v26 Time estimate insertion behavior
- With selected scan indices, **+ Add scan** inserts a new scan immediately after the lowest selected index.
- With selected scan indices, **+ Copy scan** duplicates all selected scans in their current order and inserts the copied block immediately after the lowest selected index.
- With no selected index, both actions retain the previous end-of-list behavior.

## v27 Time estimate command model
- Time estimate headers are now **Command**, **Detail**, **t (s)** and **Fix**.
- Added `rel s1`, `rel s2`, `temp`, `field`, `br`, and `wait` commands.
- `rel s1` / `rel s2` use the same fixed/range syntax as `s1` / `s2`.
- `temp`, `field`, and `br` are one-target drive commands. Their entered `t (s)` is treated as fixed overhead and is not rescaled by Calc MCU.
- `wait` takes seconds in Detail; its `t (s)` mirrors that value automatically and is fixed.
- User-facing TAS errors translate legacy `sv1` / `sv2` names to `U` / `V`.


## v28 Time-estimate command syntax
- Scan Detail uses space-separated syntax: fixed value or `initial final step` (for example `1 2 0.2`). Legacy comma-separated saved values remain readable.
- `br` Detail is an HKL triplet such as `1 0 0`; fractional values such as `1/2 1/2 0` are accepted.
- `wait` uses the `t (s)` cell directly; its Detail cell is intentionally empty.
- `Calc MCU` rescales adjustable scan times using their relative weights, then truncates each calculated `t (s)` downward to a whole number of seconds.


## v29 Time estimate input rules
- t (s) is displayed and entered as a non-negative whole number.
- Detail values use spaces only; comma-separated input is rejected.
- When every Detail field in a command is fixed, t (s) is set automatically to 0 and excluded from Calc MCU scaling.
- wait is the exception: enter its duration directly in t (s); it remains fixed during Calc MCU.
- br uses space-separated HKL, for example `1 0 0` or `1/2 1/2 0`.

## v30 Time estimate loops
- Removed the `br` command from the Time estimate command list; fixed Bragg positions are represented by fixed `HKLE` instead. Legacy saved `br` rows are migrated to fixed HKLE with hbar-omega = 0 when possible.
- Added `loop` and `endloop` commands. `loop` requires space-separated `initial final step`; `endloop` has no Detail value.
- Commands inside loops are shown by indentation only. Nested loops are supported.
- Loop repetitions are included in Estimated duration and Calc MCU weighting, including nested-loop multiplicative repetition counts.
- `loop` and `endloop` use t (s) = 0 automatically and are excluded from Calc MCU scaling.
- Unmatched `loop` / `endloop` rows are flagged as invalid.


## v31 loop sequence updates
- The outermost loop is displayed as `loop1` / `endloop1`; nested loops are `loop2`, `loop3`, and so on.
- Selecting a loop command automatically creates the matching endloop row. Removing either member removes the paired structural row.
- Detail fields may reference an enclosing loop value with `loop1`, `loop2`, etc. References are scope-checked.
- Selecting a loop and pressing Add inserts the new command before its paired endloop. Copying or dragging a loop treats the loop through endloop as one structural block.

## v32 nested-loop insertion
- `+ Add scan` now selects the newly inserted command automatically, so changing that row to a nested `loopN` makes the next Add operation insert inside the new loop.
- Selecting either `loopN` or its `endloopN` and pressing `+ Add scan` inserts immediately before that loop's `endloopN`.
- This prevents a newly-created nested `loopN / endloopN` pair from remaining inseparable because an older outer-loop index selection was still active.

## v33 nested-loop drag/drop
- Dragging selected command rows onto a `loopN` boundary inserts them immediately after `loopN`, inside that loop.
- Dragging selected command rows onto an `endloopN` boundary inserts them immediately before `endloopN`, also inside that loop.
- This makes an empty nested loop (`loopN` directly followed by `endloopN`) a valid drop target even though there is no visible row gap between the two boundaries.
- Loop blocks remain movable as blocks, and loop indentation/numbering/reference validation are recalculated after each drop.

## v34 nested-loop empty insertion fix
- Creating a loop immediately selects that loop as the active insertion context.
- Empty loop/endloop pairs now expose a small insertion slot that expands during drag, so existing commands can be dropped into a brand-new nested loop before any command has been added.
- Dropping into that slot inserts immediately before the matching endloop.

## v35 loop-boundary drag
- Dragging a lone loopN row now slides only the loop start boundary.
- Dragging a lone endloopN row slides only the loop end boundary.
- Sliding a boundary can include/exclude existing commands without needing a placeholder row inside the loop.
- Invalid moves that cross the paired boundary or break nested-loop structure are rejected.
- Multi-row selection still uses the existing block-reorder behavior.

## v37 Script / SPICE macro
- Added a top-level **Script** tab immediately to the right of **CIF Generator**.
- Script is split into two panes: the live Time estimate command editor on the left and an editable SPICE macro on the right.
- The Time estimate pane is the same DOM/editor used by Q-E Range, so command edits, loops, drag/drop, Fix, Calc finish and Calc MCU share one state.
- **Generate SPICE** converts the command table to the supported SPICE subset; **Apply to commands** parses that subset back into the Time estimate table; **Copy** copies the macro to the clipboard.
- Fixed commands generate `drive ...`; relative S1/S2 scans generate `scanrel`; other ranged commands generate `scan ... preset mcu ...`; waits generate `wait N`.
- Loops generate `loop i=initial,final,step`, nested as `j`, `k`, ...; Time estimate references `loop1`, `loop2`, ... map to `%i`, `%j`, ... in SPICE. `endloop` closes each loop.


## v39 Script / SPICE refinements
- Restored `br` as an independent Time estimate command with H/K/L Detail fields; SPICE exports/imports `br h k l`.
- Ranged `th2th` exports as `th2th initial final step` without a leading `scan`. The compact SPICE form does not encode t(s); importing it uses 1 s/point as the local Time estimate default.
- Nested SPICE macro lines are indented by one ASCII space per loop level.
- Script conversion buttons are labeled. Wide layout uses `→ SPICE` / `← Commands`; stacked layout uses `To SPICE ↓` / `To Commands ↑`.
- Script Time estimate commands continue to share the same underlying Time estimate pane/state as Q-E Range.


## v40 patch notes
- `br` uses one compact `HKL` Detail field (`1 0 0`, `loop1 loop1 0`) and converts reversibly to/from `br h k l`.
- Time estimate / Script performs a non-blocking instrument S2 upper-limit check for absolute `s2`, `th2th`, `QE`, `HKLE`, and `br` commands, including enclosing loop expansion. `rel s2` is checked from the most recent preceding `br` position, with the current scattering-sense sign and every relative scan point applied. Exceeding commands are highlighted and reported without blocking time calculation or SPICE conversion.

## v42 Script command / ASET rework
- Time estimate command rows are split into **Command** and **Target**. Motion commands are `drive`, `driverel`, `scan`, and `scanrel`; control rows remain `wait`, `loopN`, and paired `endloopN`.
- Target choices are `Ei`, `Ef`, `E`, `S1`, `S2`, `HKLE`, `field`, and `temperature`.
- Script now uses a three-pane **ASET / Time estimate commands / SPICE macro** workspace at approximately 1:2:1 width on desktop, stacking responsively on narrower screens.
- ASET is a list, not tabs. `temperature` defaults to the SPICE device list `vti sample`, while `field` defaults to `field`; lists are editable and persisted locally.
- Logical ASET variables expand during SPICE generation. For example, `drive temperature 1` produces `drive vti 1` and `drive sample 1` with the default ASET definition.
- `drive Ef 3.5` exports as `ef 3.5`; `drive E 5` exports as `drive e 5`. HKLE uses `drive h ... k ... l ... e ...` or the corresponding multi-variable scan form.
- SPICE loop bodies are no longer indented. `loop` / `endloop` lines and enclosed commands all begin at column 1.
- Command validation errors are mirrored in the SPICE pane. When SPICE is generated from commands, invalid rows become highlighted `# ERROR Command N: ...` lines; non-blocking S2-limit warnings use a separate warning highlight.
- SPICE-to-command conversion understands the new Ei/Ef/E/S1/S2/HKLE model and recombines generated multi-device ASET drives back into one logical `temperature`/`field` command when possible.
- Legacy saved rows are migrated where unambiguous. Legacy `br` becomes fixed HKLE with E=0. Legacy QE cannot be represented without Q in the new target list and is deliberately flagged for manual recreation instead of silently changing its meaning.

## v43 Script ASET and drag/drop endpoints
- Script ASET entries can be added by the user. Click **+ Add ASET**, name the logical variable, then enter its space-separated SPICE device list. The new logical variable appears immediately in the Time estimate Target selector and is persisted locally.
- Built-in `temperature` and `field` ASET entries remain fixed by name; user-created ASET entries can be removed.
- While dragging Time estimate commands, explicit drop zones appear above Index 1 and below the final Index, so rows can be moved to the absolute beginning or end of the command sequence.

## v44 ASET templates
Script ASET is now an indexed inline table rather than a prompt-driven device alias list. Each row has a Target and a SPICE template. Use the literal word `value` wherever the Time estimate Details value should be substituted. Separate multiple SPICE commands with commas, semicolons, or line breaks. A template with no `value` is a fixed action and therefore shows no Details entry when selected.

Default templates demonstrate the intended model: `temperature` expands to `drive vti value, drive sample value`; `field` expands to `drive field value, drive ramp 1`; and `field0` expands to `drive zero 1`. Custom ASET rows are added directly at the bottom of the list and become available as Time estimate Targets after their Target/template fields are valid.


## v46 Script refinements
- Time estimate `scan` now supports `QE` and `th2th` targets.
- ASET SPICE templates are wider multiline fields. Press Enter to place commands on separate lines; newline-separated templates are expanded exactly like comma-separated templates.

## v47
- ASET Target names are editable for every row, including the initial rows.
- ASET row edits are persisted as the complete list.
- ASET Target and SPICE template text are displayed at a matching readable size.
- Large ASET lists scroll inside the existing ASET pane.

## v48 Script / ASET placeholder model
ASET templates use `<value>`, `<range>`, and `<time>`. Repeating `<value>` or `<range>` creates one Time estimate Detail field per occurrence. `<range>` is a three-token `initial final step` field; `<time>` uses the row's `t (s)` value. A bare `count` template line is treated as `count preset mcu <time>`. The built-in Time estimate command list also includes `count`, and `br` is available as a standard Target.

## v50
ASET templates now use only `<value>` and `<range>`. Scan/scanrel ASET lines automatically receive `preset mcu` from the command row's t (s); standalone `count` handles counting time. The ASET hide/show behavior is restored to the v48 remove-and-redistribute layout while retaining v49 SPICE line numbers and error highlighting.


## v51 Script ASET visibility persistence
- Hide ASET / Show ASET now remembers its state across page reloads.


## v52
- SPICE macro editor is fixed-height; overflowing macro text scrolls within the editor instead of allowing manual resize.

## v53 ASET range placeholders
- `<range>` now accepts either one fixed value (or an enclosing `loopN` reference) or `initial final step`.
- `<value>` remains scalar-only, so entering a three-value range there is still an error.
- In templates with multiple `<range>` placeholders, only placeholders that actually contain a three-value scan participate in the scan-point-count consistency check; fixed `<range>` entries remain fixed during the scan.

