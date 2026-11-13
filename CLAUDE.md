# Working with this repo

- Always reply to the user in English, even when they write to you in Hebrew or another language.
- This is the integrals practice game (a castle: ground floor + topic towers), split out of the Calcapp repo. Students use Calcapp (https://itsst-here.github.io/Calcapp/) for other topics - never change that repo from here.
- Vanilla JS ES module, no build: `index.html`, `app.js` (~4,400 lines), `style.css` (~2,000 lines). Syntax check: `node --input-type=module --check < app.js`.

## Code map - read only the section you need

`app.js` is big. Don't read it whole: `grep -n` for the name below, then read that range.
Sections in file order:

1. **LaTeX → JS evaluator** - `tokenize`, `buildEvaluator` (the parser for student answers).
2. **Partial-fractions tower math** - polynomial helpers (`polyAdd`, `polyLatex`...), `GENERATORS`
   (one generator per exercise node), then one block per type: repeated root (`rep*`), review
   (`drawReviewPlan`, `generateReviewExercise`), irreducible (`irr*`), non-monic (`nmr*`, `nmi*`).
3. **Dispatchers by `p.kind`** - `problemLatex`, `antiderivativeLatex`, `solutionLatex`,
   `integrandFn`, `sampleZones`, `nearMissVariants`. A new exercise kind adds one line to each.
4. **Checking** - `checkAnswer(p, latex)` → `checkAntiderivative(p, F)` (numeric derivative at
   sample points, 1% tolerance, then near-miss variants); `NEAR_MISS_TEXT` (slip messages).
5. **Ground floor math** (`kind: "basic"`) - term model `{t, c, p, q, u}`, `linFits`/`linProblem`
   sampling, `gen*` generators for rooms basic / linear / more, `basicNearMissVariants`.
6. **Parts tower math** (`kind: "parts"`, `fam: "poly" | "ln"`) - `partsPolyTerms`,
   `partsLnTerms`, `parts*Latex`, `partsSolutionLatex`, `partsNearMissVariants`, `genParts*`.
7. **`ROOMS`** - every room: `id`, `place` ("ground" | "pf" | "parts"), `kind`, `num`, `title`,
   `requires`, `nodes` (generator names). Everything above `const ROOMS = [` runs in node
   (stub `MathfieldElement`) - use that for math tests.
8. **Store & progress** - `STORE_KEY`, `loadStore` + migration, `currentPlace`, `isLocked`,
   `stairsOpen`, `wingOpen`, `recommendedRoomId`.
9. **Map** - `roomCardHtml`, medal (`medalState`, `renderMedalView`), `goToPlace`, the floor
   panel (`renderTowerNav`), `renderBasicFloor` / `renderRationalFloor` / `renderPartsFloor`.
10. **Marker** - `*_FLOOR_NODES` (arrow-key nav), `LINE_PATHS`, `nodePoint`, `routePoints`,
    `walkTo`, `stepMarker`, `lineGo`, `activateMarker`, map click handlers.
11. **Lock dialog** - `showLockDialog`, `openGateDialog`, `openLockedRoomDialog`, `openStairsDialog`.
12. **Room view** - `enterRoom`, path/pawn, grading (`checkBtn` handler), solution, answer menu.
13. **Victory** - `victoryNews`, `showConquest`; **routing** - `route`; then the `?test` panel
    and `?debug` hook (`window.__intapp`).

`style.css`: sections are marked by `/* ---- */` banner comments (grep `^/\* [A-Z]`); the
ground-floor map, the floor panel and the tablet (760-1199px) rules are near the end.
