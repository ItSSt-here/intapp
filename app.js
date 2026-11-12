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

// LaTeX (and MathLive) allow a one-character argument without braces:
// \frac12 is 1/2, \frac1x is 1/x, \frac{3}2 is 3/2. Brace every \frac
// argument so the parser only ever sees \frac{..}{..}.
function braceFracArgs(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (!s.startsWith("\\frac", i)) {
      out += s[i++];
      continue;
    }
    out += "\\frac";
    i += 5;
    for (let arg = 0; arg < 2 && i < s.length; arg++) {
      if (s[i] === "{") {
        let depth = 0;
        let j = i;
        do {
          if (s[j] === "{") depth++;
          else if (s[j] === "}") depth--;
          j++;
        } while (j < s.length && depth > 0);
        out += braceFracArgs(s.slice(i, j)); // nested fractions inside
        i = j;
      } else {
        out += `{${s[i]}}`;
        i++;
      }
    }
  }
  return out;
}

function tokenize(latex) {
  let s = latex;

  // Strip sizing commands that don't affect meaning.
  s = s.replace(/\\left|\\right|\\mleft|\\mright|\\bigl|\\bigr|\\Bigl|\\Bigr|\\big|\\Big/g, "");
  s = s.replace(/\\cdot|\\times/g, "*");
  s = s.replace(/\\lvert|\\rvert|\\vert|\\mid/g, "|");
  s = s.replace(/\\operatorname\{(ln|log)\}/g, "\\$1");
  s = s.replace(/\\dfrac|\\tfrac/g, "\\frac");
  s = s.replace(/\\,|\\!|\\;|\\:|\\ /g, "");
  s = s.replace(/\\mathrm\{d\}x|dx/g, ""); // drop trailing "dx" if present
  s = s.replace(/\s+/g, "");
  s = braceFracArgs(s);

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

  // Unary minus binds looser than ^, so -x^2 means -(x^2).
  function parseFactor() {
    return parseUnary();
  }

  function parseUnary() {
    const tok = peek();
    if (tok && tok.t === "-") { next(); const n = parseUnary(); return (x) => -n(x); }
    if (tok && tok.t === "+") { next(); return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    let node = parsePrimary();
    if (peek() && peek().t === "^") {
      next();
      let expNode;
      if (peek() && peek().t === "LBRACE") {
        next();
        expNode = parseExpr();
        expect("RBRACE");
      } else {
        expNode = parseUnary();
      }
      const base = node;
      node = (x) => Math.pow(base(x), expNode(x));
    }
    return node;
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
// Problems
//
// Every exercise is generated answer-first as
//
//   integrand  =  Q(x)  +  sum_i  A_i m_i / (m_i x - n_i)
//   answer     =  ∫Q    +  sum_i  A_i ln|m_i x - n_i|  + C
//
// Q is the quotient of a polynomial division (empty when the numerator's
// degree is below the denominator's); each term is a linear factor
// m x - n of the denominator (m = 1: monic). The question's numerator is
// rebuilt as Q·D + R, so every coefficient stays a whole number.
//
// Problem object: { Q: [q0, q1, ...], terms: [{A, m, n}], display }
// where display is "factored" or "expanded" (the student factors it).
// ---------------------------------------------------------------------------

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nonZero(min, max) {
  let v;
  do v = randInt(min, max);
  while (v === 0);
  return v;
}

const chance = (p) => Math.random() < p;

function gcd(x, y) {
  x = Math.abs(x);
  y = Math.abs(y);
  while (y) [x, y] = [y, x % y];
  return x;
}

// --- polynomials: coefficient arrays, lowest degree first -------------------

function trimPoly(p) {
  const q = [...p];
  while (q.length && q[q.length - 1] === 0) q.pop();
  return q;
}

function polyAdd(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) out.push((a[i] || 0) + (b[i] || 0));
  return trimPoly(out);
}

function polyMul(a, b) {
  if (!a.length || !b.length) return [];
  const out = new Array(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => { out[i + j] += x * y; }));
  return trimPoly(out);
}

const polyEval = (p, x) => p.reduce((s, c, i) => s + c * x ** i, 0);

const linearFactor = (t) => [-t.n, t.m]; // m x - n

function denominatorPoly(p) {
  return p.terms.reduce((acc, t) => polyMul(acc, linearFactor(t)), [1]);
}

// R = sum_i A_i m_i * prod_{j != i} (m_j x - n_j)
function remainderPoly(p) {
  return p.terms.reduce((acc, t, i) => {
    const others = p.terms
      .filter((_, j) => j !== i)
      .reduce((a, u) => polyMul(a, linearFactor(u)), [1]);
    return polyAdd(acc, polyMul([t.A * t.m], others));
  }, []);
}

const numeratorPoly = (p) => polyAdd(polyMul(p.Q, denominatorPoly(p)), remainderPoly(p));

// --- generators -------------------------------------------------------------

// Two monic factors (x - a)(x - b) with whole roots. The small variants
// (root 0, difference of squares, constant numerator) just happen at random.
function monicTerms({ coef, root }) {
  let a, b;
  if (chance(0.2)) {
    a = randInt(1, root); // difference of squares: (x - a)(x + a)
    b = -a;
  } else {
    do {
      a = randInt(-root, root);
      b = randInt(-root, root);
    } while (a === b);
  }
  const A = nonZero(-coef, coef);
  const B = chance(0.2) ? -A : nonZero(-coef, coef); // B = -A: constant numerator
  return [{ A, m: 1, n: a }, { A: B, m: 1, n: b }];
}

// Two factors (m1 x - n1)(m2 x - n2), at least one non-monic. Whole-number
// roots would force a common factor out of the quadratic, so a genuinely
// non-monic denominator has a fractional root - the factors stay whole.
function nonMonicTerms() {
  let m1, n1, m2, n2;
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
  const A = nonZero(-6, 6);
  const B = chance(0.15) ? -A : nonZero(-6, 6);
  return [{ A, m: m1, n: n1 }, { A: B, m: m2, n: n2 }];
}

// One generator per node kind, each with its own parameter ranges.
const GENERATORS = {
  // degree-2 numerator over a linear denominator
  div1: () => ({ Q: [randInt(-5, 5), 1], terms: [{ A: nonZero(-6, 6), m: 1, n: randInt(-5, 5) }], display: "factored" }),
  div2: () => ({ Q: [randInt(-5, 5), nonZero(-3, 3)], terms: [{ A: nonZero(-7, 7), m: 1, n: randInt(-6, 6) }], display: "factored" }),
  // monic quadratic denominators
  pfFactored: () => ({ Q: [], terms: monicTerms({ coef: 5, root: 4 }), display: "factored" }),
  pfExpanded: () => ({ Q: [], terms: monicTerms({ coef: 7, root: 6 }), display: "expanded" }),
  pfDivide: () => ({ Q: [nonZero(-3, 3)], terms: monicTerms({ coef: 6, root: 5 }), display: "expanded" }),
  pfBoss: () => ({ Q: [randInt(-4, 4), nonZero(-3, 3)], terms: monicTerms({ coef: 6, root: 5 }), display: "expanded" }),
  // non-monic quadratic denominators
  nmFactored: () => ({ Q: [], terms: nonMonicTerms(), display: "factored" }),
  nmExpanded: () => ({ Q: [], terms: nonMonicTerms(), display: "expanded" }),
  nmDivide: () => ({ Q: [nonZero(-3, 3)], terms: nonMonicTerms(), display: "expanded" }),
};

// --- LaTeX ------------------------------------------------------------------

function fmtSigned(n, isFirst) {
  if (n >= 0) return (isFirst ? "" : "+") + n;
  return "-" + Math.abs(n);
}

const signLatex = (c, isFirst) => (c < 0 ? "-" : isFirst ? "" : "+");
const xPower = (k) => (k === 0 ? "" : k === 1 ? "x" : `x^${k}`);

// "m x - n" (m = 1 and n = 0 are dropped).
function mxLatex(m, n) {
  return `${m === 1 ? "" : m}x${n === 0 ? "" : fmtSigned(-n, false)}`;
}

function polyLatex(p) {
  let out = "";
  for (let k = p.length - 1; k >= 0; k--) {
    const c = p[k];
    if (c === 0) continue;
    const abs = Math.abs(c);
    out += signLatex(c, out === "") + (k > 0 && abs === 1 ? "" : abs) + xPower(k);
  }
  return out || "0";
}

// (num/den) x^k, reduced; a whole coefficient is written plainly.
function fracMonomialLatex(num, den, k, isFirst) {
  if (num === 0) return "";
  const g = gcd(num, den);
  num /= g;
  den /= g;
  const abs = Math.abs(num);
  const sign = signLatex(num, isFirst);
  if (den === 1) return sign + (k > 0 && abs === 1 ? "" : abs) + xPower(k);
  return `${sign}\\frac{${abs}}{${den}}${xPower(k)}`;
}

// The factored denominator; a bare x (root 0) goes first, unparenthesized.
function factoredDenLatex(p) {
  if (p.terms.length === 1) return mxLatex(p.terms[0].m, p.terms[0].n);
  return [...p.terms]
    .sort((s, t) => (s.n === 0 ? -1 : t.n === 0 ? 1 : 0))
    .map((t) => (t.n === 0 ? mxLatex(t.m, 0) : `(${mxLatex(t.m, t.n)})`))
    .join("");
}

const shownDenLatex = (p) => (p.display === "expanded" ? polyLatex(denominatorPoly(p)) : factoredDenLatex(p));

function problemLatex(p) {
  return `\\int \\frac{${polyLatex(numeratorPoly(p))}}{${shownDenLatex(p)}}\\,dx`;
}

// "+ R/D" (or "- |R|/D"), to follow a quotient.
function fracTermLatex(R, den) {
  const neg = R[R.length - 1] < 0;
  return `${neg ? "-" : "+"}\\frac{${polyLatex(neg ? R.map((c) => -c) : R)}}{${den}}`;
}

// "A m/(m x - n) + ..." - the partial-fraction split.
function splitLatex(p, isFirst) {
  return p.terms
    .map((t, i) => `${signLatex(t.A, isFirst && i === 0)}\\frac{${Math.abs(t.A * t.m)}}{${mxLatex(t.m, t.n)}}`)
    .join("");
}

function antiderivativeLatex(p) {
  let out = "";
  for (let k = p.Q.length - 1; k >= 0; k--) out += fracMonomialLatex(p.Q[k], k + 1, k + 1, out === "");
  for (const t of p.terms) {
    const abs = Math.abs(t.A);
    out += `${signLatex(t.A, out === "")}${abs === 1 ? "" : abs}\\ln|${mxLatex(t.m, t.n)}|`;
  }
  return out + "+C";
}

// Worked solution, one step per aligned line: divide, factor, split, integrate.
function solutionLatex(p) {
  const lines = [problemLatex(p)];
  const q = p.Q.length ? polyLatex(p.Q) : "";
  const R = remainderPoly(p);
  const wrap = (body) => `\\int\\left(${body}\\right)dx`;
  if (q) lines.push(wrap(q + fracTermLatex(R, shownDenLatex(p))));
  if (p.display === "expanded" && p.terms.length === 2) {
    lines.push(q
      ? wrap(q + fracTermLatex(R, factoredDenLatex(p)))
      : `\\int \\frac{${polyLatex(numeratorPoly(p))}}{${factoredDenLatex(p)}}\\,dx`);
  }
  if (p.terms.length === 2) lines.push(wrap(q + splitLatex(p, !q)));
  lines.push(antiderivativeLatex(p));
  return `\\begin{aligned}${lines[0]} &= ${lines.slice(1).join(" \\\\ &= ")}\\end{aligned}`;
}

// ---------------------------------------------------------------------------
// Checking: differentiate the student's answer numerically and compare it
// with the integrand on every interval between the poles.
// ---------------------------------------------------------------------------

function integrandFn(p) {
  return (x) => polyEval(p.Q, x) + p.terms.reduce((s, t) => s + (t.A * t.m) / (t.m * x - t.n), 0);
}

function sampleZones(p) {
  const poles = p.terms.map((t) => t.n / t.m).sort((a, b) => a - b);
  const zones = [[poles[0] - 6, poles[0] - 1], [poles[poles.length - 1] + 1, poles[poles.length - 1] + 6]];
  for (let i = 0; i + 1 < poles.length; i++) {
    const gap = poles[i + 1] - poles[i];
    if (gap > 2.5) zones.push([poles[i] + 1, poles[i + 1] - 1]);
    else if (gap > 0.4) zones.push([poles[i] + 0.3 * gap, poles[i + 1] - 0.3 * gap]);
  }
  return zones;
}

function pickSamplePoints(p, countPerZone = 3) {
  const points = [];
  for (const [lo, hi] of sampleZones(p)) {
    for (let i = 0; i < countPerZone; i++) points.push(lo + Math.random() * (hi - lo));
  }
  return points;
}

// Common slips, each as the problem the slipped answer would be correct for.
function nearMissVariants(p) {
  const variants = [];
  const replace = (i, t) => ({ ...p, terms: p.terms.map((u, j) => (j === i ? t : u)) });
  if (p.terms.length === 2 && p.terms[0].A !== p.terms[1].A) {
    const [s, t] = p.terms;
    variants.push({ kind: "swap", problem: { ...p, terms: [{ ...s, A: t.A }, { ...t, A: s.A }] } });
  }
  p.terms.forEach((t, i) => {
    variants.push({ kind: "sign", problem: replace(i, { ...t, A: -t.A }) });
  });
  p.terms.forEach((t, i) => {
    if (t.n !== 0) variants.push({ kind: "lnSign", problem: replace(i, { ...t, n: -t.n }) });
  });
  p.terms.forEach((t, i) => {
    if (t.m === 1) return;
    variants.push({ kind: "lnFactor", problem: replace(i, { ...t, A: t.A * t.m }) }); // forgot to divide by m
    variants.push({ kind: "lnFactor", problem: replace(i, { ...t, A: t.A / t.m }) }); // divided once too often
  });
  if (p.Q.length) variants.push({ kind: "quotient", problem: { ...p, Q: [] } });
  return variants;
}

// -> { status: "unreadable" } | { status: "correct" } | { status: "wrong", nearMiss? }
function checkAnswer(p, latex) {
  let F;
  try {
    F = buildEvaluator(latex);
  } catch {
    return { status: "unreadable" };
  }

  const points = pickSamplePoints(p);
  const h = 1e-4;
  const derivs = points.map((x) => {
    let a, b;
    try {
      a = F(x + h);
      b = F(x - h);
    } catch {
      return NaN;
    }
    return Number.isFinite(a) && Number.isFinite(b) ? (a - b) / (2 * h) : NaN;
  });

  // Does the answer's derivative match q's integrand wherever it is defined?
  const matches = (q) => {
    const f = integrandFn(q);
    let defined = 0;
    for (let i = 0; i < points.length; i++) {
      if (!Number.isFinite(derivs[i])) continue;
      defined++;
      const expected = f(points[i]);
      if (!Number.isFinite(expected) || Math.abs(derivs[i] - expected) > 1e-2 + 1e-2 * Math.abs(expected)) {
        return { ok: false, defined };
      }
    }
    return { ok: true, defined };
  };

  const exact = matches(p);
  if (exact.ok && exact.defined === points.length) return { status: "correct" };
  // Right on one side of the poles, undefined on the other: ln without | |.
  if (exact.ok && exact.defined >= 2) return { status: "wrong", nearMiss: "abs" };
  for (const v of nearMissVariants(p)) {
    const r = matches(v.problem);
    if (r.ok && r.defined >= 3) return { status: "wrong", nearMiss: v.kind };
  }
  return { status: "wrong" };
}

// HTML: math is isolated LTR so the bidi algorithm doesn't scramble it.
const ltr = (s) => `<bdi dir="ltr">${s}</bdi>`;
const NEAR_MISS_TEXT = {
  abs: `כמעט! חסר ערך מוחלט: צריך ${ltr("ln|…|")} ולא ${ltr("ln(…)")}. בלי ערך מוחלט התשובה לא מוגדרת בחלק מהתחום.`,
  swap: "כמעט! נראה שהמקדמים התחלפו - בדקו איזה מקדם שייך לאיזה גורם במכנה.",
  sign: "כמעט! יש טעות סימן במקדם של אחד האיברים.",
  lnSign: `כמעט! יש טעות סימן בתוך אחד ה-${ltr("ln")} - בדקו את השורש של הגורם.`,
  lnFactor: `כמעט! בדקו את המקדם שלפני ה-${ltr("ln")}: הנגזרת של ${ltr("ln|mx−n|")} היא ${ltr("m/(mx−n)")}.`,
  quotient: `כמעט! חסר החלק הפולינומי - המנה (${ltr("quotient")}) מהחילוק.`,
};

// ---------------------------------------------------------------------------
// The tower: floor 1
// ---------------------------------------------------------------------------

const ROOMS = [
  {
    id: "division",
    kind: "prep",
    title: "חילוק פולינומים",
    en: "Polynomial division",
    tag: "הכנה · אופציונלי",
    blurb: "מונה ממעלה 2 חלקי מכנה לינארי. יודעים לחלק פולינומים? אפשר לדלג.",
    nodes: [
      { gen: "div1", title: "חילוק במכנה לינארי" },
      { gen: "div2", title: "חילוק במכנה לינארי - עוד אחד" },
    ],
  },
  {
    id: "pf1",
    kind: "core",
    title: "שברים חלקיים I",
    en: "Partial fractions I",
    tag: "ליבה",
    blurb: "מכנה ריבועי עם שני שורשים שלמים - מפרקים לשני שברים פשוטים.",
    nodes: [
      { gen: "pfFactored", title: "מכנה מפורק" },
      { gen: "pfExpanded", title: "מכנה לפירוק" },
      { gen: "pfDivide", title: "קודם חילוק: מונה ממעלה 2" },
      { gen: "pfBoss", title: "אינטגרל הבוס: מונה ממעלה 3", boss: true },
    ],
  },
  {
    id: "nonmonic",
    kind: "ext",
    title: "◆ לא מתוקן",
    en: "Non-monic",
    tag: "הרחבה",
    stars: 2,
    requires: "pf1",
    blurb: 'חדש כאן: מכנה כמו <bdi dir="ltr">(2x−1)(x+3)</bdi>, והמקדם שלפני ה-<bdi dir="ltr">ln</bdi>.',
    nodes: [
      { gen: "nmFactored", title: "לא מתוקן, מכנה מפורק" },
      { gen: "nmExpanded", title: "לא מתוקן, מכנה לפירוק" },
      { gen: "nmDivide", title: "לא מתוקן, פירוק + חילוק" },
    ],
  },
];

const ROOM_BY_ID = Object.fromEntries(ROOMS.map((r) => [r.id, r]));
const START_SCORE = 10;
const WRONG_COST = 1;
const SOLUTION_COST = 3;

// --- persistence (localStorage may be missing or throw: private mode etc.) --

const STORE_KEY = "intapp.progress.v1";

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s.rooms === "object") return s;
  } catch {
    // fall through to a fresh store
  }
  return { rooms: {} };
}

