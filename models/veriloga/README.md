# Verilog-A idea opamps (OpenVAF → OSDI → ngspice)

Compile in WSL (same environment as `ngspice`):

```bash
cd models/veriloga
openvaf opamp_se.va
openvaf opamp_diff.va
```

Load in ngspice (`.spiceinit` or before the netlist body):

```spice
osdi /mnt/d/proj/voltage_reference_expt/models/veriloga/opamp_se.osdi
osdi /mnt/d/proj/voltage_reference_expt/models/veriloga/opamp_diff.osdi
```

Instantiate with `N` devices (OSDI). Pin order matches the modules:
`inp inm out vdd vss` (SE) and `inp inm outp outm vdd vss` (DIFF).

For day-to-day benches prefer `../models/opamp.lib` subcircuits (`X` instances);
they need no OpenVAF step and match the same default non-ideal parameters.
