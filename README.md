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