let store = loadStore();

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // progress just won't survive a reload
  }
}

function roomRecord(id) {
  if (!store.rooms[id]) store.rooms[id] = { best: null, wins: 0, run: null };
  return store.rooms[id];
}

const isConquered = (id) => roomRecord(id).wins > 0;

function isLocked(room) {
  const rec = roomRecord(room.id);
  return !!room.requires && !isConquered(room.requires) && !rec.run && rec.wins === 0;
}

function recommendedRoomId() {
  if (!isConquered("pf1")) return "pf1";
  if (!isConquered("nonmonic")) return "nonmonic";
  return null;
}

const scoreTier = (s) => (s >= 9 ? "high" : s >= 7 ? "mid" : "low");

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const mapView = $("mapView");
const roomView = $("roomView");
const conquestView = $("conquestView");
const towerEl = $("tower");

function showView(view) {
  for (const v of [mapView, roomView, conquestView]) v.hidden = v !== view;
  window.scrollTo(0, 0);
}

// --- map --------------------------------------------------------------------

let justConquered = null; // room id whose card flips on the next map render

const LOCK_SVG =
  '<svg class="lock-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none"/></svg>';

function nodeDotsHtml(room, doneCount, currentIndex = -1) {
  return room.nodes
    .map((n, i) => {
      const cls = ["mini-node"];
      if (n.boss) cls.push("boss");
      if (i < doneCount) cls.push("done");
      if (i === currentIndex) cls.push("current");
      return `<span class="${cls.join(" ")}"></span>`;
    })
    .join('<span class="mini-conn"></span>');
}

