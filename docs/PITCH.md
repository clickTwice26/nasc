# Analog Atlas: judging pitch kit

Space Apps judges score **Influence/Impact, Creativity, Validity, Relevance and Presentation**. This page maps the project to each criterion and provides the 7-slide deck outline and a 30-second demo script.

## One-liner

> **Analog Atlas re-ranks every place on Earth as a stand-in for a specific Artemis or Mars site and a specific test objective. It uses open NASA data, explains every score, and proves the method by rediscovering the analog sites agencies already use.**

## Criteria → evidence

| Criterion | What we show |
|---|---|
| **Impact** | Field-campaign planners get a ranked, explained short-list, with access distance and a downloadable field brief, in seconds instead of literature trawls. New candidates (Chersky Range, Prince Charles Mountains, Tibesti, Pamir) open under-used regions to analog science and to teams in Asia and Africa. |
| **Creativity** | Planet → Earth translation by *clamping to Earth's attainable envelope*; lighting computed from each body's obliquity; similarity in *percentile space*; non-compensatory geometric mean; Monte-Carlo rank stability; real-ephemeris landing geometry linked to Earth's equivalent latitude. |
| **Validity** | Theme-matched validation against 36 established sites: **mean ROC AUC 0.79** (Moon 0.79, Mars 0.78); negative controls; CI regression guard; 23 targets with per-value sources and confidence flags; documented limitations; fully reproducible pipeline. |
| **Relevance** | Built on the challenge text: Moon-base *and* Mars, deserts, polar, volcanic, caves/lava tubes, open NASA and partner-agency data, *identify* (ranking) and *characterise* (report card), *new* analogs (novelty filter and Discoveries tab). |
| **Presentation** | 3D globes, a 60-second guided tour, one-click permalinks, a mobile layout, and plain-language "why it matches / limiting factor" call-outs. |

## 7-slide deck

1. **Hook.** "Where on Earth is the lunar south pole?" Photo of Devon Island next to the LRO south-pole mosaic. Analogs de-risk missions, but they are chosen by tradition.
2. **Problem.** The challenge quote: analogs are *"not entirely well characterized."* Three questions nobody can answer quickly (see README).
3. **Solution.** Screenshot of the explorer. Destination → objective → Earth re-ranked live → report card.
4. **Science.** Pipeline diagram; percentile kernel `(1 − |F(x) − F(x*)|)³`; clamping to Earth's envelope; geometric mean; lighting from obliquity.
5. **Proof.** Validation chart (AUC per target), Atacama → Gale, Karakoram → Deuteronilus, controls rank low.
6. **Discovery.** The Discoveries highlight cards: Chersky Range, Prince Charles Mountains, Tibesti and others, each with distance to the nearest established site and access.
7. **Next.** 30 m DEM, MODIS/EMIT mineralogy, planet-side LOLA/MOLA scoring, field-team feedback loop. Live-demo link and QR code.

## 30-second demo video script

| t | Screen | Voice-over |
|---|---|---|
| 0–4 s | Earth globe spinning, title | "Before we land on the Moon or Mars, we rehearse on Earth. But where, exactly?" |
| 4–10 s | Pick *Malapert Massif*, objective *Polar lighting & power*; the globe flies to Antarctica | "Analog Atlas scores all 88,000 land cells against an Artemis III region, using NASA POWER climate, terrain and geology." |
| 10–17 s | Click the #1 candidate; the report card and radar chart appear | "Every score is explained: what matches, the limiting factor, and how it compares with the nearest established analog." |
| 17–23 s | Switch to Mars *Gale* + *Astrobiology*; Atacama lights up | "It rediscovers the classics, with Atacama for Gale crater…" |
| 23–30 s | Discoveries cards, then the AUC chart | "…validates against 36 agency sites, with ROC AUC 0.79, and finds new ones, like Siberia's Chersky Range." |

## Likely judge questions

* **"Isn't 0.5° too coarse?"** Yes, for outcrops. This is regional screening: it says *where to look*, and the field brief flags the limiting factor to check on site. The engine is grid-agnostic, and finer NASA layers are the first roadmap item.
* **"Did you tune the weights to the validation set?"** The weights are a small set of physically motivated rules: clamping, category emphasis, grazing-Sun UV. They are documented in `js/engine.js`. Validation uses theme-matched positives the scoring never sees, and the rank-stability test shows the top sites survive ±35% weight changes.
* **"Why does the Dry Valleys rank low for Gale?"** Gale is a warm-ish (for Mars), dry, low-latitude sedimentary site, and the Dry Valleys are ice-cemented and polar. They rank in the 96th percentile for the lunar Shackleton–de Gerlache ridge and the 99.9th for Deuteronilus Mensae's debris-covered glaciers, which is the point of target-specific scoring. (For Phoenix they reach only the 43rd percentile, because the 0.5° cell is mostly ice. That's a known resolution limit.)
* **"Which space-agency data did you use?"** NASA POWER (MERRA-2, CERES, IMERG), Blue Marble, and LRO, MSL, Mars 2020 and Phoenix results on the target side; ISRO Chandrayaan-3 ChaSTE; CNSA Zhurong and Chang'e-4. The analog catalogue spans NASA, ESA, CSA, ISRO, CNSA and OeWF.
