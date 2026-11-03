import "https://esm.run/mathlive@0.110.0"; // registers the <math-field> custom element
import { MathfieldElement } from "https://esm.run/mathlive@0.110.0";

// esm.run's asset resolution for MathLive's math fonts is unreliable -
// point it at a CDN path that actually serves them.
MathfieldElement.fontsDirectory = "https://cdn.jsdelivr.net/npm/mathlive@0.110.0/fonts";
MathfieldElement.soundsDirectory = null;

// ---------------------------------------------------------------------------
// LaTeX -> JS evaluator
//
// Parses a narrow subset of LaTeX (numbers, x, + - * / ^, \frac{}{},
// \ln, |...| / \left|...\right| / \lvert...\rvert, parentheses, unary minus,
// implicit multiplication) into a closure (x) => number.
// ---------------------------------------------------------------------------

function tokenize(latex) {
  let s = latex;

  // Strip sizing commands that don't affect meaning.
  s = s.replace(/\\left|\\right/g, "");
  s = s.replace(/\\cdot|\\times/g, "*");
  s = s.replace(/\\lvert|\\rvert/g, "|");
  s = s.replace(/\\,|\\!|\\;|\\:|\\ /g, "");
  s = s.replace(/\\mathrm\{d\}x|dx/g, ""); // drop trailing "dx" if present
  s = s.replace(/\s+/g, "");

  const tokens = [];
  let i = 0;
  let pipeOpen = false; // '|' is both the open and close delimiter for abs value; alternate roles
  while (i < s.length) {
    const rest = s.slice(i);
    if (rest.startsWith("\\frac")) { tokens.push({ t: "FRAC" }); i += 5; continue; }
    if (rest.startsWith("\\ln")) { tokens.push({ t: "LN" }); i += 3; continue; }
    if (rest.startsWith("\\log")) { tokens.push({ t: "LN" }); i += 4; continue; }
    // MathLive doesn't always expand a typed "ln"/"log" into the \ln macro
    // (it may leave it as plain italic letters) - recognize the bare word too.
    if (rest.startsWith("ln")) { tokens.push({ t: "LN" }); i += 2; continue; }
    if (rest.startsWith("log")) { tokens.push({ t: "LN" }); i += 3; continue; }
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push({ t: "NUM", v: parseFloat(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === "x") { tokens.push({ t: "VAR" }); i++; continue; }
    if (c === "C" || c === "c") { tokens.push({ t: "CONST" }); i++; continue; } // integration constant, treated as 0
    if (c === "|") {
      tokens.push({ t: pipeOpen ? "PIPE_CLOSE" : "PIPE_OPEN" });
      pipeOpen = !pipeOpen;
      i++;
      continue;
    }
    if ("+-*/^(){}".includes(c)) {
      const map = { "(": "LPAREN", ")": "RPAREN", "{": "LBRACE", "}": "RBRACE" };
      tokens.push({ t: map[c] || c });
      i++;
      continue;
    }
    // Unknown character (stray LaTeX command, space, etc.) - skip it.
    i++;
  }
  return tokens;
}

class ParseError extends Error {}

function buildEvaluator(latex) {
  const tokens = tokenize(latex);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t) => {
    const tok = next();
    if (!tok || tok.t !== t) throw new ParseError(`Expected ${t} but got ${tok ? tok.t : "end of input"}`);
    return tok;
  };

  function parseExpr() {
    let node = parseTerm();
    for (;;) {
      const tok = peek();
      if (tok && (tok.t === "+" || tok.t === "-")) {
        next();
        const rhs = parseTerm();
        const op = tok.t;
        const lhs = node;
        node = (x) => (op === "+" ? lhs(x) + rhs(x) : lhs(x) - rhs(x));
      } else break;
    }
    return node;
  }

  function startsFactor(tok) {
    if (!tok) return false;
    return ["NUM", "VAR", "CONST", "LPAREN", "LBRACE", "PIPE_OPEN", "LN", "FRAC"].includes(tok.t);
  }

  function parseTerm() {
    let node = parseFactor();
    for (;;) {
      const tok = peek();
      if (!tok) break;
      if (tok.t === "*" || tok.t === "/") {
        next();
        const rhs = parseFactor();
        const op = tok.t;
        const lhs = node;
        node = (x) => (op === "*" ? lhs(x) * rhs(x) : lhs(x) / rhs(x));
      } else if (startsFactor(tok)) {
        // implicit multiplication, e.g. "2x", "2\ln(...)", ")("
        const rhs = parseFactor();
        const lhs = node;
        node = (x) => lhs(x) * rhs(x);
      } else break;
    }
    return node;
  }

  function parseFactor() {
    let node = parseUnary();
    if (peek() && peek().t === "^") {
      next();
      let expNode;
      if (peek() && peek().t === "LBRACE") {
        next();
        expNode = parseExpr();
        expect("RBRACE");
      } else {
        expNode = parseFactor();
      }
      const base = node;
      node = (x) => Math.pow(base(x), expNode(x));
    }
    return node;
  }

  function parseUnary() {
    const tok = peek();
    if (tok && tok.t === "-") { next(); const n = parseUnary(); return (x) => -n(x); }
    if (tok && tok.t === "+") { next(); return parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new ParseError("Unexpected end of input");

    if (tok.t === "NUM") { next(); return () => tok.v; }
    if (tok.t === "VAR") { next(); return (x) => x; }
    if (tok.t === "CONST") { next(); return () => 0; }

    if (tok.t === "LPAREN") {
      next();
      const e = parseExpr();
      expect("RPAREN");
      return e;
    }
    if (tok.t === "LBRACE") {
      next();
      const e = parseExpr();
      expect("RBRACE");
      return e;
    }
    if (tok.t === "PIPE_OPEN") {
      next();
      const e = parseExpr();
      expect("PIPE_CLOSE");
      return (x) => Math.abs(e(x));
    }
    if (tok.t === "LN") {
      next();
      const arg = parseUnary();
      return (x) => Math.log(arg(x));
    }
    if (tok.t === "FRAC") {
      next();
      expect("LBRACE");
      const num = parseExpr();
      expect("RBRACE");
      expect("LBRACE");
      const den = parseExpr();
      expect("RBRACE");
      return (x) => num(x) / den(x);
    }

    throw new ParseError(`Unexpected token: ${tok.t}`);
  }

  const fn = parseExpr();
  if (pos !== tokens.length) {
    throw new ParseError(`Leftover input starting at token ${pos}`);
  }
  return fn;
}

// ---------------------------------------------------------------------------
// Problem generation & checking
// ---------------------------------------------------------------------------

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Generate the ANSWER first (classic technique), then build the question
// from it - this guarantees A, B come out as clean integers instead of
// forcing the student to solve for ugly fractions.
//
//   A/(x-a) + B/(x-b)  =  ((A+B)x - (A*b + B*a)) / ((x-a)(x-b))
//
function generateProblem() {
  let A, B, a, b;
  do {
    A = randInt(-9, 9);
  } while (A === 0);
  do {
    B = randInt(-9, 9);
  } while (B === 0);
  do {
    a = randInt(-6, 6);
    b = randInt(-6, 6);
  } while (a === b);
  return { A, B, a, b };
}

function fmtSigned(n, isFirst) {
  if (n >= 0) return (isFirst ? "" : "+") + n;
  return "-" + Math.abs(n);
}

// "p x + q" as LaTeX, dropping a zero or unit coefficient.
function linearFromCoeffsLatex(p, q) {
  if (p === 0) return `${q}`;
  const px = p === 1 ? "x" : p === -1 ? "-x" : `${p}x`;
  return q === 0 ? px : px + fmtSigned(q, false);
}

// The combined numerator (A+B)x - (A*b + B*a), as LaTeX.
function numeratorLatex({ A, B, a, b }) {
  return linearFromCoeffsLatex(A + B, -(A * b + B * a));
}

// "x - r" as LaTeX (just "x" for r = 0).
function linearLatex(r) {
  return r === 0 ? "x" : `x${fmtSigned(-r, false)}`;
}

// (x-a)(x-b) multiplied out: x^2 - (a+b)x + a*b, as LaTeX.
function expandedDenominatorLatex({ a, b }) {
  const s = -(a + b);
  const p = a * b;
  let out = "x^2";
  if (s !== 0) out += s === 1 ? "+x" : s === -1 ? "-x" : `${fmtSigned(s, false)}x`;
  if (p !== 0) out += fmtSigned(p, false);
  return out;
}

// Type 1: the denominator is given already factored.
function factoredProblemToLatex(problem) {
  const { a, b } = problem;
  // A root at 0 is just "x" - no parentheses, and written first: x(x-3).
  const factors = [a, b]
    .sort((r, s) => (r === 0 ? -1 : s === 0 ? 1 : 0))
    .map((r) => (r === 0 ? "x" : `(${linearLatex(r)})`));
  return `\\int \\frac{${numeratorLatex(problem)}}{${factors.join("")}}\\,dx`;
}

// Type 2: the denominator is multiplied out - the student has to factor it.
function expandedProblemToLatex(problem) {
  return `\\int \\frac{${numeratorLatex(problem)}}{${expandedDenominatorLatex(problem)}}\\,dx`;
}

const signLatex = (c, isFirst) => (c < 0 ? "-" : isFirst ? "" : "+");

// "A/(x-a) + B/(x-b)" - the partial-fraction split, as LaTeX.
function splitLatex({ A, B, a, b }) {
  const frac = (c, r, isFirst) => `${signLatex(c, isFirst)}\\frac{${Math.abs(c)}}{${linearLatex(r)}}`;
  return `${frac(A, a, true)}${frac(B, b, false)}`;
}

// "A ln|x-a| + B ln|x-b| + C" - the antiderivative, as LaTeX.
function antiderivativeLatex({ A, B, a, b }) {
  const ln = (c, r, isFirst) =>
    `${signLatex(c, isFirst)}${Math.abs(c) === 1 ? "" : Math.abs(c)}\\ln|${linearLatex(r)}|`;
  return `${ln(A, a, true)}${ln(B, b, false)}+C`;
}

// Worked solutions: each step on its own aligned line.
function factoredSolutionToLatex(problem) {
  return (
    `\\begin{aligned}${factoredProblemToLatex(problem)} &= \\int\\left(${splitLatex(problem)}\\right)dx \\\\` +
    ` &= ${antiderivativeLatex(problem)}\\end{aligned}`
  );
}

function expandedSolutionToLatex(problem) {
  return (
    `\\begin{aligned}${expandedProblemToLatex(problem)} &= ${factoredProblemToLatex(problem)} \\\\` +
    ` &= \\int\\left(${splitLatex(problem)}\\right)dx \\\\` +
    ` &= ${antiderivativeLatex(problem)}\\end{aligned}`
  );
}

// ---------------------------------------------------------------------------
// Non-monic denominators: (m1 x - n1)(m2 x - n2), whole numbers throughout
//
// Integer roots would force a common factor k out of any integer quadratic,
// so a genuinely non-monic denominator has a fractional root. The factors
// themselves (and the answer's coefficients) stay whole.
//
// Answer first again: A ln|m1 x - n1| + B ln|m2 x - n2| + C. Since
// d/dx ln|m x - n| = m / (m x - n) = 1 / (x - n/m), the integrand is
// A/(x - a) + B/(x - b) with the rational poles a = n1/m1, b = n2/m2 - so
// A, B, a, b keep their meaning and the grader needs no changes.
// ---------------------------------------------------------------------------

function gcd(x, y) {
  x = Math.abs(x);
  y = Math.abs(y);
  while (y) [x, y] = [y, x % y];
  return x;
}

function generateNonMonicProblem() {
  let A, B, m1, n1, m2, n2;
  do {
    A = randInt(-6, 6);
  } while (A === 0);
  do {
    B = randInt(-6, 6);
  } while (B === 0);
  do {
    m1 = randInt(1, 3);
    m2 = randInt(1, 3);
    n1 = randInt(-5, 5);
    n2 = randInt(-5, 5);
  } while (
    m1 * m2 === 1 || // at least one factor is non-monic
    m1 * m2 > 6 || // keep the leading coefficient small
    gcd(m1, n1) !== 1 || // each factor in lowest terms: no hidden common
    gcd(m2, n2) !== 1 || //   factor like (2x - 4); also rules out 2x with n = 0
    n1 * m2 === n2 * m1 // distinct roots
  );
  return { A, B, a: n1 / m1, b: n2 / m2, m1, n1, m2, n2 };
}

// "m x - n" as LaTeX (m = 1 and n = 0 are dropped).
function mxLatex(m, n) {
  return `${m === 1 ? "" : m}x${n === 0 ? "" : fmtSigned(-n, false)}`;
}

// The two factors side by side; a bare x (root 0) goes first, unparenthesized.
function nonMonicFactorsLatex({ m1, n1, m2, n2 }) {
  return [[m1, n1], [m2, n2]]
    .sort(([, r], [, s]) => (r === 0 ? -1 : s === 0 ? 1 : 0))
    .map(([m, n]) => (n === 0 ? mxLatex(m, n) : `(${mxLatex(m, n)})`))
    .join("");
}

// A m1/(m1 x - n1) + B m2/(m2 x - n2) over (m1 x - n1)(m2 x - n2).
function nonMonicNumeratorLatex({ A, B, m1, n1, m2, n2 }) {
  return linearFromCoeffsLatex(m1 * m2 * (A + B), -(A * m1 * n2 + B * m2 * n1));
}

// k x^2 + s x + c, as LaTeX.
function quadraticLatex(k, s, c) {
  let out = k === 1 ? "x^2" : `${k}x^2`;
  if (s !== 0) out += s === 1 ? "+x" : s === -1 ? "-x" : `${fmtSigned(s, false)}x`;
  if (c !== 0) out += fmtSigned(c, false);
  return out;
}

function nonMonicFactoredProblemToLatex(problem) {
  return `\\int \\frac{${nonMonicNumeratorLatex(problem)}}{${nonMonicFactorsLatex(problem)}}\\,dx`;
}

function nonMonicExpandedProblemToLatex(problem) {
  const { m1, n1, m2, n2 } = problem;
  const denominator = quadraticLatex(m1 * m2, -(m1 * n2 + m2 * n1), n1 * n2);
  return `\\int \\frac{${nonMonicNumeratorLatex(problem)}}{${denominator}}\\,dx`;
}

// "A m1/(m1 x - n1) + B m2/(m2 x - n2)" - the partial-fraction split.
function nonMonicSplitLatex({ A, B, m1, n1, m2, n2 }) {
  const frac = (c, m, n, isFirst) => `${signLatex(c, isFirst)}\\frac{${Math.abs(c) * m}}{${mxLatex(m, n)}}`;
  return `${frac(A, m1, n1, true)}${frac(B, m2, n2, false)}`;
}

// "A ln|m1 x - n1| + B ln|m2 x - n2| + C" - the antiderivative.
function nonMonicAntiderivativeLatex({ A, B, m1, n1, m2, n2 }) {
  const ln = (c, m, n, isFirst) =>
    `${signLatex(c, isFirst)}${Math.abs(c) === 1 ? "" : Math.abs(c)}\\ln|${mxLatex(m, n)}|`;
  return `${ln(A, m1, n1, true)}${ln(B, m2, n2, false)}+C`;
}

function nonMonicFactoredSolutionToLatex(problem) {
  return (
    `\\begin{aligned}${nonMonicFactoredProblemToLatex(problem)} &= \\int\\left(${nonMonicSplitLatex(problem)}\\right)dx \\\\` +
    ` &= ${nonMonicAntiderivativeLatex(problem)}\\end{aligned}`
  );
}

function nonMonicExpandedSolutionToLatex(problem) {
  return (
    `\\begin{aligned}${nonMonicExpandedProblemToLatex(problem)} &= ${nonMonicFactoredProblemToLatex(problem)} \\\\` +
    ` &= \\int\\left(${nonMonicSplitLatex(problem)}\\right)dx \\\\` +
    ` &= ${nonMonicAntiderivativeLatex(problem)}\\end{aligned}`
  );
}

// Exercise types. Every type draws an answer-first {A, B, a, b} problem and
// is graded the same way; they differ in the denominators and in how the
// question is shown.
const EXERCISE_TYPES = [
  { id: "factored", label: "factored denominator", generate: generateProblem, problemToLatex: factoredProblemToLatex, solutionToLatex: factoredSolutionToLatex },
  { id: "expanded", label: "denominator to factor", generate: generateProblem, problemToLatex: expandedProblemToLatex, solutionToLatex: expandedSolutionToLatex },
  { id: "nonmonic-factored", label: "non-monic, factored", generate: generateNonMonicProblem, problemToLatex: nonMonicFactoredProblemToLatex, solutionToLatex: nonMonicFactoredSolutionToLatex },
  { id: "nonmonic-expanded", label: "non-monic, to factor", generate: generateNonMonicProblem, problemToLatex: nonMonicExpandedProblemToLatex, solutionToLatex: nonMonicExpandedSolutionToLatex },
];

function integrandFn({ A, B, a, b }) {
  return (x) => A / (x - a) + B / (x - b);
}

function sampleZones({ a, b }) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const zones = [];
  zones.push([hi + 1, hi + 6]); // right of both poles
  zones.push([lo - 6, lo - 1]); // left of both poles
  if (hi - lo > 2.5) zones.push([lo + 1, hi - 1]); // between poles, if there's room
  return zones;
}

function pickSamplePoints(problem, countPerZone = 3) {
  const zones = sampleZones(problem);
  const points = [];
  for (const [lo, hi] of zones) {
    for (let i = 0; i < countPerZone; i++) {
      points.push(lo + Math.random() * (hi - lo));
    }
  }
  return points;
}

function checkAnswer(problem, latex) {
  let F;
  try {
    F = buildEvaluator(latex);
  } catch (err) {
    return { ok: false, reason: `Couldn't parse your answer (${err.message}). Try entering it as a simpler expression.` };
  }

  const f = integrandFn(problem);
  const points = pickSamplePoints(problem);
  const h = 1e-4;
  const failures = [];

  for (const x of points) {
    let deriv;
    try {
      const fPlus = F(x + h);
      const fMinus = F(x - h);
      if (!Number.isFinite(fPlus) || !Number.isFinite(fMinus)) throw new Error("non-finite");
      deriv = (fPlus - fMinus) / (2 * h);
    } catch {
      failures.push({ x, expected: f(x), got: NaN });
      continue;
    }
    const expected = f(x);
    const tol = 1e-2 + 1e-2 * Math.abs(expected);
    if (!Number.isFinite(deriv) || Math.abs(deriv - expected) > tol) {
      failures.push({ x, expected, got: deriv });
    }
  }

  if (failures.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "Your derivative doesn't match the original integrand at some points.",
    failures,
  };
}

// ---------------------------------------------------------------------------
// UI wiring
//
// The game layer (meter, wallet, swap, win/lose) is shelved in
// shelved/game-version/ - this file is just: show an exercise, check the
// answer, move on to the next one.
// ---------------------------------------------------------------------------

let currentProblem = null;
let currentType = EXERCISE_TYPES[0];
let solved = false;
let outgoingClone = null;

const problemCardEl = document.getElementById("problemCard");
const problemCardSlotEl = document.getElementById("problemCardSlot");
const problemField = document.getElementById("problem");
const answerCardEl = document.getElementById("answerCard");
const answerBadgeEl = document.getElementById("answerBadge");
const answerStatusEl = document.getElementById("answerStatusText");
const answerField = document.getElementById("answer");
const feedbackEl = document.getElementById("feedback");
const checkBtn = document.getElementById("checkBtn");
const solutionBtn = document.getElementById("solutionBtn");
const solutionLabelEl = document.getElementById("solutionLabel");
const solutionField = document.getElementById("solution");
const nextBtn = document.getElementById("nextBtn");

// Marks the answer card itself as null (neutral, while working) or
// "correct"/"incorrect" (graded: border glow, a check/cross badge and a
// small label on the card). Called fresh on every grade so a second wrong
// attempt gets its own clear signal.
function setAnswerState(state) {
  answerCardEl.classList.remove("correct", "incorrect", "solution");
  answerBadgeEl.classList.remove("show", "correct", "incorrect");
  answerBadgeEl.textContent = "";
  answerStatusEl.classList.remove("show", "correct", "incorrect");
  answerStatusEl.textContent = "";
  if (!state) return;
  if (state === "solution") {
    answerCardEl.classList.add("solution");
    return;
  }
  void answerCardEl.offsetWidth; // restart the shake if "incorrect" is set twice in a row
  answerCardEl.classList.add(state);
  answerBadgeEl.classList.add("show", state);
  answerBadgeEl.textContent = state === "correct" ? "✓" : "✗";
  answerStatusEl.classList.add("show", state);
  answerStatusEl.textContent = state === "correct" ? "Correct" : "Incorrect";
}

function removeOutgoingClone() {
  if (outgoingClone) {
    outgoingClone.remove();
    outgoingClone = null;
  }
}

// Slides a snapshot of the whole outgoing problem card away while the next
// one is already rendered underneath. <math-field> keeps its content in a
// shadow root that cloneNode doesn't copy, so the clone's value is re-set.
function slideOutCurrentCard() {
  removeOutgoingClone(); // in case a previous transition is still mid-flight
  const rect = problemCardEl.getBoundingClientRect();
  const slotRect = problemCardSlotEl.getBoundingClientRect();
  const clone = problemCardEl.cloneNode(true);
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  clone.classList.add("problem-card-outgoing");
  clone.style.left = `${rect.left - slotRect.left}px`;
  clone.style.top = `${rect.top - slotRect.top}px`;
  clone.style.width = `${rect.width}px`;
  clone.querySelector("math-field").value = problemField.value;
  problemCardSlotEl.appendChild(clone);
  outgoingClone = clone;
  void clone.offsetWidth; // force a reflow so the transition below actually animates
  clone.classList.add("animate-out");
  clone.addEventListener("transitionend", removeOutgoingClone, { once: true });
}

function showNextExercise({ animate = false } = {}) {
  if (animate && problemField.value) slideOutCurrentCard();
  currentProblem = currentType.generate();
  solved = false;
  gradedValue = null;
  problemField.value = currentType.problemToLatex(currentProblem);
  answerField.value = "";
  feedbackEl.textContent = "";
  feedbackEl.className = "feedback";
  setAnswerState(null);
  solutionLabelEl.hidden = true;
  solutionField.hidden = true;
  solutionBtn.hidden = false;
  checkBtn.disabled = false;
  nextBtn.classList.remove("ready");
  answerField.focus();
}

// The field's content when it was last graded. An "input" event only counts
// as an edit if the content really differs from it: MathLive fires input
// events late (just after a check) and may not wipe the grade just shown.
let gradedValue = null;

checkBtn.addEventListener("click", () => {
  gradedValue = answerField.value;
  const result = checkAnswer(currentProblem, answerField.value);
  if (result.ok) {
    solved = true;
    feedbackEl.textContent = "";
    setAnswerState("correct");
    checkBtn.disabled = true;
    nextBtn.classList.add("ready");
    return;
  }
  // A wrong answer is just marked on the card; only an unreadable one (no
  // `failures`) gets a message, since a typo shouldn't look like wrong math.
  if (!result.failures) {
    feedbackEl.textContent = result.reason;
    feedbackEl.className = "feedback incorrect";
  }
  setAnswerState("incorrect");
});

solutionBtn.addEventListener("click", () => {
  solved = true; // resolved: stop grading, only moving on is left
  gradedValue = answerField.value;
  feedbackEl.textContent = "";
  feedbackEl.className = "feedback";
  setAnswerState("solution");
  solutionField.value = currentType.solutionToLatex(currentProblem);
  solutionLabelEl.hidden = false;
  solutionField.hidden = false;
  checkBtn.disabled = true;
  solutionBtn.hidden = true;
  nextBtn.classList.add("ready");
});

// Editing the answer at all returns the card to neutral, so the next wrong
// attempt starts from a clean slate instead of a stale red border.
answerField.addEventListener("input", () => {
  if (solved || answerField.value === gradedValue) return;
  gradedValue = null;
  setAnswerState(null);
  feedbackEl.textContent = "";
  feedbackEl.className = "feedback";
});

nextBtn.addEventListener("click", () => showNextExercise({ animate: true }));

// TEMP: a deliberately plain button that cycles through the exercise types,
// until there is a real way to choose one.
const typeBtn = document.getElementById("typeBtn");

function updateTypeBtn() {
  typeBtn.textContent = `[temp] Type: ${currentType.label} - click to switch`;
}

typeBtn.addEventListener("click", () => {
  currentType = EXERCISE_TYPES[(EXERCISE_TYPES.indexOf(currentType) + 1) % EXERCISE_TYPES.length];
  updateTypeBtn();
  showNextExercise();
});

updateTypeBtn();
showNextExercise();