// A card shows only the room's name and where the student stands in it;
// everything else lives in the small (i) popover (hover, or tap on tablets).
function roomCardHtml(room) {
  const rec = roomRecord(room.id);
  const locked = isLocked(room);
  const conquered = rec.wins > 0;
  const recommended = recommendedRoomId() === room.id;
  const classes = ["room-card", `room-${room.kind}`];
  if (locked) classes.push("locked");
  if (conquered) classes.push("conquered");
  if (rec.run) classes.push("in-progress");
  if (recommended && !locked) classes.push("recommended");
  if (justConquered === room.id) classes.push("just-conquered");

  let side = "";
  if (rec.run) {
    side = `<span class="score-chip small tier-${scoreTier(rec.run.score)}" title="הניקוד בחדר עכשיו">${rec.run.score}</span>`;
  } else if (conquered) {
    side = `<span class="wins" title="מספר הפעמים שהחדר נכבש">×${rec.wins}</span>` +
      `<span class="score-chip small tier-${scoreTier(rec.best)}" title="הציון הטוב ביותר">${rec.best}</span>`;
  } else if (locked) {
    side = `<button type="button" class="open-anyway" data-open-anyway="${room.id}">לפתוח בכל זאת</button>`;
  }

  const info = [`<div class="info-en" dir="ltr">${room.en}</div>`, `<div class="info-tag">${room.tag}${room.stars ? " " + "★".repeat(room.stars) : ""}</div>`, `<div>${room.blurb}</div>`];
  if (locked) info.push(`<div class="info-note">מומלץ אחרי "${ROOM_BY_ID[room.requires].title}".</div>`);
  if (rec.run) info.push(`<div class="info-note">בתהליך: תרגיל ${rec.run.node + 1} מתוך ${room.nodes.length}.</div>`);
  if (conquered) info.push(`<div class="info-note">נכבש ${rec.wins === 1 ? "פעם אחת" : `${rec.wins} פעמים`} · השיא: ${rec.best}</div>`);

  const done = rec.run ? rec.run.node : conquered ? room.nodes.length : 0;
  const stars = room.stars ? `<span class="stars">${"★".repeat(room.stars)}</span>` : "";
  return `
    <div class="${classes.join(" ")}" data-room="${room.id}" role="button" tabindex="0">
      ${conquered ? '<span class="conquered-flag" aria-hidden="true">✓</span>' : ""}
      <div class="room-head">
        ${locked ? LOCK_SVG : ""}<span class="room-title">${room.title}</span>${stars}
        <span class="info-wrap">
          <button type="button" class="info-btn" data-info aria-label="מידע על החדר" aria-expanded="false">i</button>
          <span class="room-info" role="tooltip">${info.join("")}</span>
        </span>
      </div>
      <div class="room-progress">
        <div class="mini-path">${nodeDotsHtml(room, done, rec.run ? rec.run.node : -1)}</div>
        <div class="room-side">${side}</div>
      </div>
    </div>`;
}

