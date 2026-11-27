# Working with this repo

- Always reply to the user in English, even when they write to you in Hebrew or another language.
- This is the integrals practice game (a castle: ground floor + topic towers), split out of the Calcapp repo. Students use Calcapp (https://itsst-here.github.io/Calcapp/) for other topics - never change that repo from here.
- Vanilla JS ES module, no build: `index.html`, `app.js` (~4,400 lines), `style.css` (~2,000 lines). Syntax check: `node --input-type=module --check < app.js`.
- Other modules: `rooms.js` (ROOMS, the medal room-id lists and `MEDAL_LIST` - plain data shared with the
  lecturer page), `cloud.js` (Firebase project intapp-2f266: ID-number entry, saving the store, groups),
  `teacher.html`/`teacher.js`/`teacher.css` (the lecturer page, Google sign-in). `firestore.rules` is the copy
  of the rules kept in the Firebase console - the lecturer's address is a placeholder; never commit it.
- `?test` plays on its own local copy, with no entry and no server; `?test&group=software` shows that group's view.

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
   Then the substitution tower (`sub*`, `SUB_R1`/`SUB_A`/`SUB_C`, `drawSubPlan`) and the summit
   (`kind: "top"`: data-only exercises with their LaTeX written out, helpers `tFrac`/`tTerm`/`tJoin`,
   `TOP_POOLS`, `TOP_OLD`, `drawTopPlan`, `generateTopExercise`). Parser: put `e^{\sin x}` before
   `\sin x\cos x`, and write `\sin\left(2x\right)` - a function's argument is greedy.
7. **`ROOMS`** (in `rooms.js`) - every room: `id`, `place` ("ground" | "pf" | "parts" | "pf2" | "sub" | "top"),
   `kind`, `num`, `title`, `requires`, `nodes` (generator names). Everything in app.js above
   `const ROOM_BY_ID` runs in node (strip imports, stub `MathfieldElement`) - use that for math tests.
8. **Store & progress** - `STORE_KEY`, `loadStore` + migration, `currentPlace`, `isLocked`,
   `stairsOpen`, `wingOpen`, `recommendedRoomId`.
9. **Map** - `roomCardHtml`, medal (`medalState`, `renderMedalView`), `goToPlace`, the floor
   panel (`renderTowerNav`), `renderBasicFloor` / `renderRationalFloor` / `renderPartsFloor` /
   `renderTopFloor`; the summit's door on the ground floor (`summitDoorHtml`, `summitOpen`).
10. **Marker** - `*_FLOOR_NODES` (arrow-key nav), `LINE_PATHS`, `nodePoint`, `routePoints`,
    `walkTo`, `stepMarker`, `lineGo`, `activateMarker`, map click handlers.
11. **Lock dialog** - `showLockDialog`, `openGateDialog`, `openLockedRoomDialog`, `openStairsDialog`.
12. **Room view** - `enterRoom`, path/pawn, grading (`checkBtn` handler), solution, answer menu.
13. **Victory** - `victoryNews`, `showConquest`; **routing** - `route`; then the `?test` panel
    and `?debug` hook (`window.__intapp`).

`style.css`: sections are marked by `/* ---- */` banner comments (grep `^/\* [A-Z]`); the
ground-floor map, the floor panel and the tablet (760-1199px) rules are near the end.
