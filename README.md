# TAS Q-E Range & Resolution Simulator

> **This project has moved to PLANE-TAS.**
>
> **PLANE-TAS — Planning Experiments with a Triple-Axis Spectrometer**
>
> - **Use the current software:** https://plane-tas.github.io/
> - **Current source code and documentation:** https://github.com/plane-tas/plane-tas.github.io
> - **User manual:** https://plane-tas.github.io/PLANE-TAS_Manual.html

## About this repository

This repository contains the earlier **TAS Q-E Range & Resolution Simulator** project, which has evolved into **PLANE-TAS**. It is retained as a reference to the previous project and its development history.

For the current application, documentation, and future updates, please use the **PLANE-TAS** links above instead of relying on information or code in this repository.

## What is PLANE-TAS?

PLANE-TAS is a browser-based tool for planning experiments with triple-axis neutron spectrometers. Its workspaces include:

- **Q–E Range:** scattering accessibility, reciprocal-space views, and TAS geometry.
- **Resolution:** instrument-dependent resolution calculations and visualizations.
- **Structure:** CIF/mCIF import, structure and spin visualization, structure editing, and nuclear reflections.
- **Script and Time estimate:** measurement-command planning, SPICE-related tools, and time estimates.
- **Toolbox:** neutron/X-ray conversions, magnetic form-factor tools, and neutron attenuation calculations.

### Important limitations

Magnetic-space-group identification for generated mCIF files and magnetic-reflection intensity calculations have not been fully validated. These experimental output/calculation features may be disabled in the public application. **Importing an existing mCIF and visualizing its magnetic structure are separate capabilities.** Refer to the current PLANE-TAS documentation for the latest supported functionality.

## Links

- **Application:** [plane-tas.github.io](https://plane-tas.github.io/)
- **Active repository:** [plane-tas/plane-tas.github.io](https://github.com/plane-tas/plane-tas.github.io)
- **Manual:** [PLANE-TAS Manual](https://plane-tas.github.io/PLANE-TAS_Manual.html)

This README intentionally omits outdated sign-convention descriptions, former file/module layouts, local setup notes, and version-by-version change logs. The active PLANE-TAS repository is the source of truth for those details.