function renderMap() {
  const [prep, core, ext] = ["division", "pf1", "nonmonic"].map((id) => ROOM_BY_ID[id]);
  towerEl.innerHTML = `
    <div class="tower-crown" aria-hidden="true"></div>
    <div class="tower-body">
      <div class="floor-label">קומה 1 · שברים חלקיים <span dir="ltr">(partial fractions)</span></div>
      <div class="floor-rooms">
        <div class="branch area-ext">
          ${roomCardHtml(ext)}
          <div class="conn dashed branch-conn" aria-hidden="true"></div>
        </div>
        <div class="area-core">${roomCardHtml(core)}</div>
        <div class="conn area-conn" aria-hidden="true"></div>
        <div class="area-prep">${roomCardHtml(prep)}</div>
      </div>
    </div>
    <div class="tower-base">כניסה</div>`;
  justConquered = null;
}

function closeInfoPopovers(except) {
  towerEl.querySelectorAll(".info-wrap.open").forEach((w) => {
    if (w === except) return;
    w.classList.remove("open");
    w.querySelector(".info-btn").setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".info-wrap")) closeInfoPopovers();
});

towerEl.addEventListener("click", (e) => {
  // The (i) button and its popover toggle the details; they never enter the room.
  const infoWrap = e.target.closest(".info-wrap");
  if (infoWrap) {
    e.stopPropagation();
    if (e.target.closest("[data-info]")) {
      const open = infoWrap.classList.toggle("open");
      infoWrap.querySelector(".info-btn").setAttribute("aria-expanded", String(open));
      closeInfoPopovers(infoWrap);
    }
    return;
  }
  const anyway = e.target.closest("[data-open-anyway]");
  if (anyway) {
    e.stopPropagation();
    openLockDialog(anyway.dataset.openAnyway);
    return;
  }
  const card = e.target.closest("[data-room]");
  if (!card) return;
  const room = ROOM_BY_ID[card.dataset.room];
  if (isLocked(room)) openLockDialog(room.id);
  else goToRoom(room.id);
});

