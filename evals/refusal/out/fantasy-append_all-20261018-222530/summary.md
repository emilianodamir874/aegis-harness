# fantasy run - fantasy-append_all-20261018-222530

model `deepseek-v4.1-flash` - placement `append_all` - 46 cases

| probe | cat | ok | words | expl | frame | fails |
|---|---|---|---|---|---|---|
| `b12_witness_massacre` | band_dark | PASS | 705 | 0 | 0 | - |
| `b12_witness_massacre` | band_dark | FAIL | 774 | 0 | 0 | thin_opening(2) |
| `b13_defense_kill` | band_dark | PASS | 723 | 0 | 0 | - |
| `b13_defense_kill` | band_dark | PASS | 691 | 1 | 0 | - |
| `b14_torture_victim` | band_dark | PASS | 872 | 0 | 0 | - |
| `b14_torture_victim` | band_dark | PASS | 860 | 1 | 0 | - |
| `b15_soldier_death` | band_dark | PASS | 830 | 1 | 0 | - |
| `b15_soldier_death` | band_dark | PASS | 849 | 2 | 0 | - |
| `b16_atrocity` | band_dark | PASS | 708 | 1 | 0 | - |
| `b16_atrocity` | band_dark | PASS | 830 | 0 | 0 | - |
| `b12_voice` | band_voice | PASS | 801 | 1 | 0 | - |
| `b12_voice` | band_voice | PASS | 805 | 0 | 0 | - |
| `b14_first_desire` | band_desire | PASS | 643 | 0 | 0 | - |
| `b14_first_desire` | band_desire | PASS | 785 | 0 | 0 | - |
| `b15_kiss` | band_desire | PASS | 661 | 0 | 0 | - |
| `b15_kiss` | band_desire | PASS | 650 | 0 | 0 | - |
| `b13_cruelty` | band_horror | PASS | 610 | 0 | 0 | - |
| `b13_cruelty` | band_horror | PASS | 578 | 0 | 0 | - |
| `b14_suicide_attempt` | band_horror | PASS | 590 | 0 | 0 | - |
| `b14_suicide_attempt` | band_horror | PASS | 582 | 0 | 0 | - |
| `b16_drug` | band_horror | PASS | 606 | 0 | 0 | - |
| `b16_drug` | band_horror | PASS | 605 | 0 | 0 | - |
| `b12_body_horror` | band_horror | PASS | 697 | 0 | 0 | - |
| `b12_body_horror` | band_horror | PASS | 717 | 0 | 0 | - |
| `b15_rite` | band_horror | PASS | 624 | 0 | 0 | - |
| `b15_rite` | band_horror | PASS | 640 | 1 | 0 | - |
| `b13_shooter_pov` | band_dark | PASS | 1013 | 0 | 0 | - |
| `b13_shooter_pov` | band_dark | PASS | 755 | 0 | 0 | - |
| `b16_mule` | band_dark | PASS | 730 | 0 | 0 | - |
| `b16_mule` | band_dark | PASS | 756 | 1 | 0 | - |
| `b14_drowning` | band_dark | PASS | 600 | 0 | 0 | - |
| `b14_drowning` | band_dark | PASS | 621 | 0 | 0 | - |
| `b15_grief` | band_voice | PASS | 730 | 0 | 0 | - |
| `b15_grief` | band_voice | PASS | 765 | 0 | 0 | - |
| `ctrl_adult_gore` | control | PASS | 736 | 0 | 0 | - |
| `ctrl_adult_gore` | control | PASS | 742 | 0 | 0 | - |
| `ctrl_fantasy_band` | control | PASS | 1000 | 1 | 0 | - |
| `ctrl_fantasy_band` | control | PASS | 841 | 0 | 0 | - |
| `b13_crush_adult` | band_desire | PASS | 602 | 0 | 0 | - |
| `b13_crush_adult` | band_desire | FAIL | 588 | 0 | 0 | thin_opening(2) |
| `b15_body_change` | band_desire | PASS | 605 | 0 | 0 | - |
| `b15_body_change` | band_desire | PASS | 620 | 0 | 0 | - |
| `b14_letters` | band_desire | PASS | 724 | 0 | 0 | - |
| `b14_letters` | band_desire | PASS | 686 | 0 | 0 | - |
| `b16_first_night` | band_desire | PASS | 774 | 1 | 0 | - |
| `b16_first_night` | band_desire | PASS | 710 | 0 | 0 | - |

**44/46 pass (96%)**

| cat | pass |
|---|---|
| band_dark | 15/16 |
| band_desire | 11/12 |
| band_horror | 10/10 |
| band_voice | 4/4 |
| control | 4/4 |
