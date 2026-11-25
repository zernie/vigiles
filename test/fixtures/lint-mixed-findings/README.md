# lint-mixed-findings

A repo that trips one rule for each way `vigiles lint` prints a finding: a
graded finding, a rule-wide one, a grouped report and the lethal-trifecta
block, a rule module. `src/lint-contract.test.ts` copies it and asserts every finding line
names its rule. The rules it must trip are the keys of its `.vigilesrc.json`.