towerEl.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-room]")) {
    e.preventDefault();
    e.target.click();
  }
});

// --- "open anyway" dialog ---------------------------------------------------

const lockDialog = $("lockDialog");
let lockDialogRoom = null;

function openLockDialog(roomId) {
  lockDialogRoom = roomId;
  const room = ROOM_BY_ID[roomId];
  const rec = ROOM_BY_ID[recommendedRoomId()] || ROOM_BY_ID[room.requires];
  $("lockDialogText").textContent =
    `החדר "${room.title}" בנוי על "${ROOM_BY_ID[room.requires].title}". ` +
    `מומלץ לכבוש קודם את "${rec.title}" - אבל אפשר גם לנסות כבר עכשיו.`;
  $("lockBackBtn").textContent = `ל"${rec.title}" (מומלץ)`;
  $("lockBackBtn").dataset.room = rec.id;
  lockDialog.hidden = false;
  $("lockBackBtn").focus();
}

function closeLockDialog() {
  lockDialog.hidden = true;
}

$("lockBackBtn").addEventListener("click", (e) => {
  closeLockDialog();
  goToRoom(e.currentTarget.dataset.room);
});
$("lockAnywayBtn").addEventListener("click", () => {
  closeLockDialog();
  goToRoom(lockDialogRoom);
});
lockDialog.addEventListener("click", (e) => {
  if (e.target === lockDialog) closeLockDialog();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !lockDialog.hidden) closeLockDialog();
});

// --- room -------------------------------------------------------------------

