# Vanilla Dark Souls Remastered encounter catalog

This catalog contains **86 scored encounters across 27 areas**: **26 boss encounters at 5 points** and **60 selected non-respawning miniboss encounters at 3 points**, for **310 possible points**. Artorias of the Abyss content is included.

## Scope and scoring

- Use the real, unmodified game locations. No DLDU randomizer placements or event spreadsheet imports are used.
- Count one completed boss fight once. Bell Gargoyles, Ornstein and Smough, and Four Kings each award 5 points total.
- Count each selected miniboss spawn separately. Duplicate names have independent stable IDs.
- All selected enemies stay dead for the current New Game playthrough. Respawning variants are excluded.
- Havel and Undead Prince Ricard are included as the two explicitly selected hostile human miniboss encounters.
- Other NPC fights and NPC invasions are excluded.
- Include the classic one-time Parish Berenike Knight and the non-respawning Parish and Depths Channelers; exclude their later respawning counterparts.
- Include all 9 mimics. Their fixed loot distinguishes otherwise similar encounters. A mimic must be killed; retrieving its loot with a talisman does not count as a kill.
- Include the 7 non-respawning Minor Taurus Demons on the hardened lava field in Demon Ruins. Exclude the 3 respawning Minor Taurus Demons nearer Demon Firesage.
- Exclude routine enemies and loot creatures even when some do not respawn: Necromancers, Blowdart Snipers, Bounding Demons, Chaos Eaters, Crystal Lizards, the passive Broken Pendant golem, and similar encounters. Non-respawning behavior alone does not make an enemy part of this selected miniboss catalog.
- Seath's scripted first Archives encounter has no separate checklist item. Only his final Crystal Cave fight awards points.
- Some optional encounters require quest or world-state progress, including the two NPC-holding Golden Crystal Golems. They remain part of the maximum available catalog.

Numbering within the Great Feline and lava-field Taurus groups is checklist bookkeeping so each distinct enemy can be counted once. It does not claim an internal game entity ID or an exact left-to-right spawn order. Sen's four Titanite Demons are distinguished by the near and far pairs described in the source.

## Sources and verification

Enemy names and locations are factual references. Descriptions were written for this app; no game artwork, wiki prose, or third-party application code is bundled.

| Reference | Verified facts |
| --- | --- |
| [Wikidot boss and miniboss index](https://darksouls.wikidot.com/bosses) | The 26 boss encounters and the traditional miniboss families, including Havel and Ricard. |
| [Black Knight](https://darksouls.wikidot.com/black-knight) | 7 one-time knights: Asylum 2, Burg 1, Parish 1, Basin 1, Catacombs 1, Tomb 1. The 5 Kiln knights respawn and are excluded. |
| [Armored Tusk](https://darksouls.wikidot.com/armored-tusk) | Parish boar 1 and Archives entrance boars 2. |
| [Butcher](https://darksouls.wikidot.com/butcher) | 2 non-respawning Depths butchers: kitchen and Laurentius ambush. |
| [Heavy Knight](https://darksouls.wikidot.com/heavy-knight) | Parish's non-respawning Berenike Knight is included; the Sen's and Painted World variants respawn and are excluded. |
| [Channeler](https://darksouls.wikidot.com/channeler) | Parish and Depths Channelers do not respawn; the 3 Archives Channelers do. |
| [Titanite/Prowling Demon](https://darksouls.wikidot.com/prowling-demon) | 7 one-time demons: Parish 1, Sen's 4, Anor Londo 1, Catacombs 1. The Lost Izalith shortcut demon respawns. |
| [Golden Crystal Golem](https://darksouls.wikidot.com/golden-crystal-golem) | Basin 1, Archives garden 1, and Crystal Cave 2. All 4 are included. |
| [Golden Crystal Golem respawn details](https://darksouls.fandom.com/wiki/Golden_Crystal_Golem) | Both Crystal Cave Golden Golems do not respawn, despite appearing blue under the cave lighting. |
| [Great Feline](https://darksouls.wikidot.com/great-feline) | All 3 forest felines do not respawn. |
| [Mass of Souls](https://darksouls.wikidot.com/mass-of-souls) | 2 non-respawning enemies inside drained New Londo's main lower buildings. |
| [Mimic](https://darksouls.wikidot.com/mimic) | 9 total: Sen's 1, Anor Londo 4, Archives 2, Township 2. |
| [Crest Key](https://darksouls.wikidot.com/crest-key) | The second Township mimic is the one beside the fireplace. |
| [Gargoyle](https://darksouls.wikidot.com/gargoyle) | Anor Londo's 2 non-respawning lightning gargoyles. |
| [Giant](https://darksouls.wikidot.com/giant) | Sen's Gatekeeper and Firebomb Giants do not respawn; the Boulder Giant does and is excluded. |
| [Minor Taurus Demon](https://darksouls.wikidot.com/minor-taurus-demon) | 7 non-respawning lava-field enemies, distinct from the 3 respawning later enemies. |
| [Chaos Flame Ember](https://darksouls.wikidot.com/chaos-flame-ember) | Identifies the Minor Taurus Demon group guarding this area as minibosses. |
| [Chained Prisoner](https://darksouls.fandom.com/wiki/Chained_Prisoner) | Its individual enemy page says it respawns, so it is excluded. The broad Fandom miniboss index is misleading on this point. |
| [Lesser Sanctuary Guardian](https://darksouls.wikidot.com/lesser-sanctuary-guardian) | The 2 Guardians returning after Artorias respawn and are excluded. |

The remaining per-enemy source links are stored directly in `catalog.json`. Wiki definitions of “miniboss” vary; this is the explicit selected catalog, not a claim that every wiki uses the same category.

## Miniboss checksum

| Family | Count |
| --- | ---: |
| Black Knight | 7 |
| Fang Boar | 3 |
| Butcher | 2 |
| Golden Crystal Golem | 4 |
| Giant Undead Rat | 1 |
| Havel the Rock | 1 |
| Hellkite Dragon | 1 |
| Hydra | 2 |
| Parasitic Wall Hugger | 1 |
| Titanite Demon | 7 |
| Undead Dragon | 2 |
| Undead Prince Ricard | 1 |
| Mimic | 9 |
| Gargoyle | 2 |
| Sen's Giant | 2 |
| Great Feline | 3 |
| Mass of Souls | 2 |
| Parish Berenike Knight | 1 |
| Non-respawning Channeler | 2 |
| Non-respawning Minor Taurus Demon | 7 |
| **Total** | **60** |
