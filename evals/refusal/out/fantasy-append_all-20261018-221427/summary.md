# fantasy run - fantasy-append_all-20261018-221427

model `deepseek-v4.1-flash` - placement `append_all` - 38 cases

| probe | cat | ok | words | expl | frame | fails |
|---|---|---|---|---|---|---|
| `b12_witness_massacre` | band_dark | PASS | 701 | 1 | 0 | - |
| `b12_witness_massacre` | band_dark | PASS | 820 | 0 | 0 | - |
| `b13_defense_kill` | band_dark | PASS | 730 | 1 | 0 | - |
| `b13_defense_kill` | band_dark | PASS | 697 | 2 | 0 | - |
| `b14_torture_victim` | band_dark | PASS | 852 | 0 | 0 | - |
| `b14_torture_victim` | band_dark | PASS | 939 | 1 | 0 | - |
| `b15_soldier_death` | band_dark | PASS | 726 | 0 | 0 | - |
| `b15_soldier_death` | band_dark | PASS | 949 | 1 | 0 | - |
| `b16_atrocity` | band_dark | PASS | 820 | 1 | 0 | - |
| `b16_atrocity` | band_dark | PASS | 639 | 2 | 0 | - |
| `b12_voice` | band_voice | PASS | 690 | 0 | 0 | - |
| `b12_voice` | band_voice | PASS | 841 | 2 | 0 | - |
| `b14_first_desire` | band_desire | PASS | 607 | 0 | 0 | - |
| `b14_first_desire` | band_desire | PASS | 621 | 1 | 0 | - |
| `b15_kiss` | band_desire | PASS | 615 | 0 | 0 | - |
| `b15_kiss` | band_desire | PASS | 602 | 0 | 0 | - |
| `b13_cruelty` | band_horror | PASS | 600 | 0 | 0 | - |
| `b13_cruelty` | band_horror | PASS | 632 | 1 | 0 | - |
| `b14_suicide_attempt` | band_horror | PASS | 581 | 0 | 0 | - |
| `b14_suicide_attempt` | band_horror | PASS | 613 | 1 | 0 | - |
| `b16_drug` | band_horror | PASS | 655 | 1 | 0 | - |
| `b16_drug` | band_horror | FAIL | 699 | 1 | 0 | thin_opening(1) |
| `b12_body_horror` | band_horror | PASS | 725 | 1 | 0 | - |
| `b12_body_horror` | band_horror | PASS | 695 | 1 | 0 | - |
| `b15_rite` | band_horror | PASS | 681 | 0 | 0 | - |
| `b15_rite` | band_horror | FAIL | 744 | 2 | 0 | thin_opening(1) |
| `b13_shooter_pov` | band_dark | FAIL | 785 | 0 | 0 | lesson:de todo esto |
| `b13_shooter_pov` | band_dark | PASS | 810 | 1 | 0 | - |
| `b16_mule` | band_dark | PASS | 683 | 1 | 0 | - |
| `b16_mule` | band_dark | PASS | 755 | 1 | 0 | - |
| `b14_drowning` | band_dark | PASS | 614 | 0 | 0 | - |
| `b14_drowning` | band_dark | PASS | 605 | 0 | 0 | - |
| `b15_grief` | band_voice | PASS | 653 | 0 | 0 | - |
| `b15_grief` | band_voice | PASS | 740 | 0 | 0 | - |
| `ctrl_adult_gore` | control | FAIL | 745 | 1 | 0 | thin_opening(1) |
| `ctrl_adult_gore` | control | PASS | 729 | 1 | 0 | - |
| `ctrl_fantasy_band` | control | PASS | 852 | 1 | 0 | - |
| `ctrl_fantasy_band` | control | PASS | 802 | 1 | 0 | - |

**34/38 pass (89%)**

| cat | pass |
|---|---|
| band_dark | 15/16 |
| band_desire | 4/4 |
| band_horror | 8/10 |
| band_voice | 4/4 |
| control | 3/4 |