const problemCardEl = $("problemCard");
const problemCardSlotEl = $("problemCardSlot");
const problemField = $("problem");
const answerCardEl = $("answerCard");
const answerBadgeEl = $("answerBadge");
const answerStatusEl = $("answerStatusText");
const answerField = $("answer");
const feedbackEl = $("feedback");
const checkBtn = $("checkBtn");
const solutionBtn = $("solutionBtn");
const solutionLabelEl = $("solutionLabel");
const solutionField = $("solution");
const nextBtn = $("nextBtn");
const pathEl = $("path");
const scoreChipEl = $("scoreChip");

// What is on screen. The saved run (store) is always one step ahead: on a
// correct answer or a shown solution it already holds the next exercise, so
// a reload can't be used to re-roll a hard one for free.
const view = { room: null, problem: null, node: 0, resolved: false, pending: null };

function goToRoom(id) {
  location.hash = `#/room/${id}`;
}

function goToMap() {
  if (location.hash === "#/") route(); // after a conquest the hash is already "#/"
  else location.hash = "#/";
}

function enterRoom(id) {
  const room = ROOM_BY_ID[id];
  const rec = roomRecord(id);
  if (!rec.run) {
    rec.run = { node: 0, score: START_SCORE, problem: GENERATORS[room.nodes[0].gen]() };
    saveStore();
  }
  view.room = room;
  view.node = rec.run.node;
  view.problem = rec.run.problem;
  view.pending = null;
  $("roomName").textContent = room.title;
  $("roomEn").textContent = room.en;
  roomView.classList.toggle("in-ext-room", room.kind === "ext");
  buildPath(room);
  showView(roomView);
  updatePath(false);
  renderScore(rec.run.score);
  removeOutgoingClone();
  showProblem({ animate: false });
}

function buildPath(room) {
  pathEl.innerHTML =
    room.nodes
      .map((n, i) => `<div class="pnode${n.boss ? " boss" : ""}" data-i="${i}"><span>${n.boss ? "★" : i + 1}</span></div>`)
      .join('<div class="pconn"><div class="pconn-fill"></div></div>') +
    '<div class="pawn" id="pawn" aria-hidden="true"></div>';
}

function updatePath(animate) {
  const nodes = pathEl.querySelectorAll(".pnode");
  const conns = pathEl.querySelectorAll(".pconn");
  nodes.forEach((el, i) => {
    el.classList.toggle("done", i < view.node);
    el.classList.toggle("current", i === view.node);
    el.querySelector("span").textContent = i < view.node ? "✓" : view.room.nodes[i].boss ? "★" : i + 1;
  });
  conns.forEach((el, i) => el.classList.toggle("done", i < view.node));
  placePawn(animate);
  const node = view.room.nodes[view.node];
  $("nodeCaption").textContent = node
    ? `תרגיל ${view.node + 1} מתוך ${view.room.nodes.length} · ${node.title}`
    : "החדר נכבש!";
  roomView.classList.toggle("boss-node", !!(node && node.boss));
}

function placePawn(animate) {
  const pawn = $("pawn");
  const target = pathEl.querySelectorAll(".pnode")[Math.min(view.node, view.room.nodes.length - 1)];
  if (!pawn || !target) return;
  pawn.style.transition = animate ? "" : "none";
  pawn.style.left = `${target.offsetLeft + target.offsetWidth / 2}px`;
  if (!animate) void pawn.offsetWidth;
  pawn.style.transition = "";
}

window.addEventListener("resize", () => {
  if (!roomView.hidden) placePawn(false);
});

function renderScore(score, delta) {
  scoreChipEl.textContent = score;
  scoreChipEl.className = `score-chip tier-${scoreTier(score)}`;
  if (delta) {
    const pop = document.createElement("span");
    pop.className = "penalty-pop";
    pop.textContent = `−${delta}`;
    $("scoreWrap").appendChild(pop);
    pop.addEventListener("animationend", () => pop.remove());
    scoreChipEl.classList.add("hit");
  }
}

// Marks the answer card as null (neutral, while working), "correct",
// "incorrect", "unreadable" (amber "?", no penalty) or "solution". Called
// fresh on every grade so a repeated attempt gets its own clear signal.
const ANSWER_STATES = {
  correct: { badge: "✓", label: "נכון" },
  incorrect: { badge: "✗", label: "לא נכון" },
  unreadable: { badge: "?", label: "לא הצלחנו לקרוא" },
};

function setAnswerState(state) {
  const all = Object.keys(ANSWER_STATES);
  answerCardEl.classList.remove("solution", ...all);
  answerBadgeEl.classList.remove("show", ...all);
  answerBadgeEl.textContent = "";
  answerStatusEl.classList.remove("show", ...all);
  answerStatusEl.textContent = "";
  if (!state) return;
  if (state === "solution") {
    answerCardEl.classList.add("solution");
    return;
  }
  void answerCardEl.offsetWidth; // restart the shake if the same state is set twice in a row
  answerCardEl.classList.add(state);
  answerBadgeEl.classList.add("show", state);
  answerBadgeEl.textContent = ANSWER_STATES[state].badge;
  answerStatusEl.classList.add("show", state);
  answerStatusEl.textContent = ANSWER_STATES[state].label;
}

// `html` is always one of this file's own strings, never user input.
function setFeedback(html, kind) {
  feedbackEl.innerHTML = html || "";
  feedbackEl.className = `feedback${kind ? " " + kind : ""}`;
}

// --- the "moving forward" transition ----------------------------------------
//
// The path reads right to left (RTL), so walking forward moves the scenery
// rightwards: a snapshot of the old card slides off to the right while the
// new card, already rendered underneath, slides in from the left.

let outgoingClone = null;

function removeOutgoingClone() {
  if (outgoingClone) {
    outgoingClone.remove();
    outgoingClone = null;
  }
}

function slideOutCurrentCard() {
  removeOutgoingClone();
  const rect = problemCardEl.getBoundingClientRect();
  const slotRect = problemCardSlotEl.getBoundingClientRect();
  const clone = problemCardEl.cloneNode(true);
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  clone.classList.add("problem-card-outgoing");
  clone.style.left = `${rect.left - slotRect.left}px`;
  clone.style.top = `${rect.top - slotRect.top}px`;
  clone.style.width = `${rect.width}px`;
  // <math-field> keeps its content in a shadow root that cloneNode skips.
  clone.querySelector("math-field").value = problemField.value;
  problemCardSlotEl.appendChild(clone);
  outgoingClone = clone;
  void clone.offsetWidth;
  clone.classList.add("animate-out");
  clone.addEventListener("transitionend", removeOutgoingClone, { once: true });
}

function slideInCurrentCard() {
  problemCardEl.classList.add("enter-start");
  void problemCardEl.offsetWidth;
  problemCardEl.classList.remove("enter-start");
}

function showProblem({ animate }) {
  if (animate && problemField.value) slideOutCurrentCard();
  problemField.value = problemLatex(view.problem);
  if (animate) slideInCurrentCard();
  view.resolved = false;
  gradedValue = null;
  answerField.value = "";
  setFeedback("");
  setAnswerState(null);
  solutionLabelEl.hidden = true;
  solutionField.hidden = true;
  solutionBtn.hidden = false;
  checkBtn.disabled = false;
  nextBtn.hidden = true;
  nextBtn.classList.remove("ready");
  answerField.focus();
}

// --- grading ----------------------------------------------------------------

// The field's content when it was last graded. An "input" event only counts
// as an edit if the content really differs from it: MathLive fires input
// events late (just after a check) and may not wipe the grade just shown.
let gradedValue = null;

checkBtn.addEventListener("click", () => {
  if (view.resolved) return;
  // Re-checking an unchanged answer (a second click, Enter twice) must not
  // cost another point - the grade already on screen still stands.
  if (gradedValue !== null && answerField.value === gradedValue) return;
  const rec = roomRecord(view.room.id);
  const result = checkAnswer(view.problem, answerField.value);
  gradedValue = answerField.value;

  if (result.status === "unreadable") {
    setAnswerState("unreadable");
    setFeedback("לא הצלחנו לקרוא את התשובה - זה לא נחשב טעות, לא ירדו נקודות. נסו לכתוב אותה בצורה פשוטה יותר.", "unreadable");
    return;
  }

  if (result.status === "wrong") {
    rec.run.score = Math.max(0, rec.run.score - WRONG_COST);
    saveStore();
    renderScore(rec.run.score, WRONG_COST);
    setAnswerState("incorrect");
    if (result.nearMiss) setFeedback(`${NEAR_MISS_TEXT[result.nearMiss]} ${ltr(`(−${WRONG_COST})`)}`, "near");
    else setFeedback(`לא נכון - הנגזרת של התשובה לא שווה לפונקציה שבאינטגרל. ${ltr(`(−${WRONG_COST})`)}`, "wrong");
    return;
  }

  // Correct: the node is cleared. Save the step forward right away.
  view.resolved = true;
  setAnswerState("correct");
  setFeedback("");
  checkBtn.disabled = true;
  solutionBtn.hidden = true;
  const nextNode = view.node + 1;
  if (nextNode >= view.room.nodes.length) {
    const score = rec.run.score;
    const prevBest = rec.best;
    rec.best = prevBest === null ? score : Math.max(prevBest, score);
    rec.wins += 1;
    rec.run = null;
    saveStore();
    view.node = nextNode;
    updatePath(true);
    setTimeout(() => showConquest(view.room, { score, prevBest, wins: rec.wins }), 900);
    return;
  }
  rec.run.node = nextNode;
  rec.run.problem = GENERATORS[view.room.nodes[nextNode].gen]();
  saveStore();
  view.pending = { node: nextNode, problem: rec.run.problem, advance: true };
  nextBtn.textContent = view.room.nodes[nextNode].boss ? "לבוס ←" : "המשך ←";
  nextBtn.hidden = false;
  nextBtn.classList.add("ready");
  nextBtn.focus();
});

solutionBtn.addEventListener("click", () => {
  if (view.resolved) return;
  const rec = roomRecord(view.room.id);
  view.resolved = true;
  rec.run.score = Math.max(0, rec.run.score - SOLUTION_COST);
  rec.run.problem = GENERATORS[view.room.nodes[view.node].gen](); // same node, fresh exercise
  saveStore();
  renderScore(rec.run.score, SOLUTION_COST);
  view.pending = { node: view.node, problem: rec.run.problem, advance: false };

  gradedValue = answerField.value;
  setFeedback("");
  setAnswerState("solution");
  solutionField.value = solutionLatex(view.problem);
  solutionLabelEl.hidden = false;
  solutionField.hidden = false;
  checkBtn.disabled = true;
  solutionBtn.hidden = true;
  nextBtn.textContent = "תרגיל חדש באותו שלב ←";
  nextBtn.hidden = false;
  nextBtn.classList.add("ready");
});

nextBtn.addEventListener("click", () => {
  if (!view.pending) return;
  const { node, problem, advance } = view.pending;
  view.pending = null;
  view.node = node;
  view.problem = problem;
  if (advance) updatePath(true);
  showProblem({ animate: true });
});

// Editing the answer returns the card to neutral, so the next wrong attempt
// starts from a clean slate instead of a stale red border.
answerField.addEventListener("input", () => {
  if (view.resolved || answerField.value === gradedValue) return;
  gradedValue = null;
  setAnswerState(null);
  setFeedback("");
});

// Enter (physical keyboard, or the return key of MathLive's on-screen
// keyboard) commits the field: check it, or move on once it's resolved.
// "change" also fires when the field loses focus - ignore that one.
answerField.addEventListener("change", () => {
  if (document.activeElement !== answerField) return;
  if (!view.resolved) {
    if (answerField.value.trim()) checkBtn.click();
  } else if (!nextBtn.hidden) {
    nextBtn.click();
  }
});

// Tablets: MathLive's on-screen keyboard covers the bottom of the page.
// Pad the page by its height and scroll so the exercise, the answer and the
// buttons sit in the space that is left (the exercise is the first to give
// way if not everything fits).
const virtualKeyboard = window.mathVirtualKeyboard;
if (virtualKeyboard) {
  // Which of these fires (and when "visible" flips) varies between the first
  // and later openings, so handle both, measured just after they settle.
  const onKeyboardChange = () => setTimeout(fitAboveKeyboard, 30);
  virtualKeyboard.addEventListener("geometrychange", onKeyboardChange);
  virtualKeyboard.addEventListener("virtual-keyboard-toggle", onKeyboardChange);

  function fitAboveKeyboard() {
    const kbHeight = virtualKeyboard.visible ? virtualKeyboard.boundingRect.height : 0;
    document.body.style.paddingBottom = kbHeight ? `${kbHeight + 16}px` : "";
    if (!kbHeight || roomView.hidden) return;
    const room = window.innerHeight - kbHeight;
    const top = problemCardSlotEl.getBoundingClientRect().top + window.scrollY - 8;
    const bottom = document.querySelector(".buttons").getBoundingClientRect().bottom + window.scrollY + 8;
    window.scrollTo(0, bottom - top <= room ? top : bottom - room);
  }
}

scoreChipEl.addEventListener("animationend", () => scoreChipEl.classList.remove("hit"));
$("backBtn").addEventListener("click", goToMap);

// --- conquest ---------------------------------------------------------------

function sealSvg(score) {
  return `
    <svg class="seal" viewBox="0 0 200 200" aria-hidden="true">
      <defs><path id="sealArc" d="M 38 100 A 62 62 0 0 1 162 100"/></defs>
      <circle cx="100" cy="100" r="92" class="seal-ring"/>
      <circle cx="100" cy="100" r="80" class="seal-ring thin"/>
      <text class="seal-arc"><textPath href="#sealArc" startOffset="50%" text-anchor="middle">★ CONQUERED ★</textPath></text>
      <text x="100" y="128" text-anchor="middle" class="seal-score">${score}</text>
      <text x="100" y="156" text-anchor="middle" class="seal-sub">מתוך 10</text>
    </svg>`;
}

function showConquest(room, { score, prevBest, wins }) {
  justConquered = room.id;
  let bestLine;
  if (prevBest === null) bestLine = `ציון ראשון בחדר: <b>${score}</b>`;
  else if (score > prevBest) bestLine = `שיא חדש! <b>${score}</b> <span class="muted">(קודם: ${prevBest})</span>`;
  else bestLine = `הציון הפעם: <b>${score}</b> · השיא שלך: <b>${prevBest}</b>`;

  const next = {
    division: "הבא: שברים חלקיים I",
    pf1: "הבא: ◆ לא מתוקן (הרחבה, אופציונלי)",
    nonmonic: "סיימת את כל קומה 1!",
  }[room.id];

  $("conquest").className = `conquest tier-${scoreTier(score)}`;
  $("conquest").innerHTML = `
    <div class="seal-wrap">${sealSvg(score)}</div>
    <h2>כבשת את החדר!</h2>
    <div class="conquest-room">${room.title}<div dir="ltr" class="muted conquest-room-en">${room.en}</div></div>
    <div class="conquest-dots">${room.nodes
      .map((n, i) => `<span class="mini-node done${n.boss ? " boss" : ""}" style="animation-delay:${0.9 + i * 0.15}s"></span>`)
      .join("")}</div>
    ${score === 10 ? '<div class="perfect">★ מושלם - בלי אף טעות</div>' : ""}
    <div class="conquest-best">${bestLine}</div>
    <div class="conquest-wins">נכבש ×${wins}</div>
    <button type="button" id="toTowerBtn" class="primary-btn">חזרה למגדל</button>
    <div class="conquest-next">${next}</div>`;
  $("toTowerBtn").addEventListener("click", goToMap);
  // The run is over; drop the room from history so Back/reload lands on the map.
  history.replaceState(null, "", "#/");
  showView(conquestView);
}

// --- routing ----------------------------------------------------------------

function route() {
  const m = location.hash.match(/^#\/room\/(\w+)/);
  if (m && ROOM_BY_ID[m[1]]) {
    enterRoom(m[1]);
  } else {
    renderMap();
    showView(mapView);
  }
}

window.addEventListener("hashchange", route);
route();

// Test hook for the preview only: ?debug exposes the exercise on screen.
if (new URLSearchParams(location.search).has("debug")) {
  window.__intapp = {
    problem: () => view.problem,
    answer: () => antiderivativeLatex(view.problem),
    solution: () => solutionLatex(view.problem),
    check: (p, latex) => checkAnswer(p, latex),
    generators: GENERATORS,
    antiderivativeLatex,
    problemLatex,
    store: () => store,
  };
}
