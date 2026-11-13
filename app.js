import "https://esm.run/mathlive@0.110.0"; // registers the <math-field> custom element
import { MathfieldElement } from "https://esm.run/mathlive@0.110.0";

// esm.run's asset resolution for MathLive's math fonts is unreliable -
// point it at a CDN path that actually serves them.
MathfieldElement.fontsDirectory = "https://cdn.jsdelivr.net/npm/mathlive@0.110.0/fonts";
MathfieldElement.soundsDirectory = null;

// ---------------------------------------------------------------------------
// LaTeX -> JS evaluator
//
// Parses a narrow subset of LaTeX (numbers, x, e, π, + - * / ^, \frac{}{},
// \sqrt{} and \sqrt[n]{}, \ln, \sin \cos \tan \cot, \arcsin \arctan (and the
// tg / ctg / arctg spellings), |...| / \left|...\right| / \lvert...\rvert,
// parentheses, unary minus, implicit multiplication) into a closure
// (x) => number.
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

// A real n-th root, also of a negative number when n is odd.
function nthRoot(v, n) {
  if (v < 0 && Number.isInteger(n) && n % 2 === 1) return -Math.pow(-v, 1 / n);
  return Math.pow(v, 1 / n);
}

// Function names, longest first so "arcsin" wins over "sin" and "ctg" over
// "tg". Each is recognized as a LaTeX command (\sin) and as a bare word,
// which MathLive leaves when it doesn't expand a typed name.
const FUNCTIONS = [
  ["arcsin", Math.asin],
  ["arccos", Math.acos],
  ["arctan", Math.atan],
  ["arctg", Math.atan],
  ["sin", Math.sin],
  ["cos", Math.cos],
  ["tan", Math.tan],
  ["ctg", (v) => 1 / Math.tan(v)],
  ["cot", (v) => 1 / Math.tan(v)],
  ["tg", Math.tan],
  ["exp", Math.exp],
  ["ln", Math.log],
  ["log", Math.log],
];

function tokenize(latex) {
  let s = latex;

  // Strip sizing commands that don't affect meaning.
  s = s.replace(/\\left|\\right|\\mleft|\\mright|\\bigl|\\bigr|\\Bigl|\\Bigr|\\big|\\Big/g, "");
  s = s.replace(/\\cdot|\\times/g, "*");
  s = s.replace(/\\lvert|\\rvert|\\vert|\\mid/g, "|");
  s = s.replace(/\\exponentialE|\\mathrm\{e\}/g, "e");
  s = s.replace(/\\mathrm\{d\}x|dx/g, ""); // drop trailing "dx" if present
  s = s.replace(/\\operatorname\{([a-z]+)\}|\\mathrm\{([a-z]+)\}/g, (m, a, b) => `\\${a || b}`);
  s = s.replace(/\\(tan|sin|cos)\^\{-1\}|\\(tan|sin|cos)\^-1/g, (m, a, b) => `\\arc${a || b}`);
  s = s.replace(/\\dfrac|\\tfrac/g, "\\frac");
  s = s.replace(/\\,|\\!|\\;|\\:|\\ /g, "");
  s = s.replace(/\s+/g, "");
  s = braceFracArgs(s);

  const tokens = [];
  let i = 0;
  let pipeOpen = false; // '|' is both the open and close delimiter for abs value; alternate roles
  outer: while (i < s.length) {
    const rest = s.slice(i);
    if (rest.startsWith("\\frac")) { tokens.push({ t: "FRAC" }); i += 5; continue; }
    if (rest.startsWith("\\sqrt")) { tokens.push({ t: "SQRT" }); i += 5; continue; }
    if (rest.startsWith("sqrt")) { tokens.push({ t: "SQRT" }); i += 4; continue; } // left unexpanded
    if (rest.startsWith("\\pi")) { tokens.push({ t: "NUM", v: Math.PI }); i += 3; continue; }
    for (const [name, fn] of FUNCTIONS) {
      for (const word of [`\\${name}`, name]) {
        if (rest.startsWith(word)) {
          tokens.push({ t: "FN", fn });
          i += word.length;
          continue outer;
        }
      }
    }
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push({ t: "NUM", v: parseFloat(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === "x") { tokens.push({ t: "VAR" }); i++; continue; }
    if (c === "e") { tokens.push({ t: "NUM", v: Math.E }); i++; continue; }
    if (c === "C" || c === "c") { tokens.push({ t: "CONST" }); i++; continue; } // integration constant, treated as 0
    if (c === "|") {
      tokens.push({ t: pipeOpen ? "PIPE_CLOSE" : "PIPE_OPEN" });
      pipeOpen = !pipeOpen;
      i++;
      continue;
    }
    if ("+-*/^(){}[]".includes(c)) {
      const map = { "(": "LPAREN", ")": "RPAREN", "{": "LBRACE", "}": "RBRACE", "[": "LBRACK", "]": "RBRACK" };
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
    return ["NUM", "VAR", "CONST", "LPAREN", "LBRACE", "PIPE_OPEN", "FN", "SQRT", "FRAC"].includes(tok.t);
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

  // A function's argument: a bracketed group, or a bare run of numbers and
  // x's - "sin 2x" is sin(2x), "ln x^2" is ln(x^2) - as students write it.
  function parseFuncArg() {
    const tok = peek();
    // "\sin(x)^2" is (sin x)^2: the power is left for the caller.
    if (tok && ["LPAREN", "LBRACE", "PIPE_OPEN"].includes(tok.t)) return parsePrimary();
    let node = parseUnary();
    while (peek() && (peek().t === "NUM" || peek().t === "VAR")) {
      const rhs = parsePower();
      const lhs = node;
      node = (x) => lhs(x) * rhs(x);
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
    if (tok.t === "FN") {
      next();
      // "\tan^3x" is (tan x)^3: the power comes before the argument.
      let power = null;
      if (peek() && peek().t === "^") {
        next();
        if (peek() && peek().t === "LBRACE") {
          next();
          power = parseExpr();
          expect("RBRACE");
        } else power = parsePrimary();
      }
      const arg = parseFuncArg();
      return power ? (x) => Math.pow(tok.fn(arg(x)), power(x)) : (x) => tok.fn(arg(x));
    }
    if (tok.t === "SQRT") {
      next();
      let index = null;
      if (peek() && peek().t === "LBRACK") { // sqrt[n]{...}
        next();
        index = parseExpr();
        expect("RBRACK");
      }
      const arg = parseUnary(); // sqrt{...}: the braces parse as a group
      return index ? (x) => nthRoot(arg(x), index(x)) : (x) => Math.sqrt(arg(x));
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
  // degree-3 numerator over a linear denominator
  div3: () => ({ Q: [randInt(-4, 4), randInt(-3, 3), nonZero(-2, 2)], terms: [{ A: nonZero(-6, 6), m: 1, n: randInt(-4, 4) }], display: "factored" }),
  // monic quadratic denominators
  pfFactored: () => ({ Q: [], terms: monicTerms({ coef: 5, root: 4 }), display: "factored" }),
  pfExpanded: () => ({ Q: [], terms: monicTerms({ coef: 7, root: 6 }), display: "expanded" }),
  pfDivide: () => ({ Q: [nonZero(-3, 3)], terms: monicTerms({ coef: 6, root: 5 }), display: "expanded" }),
  pfBoss: () => ({ Q: [randInt(-4, 4), nonZero(-3, 3)], terms: monicTerms({ coef: 6, root: 5 }), display: "expanded" }),
  // non-monic quadratic denominators
  nmFactored: () => ({ Q: [], terms: nonMonicTerms(), display: "factored" }),
  nmExpanded: () => ({ Q: [], terms: nonMonicTerms(), display: "expanded" }),
  nmDivide: () => ({ Q: [nonZero(-3, 3)], terms: nonMonicTerms(), display: "expanded" }),
  nmRepeated: () => generateNonMonicRepeated(),
  nmIrreducible: () => generateNonMonicIrreducible(),
  // repeated root (x - a)^2, solved by substitution
  repFactored: () => ({ ...generateRepeated([]), display: "factored" }),
  repExpanded: () => ({ ...generateRepeated([]), display: "expanded" }),
  repDegree2: () => ({ ...generateRepeated([nonZero(-3, 3)]), display: "expanded" }),
  // irreducible quadratic (x+p)^2 + k^2: complete the square, ln and arctan
  irrPlain: () => generateIrreducible([]),
  irrDegree2: () => generateIrreducible([nonZero(-3, 3)]),
  irrBoss: () => generateIrreducible([randInt(-4, 4), nonZero(-3, 3)]),
};

// --- LaTeX ------------------------------------------------------------------

function fmtSigned(n, isFirst) {
  if (n >= 0) return (isFirst ? "" : "+") + n;
  return "-" + Math.abs(n);
}

const signLatex = (c, isFirst) => (c < 0 ? "-" : isFirst ? "" : "+");
const xPower = (k, v = "x") => (k === 0 ? "" : k === 1 ? v : `${v}^${k}`);

// "m x - n" (m = 1 and n = 0 are dropped).
function mxLatex(m, n) {
  return `${m === 1 ? "" : m}x${n === 0 ? "" : fmtSigned(-n, false)}`;
}

function polyLatex(p, v = "x") {
  let out = "";
  for (let k = p.length - 1; k >= 0; k--) {
    const c = p[k];
    if (c === 0) continue;
    const abs = Math.abs(c);
    out += signLatex(c, out === "") + (k > 0 && abs === 1 ? "" : abs) + xPower(k, v);
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
  if (p.kind === "parts") return partsProblemLatex(p);
  if (p.kind === "basic") return basicProblemLatex(p);
  if (p.kind === "nmr") return nmrProblemLatex(p);
  if (p.kind === "nmi") return nmiProblemLatex(p);
  if (p.kind === "irr") return irrProblemLatex(p);
  if (p.kind === "rep") return repProblemLatex(p);
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
  if (p.kind === "parts") return partsAntiderivativeLatex(p);
  if (p.kind === "basic") return basicAntiderivativeLatex(p);
  if (p.kind === "nmr") return nmrAntiderivativeLatex(p);
  if (p.kind === "nmi") return nmiAntiderivativeLatex(p);
  if (p.kind === "irr") return irrAntiderivativeLatex(p);
  if (p.kind === "rep") return repAntiderivativeLatex(p);
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
  if (p.kind === "parts") return partsSolutionLatex(p);
  if (p.kind === "basic") return basicSolutionLatex(p);
  if (p.kind === "nmr") return nmrSolutionLatex(p);
  if (p.kind === "nmi") return nmiSolutionLatex(p);
  if (p.kind === "irr") return irrSolutionLatex(p);
  if (p.kind === "rep") return repSolutionLatex(p);
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
// Repeated root: denominator (x - a)^2, solved by substituting t = x - a
//
// Answer first: after t = x - a the integrand is (q t^2 + A t + B) / t^2
// = q + A/t + B/t^2, so the answer is q x + A ln|x - a| - B/(x - a) + C.
// A degree-2 numerator could go straight into the substitution, but the
// worked solution divides first - the order students are taught.
// Problem: { kind: "rep", a, Q, A, B, display }
// ---------------------------------------------------------------------------

function generateRepeated(Q) {
  return {
    kind: "rep",
    a: nonZero(-5, 5), // a root at 0 would make t = x: nothing to substitute
    Q, // quotient of the division ([] when the numerator has degree < 2)
    A: chance(0.2) ? 0 : nonZero(-6, 6), // A = 0: constant remainder, no ln at all
    B: nonZero(-9, 9),
  };
}

// The quotient (older saved runs stored a constant one as q).
const repQ = (p) => p.Q ?? (p.q ? [p.q] : []);

// N(x) = Q(x) (x - a)^2 + A (x - a) + B
function repNumeratorPoly(p) {
  const { a, A, B } = p;
  return polyAdd(polyMul(repQ(p), [a * a, -2 * a, 1]), trimPoly([B - A * a, A]));
}

const repTPoly = (p) => [p.B, p.A]; // the remainder in t: A t + B
const repFactorLatex = (p) => mxLatex(1, p.a); // "x - a"
const repDenLatex = (p) =>
  p.display === "expanded" ? polyLatex([p.a * p.a, -2 * p.a, 1]) : `(${repFactorLatex(p)})^2`;

function repProblemLatex(p) {
  return `\\int \\frac{${polyLatex(repNumeratorPoly(p))}}{${repDenLatex(p)}}\\,dx`;
}

// poly(x) with every x replaced by (base) - the substitution written out.
function polyInLatex(poly, base) {
  let out = "";
  for (let k = poly.length - 1; k >= 0; k--) {
    const c = poly[k];
    if (c === 0) continue;
    const abs = Math.abs(c);
    out += signLatex(c, out === "") + (k > 0 && abs === 1 ? "" : abs) + (k === 0 ? "" : k === 1 ? base : `${base}^${k}`);
  }
  return out || "0";
}

// A/t + B/t^2
function repSplitLatex(p) {
  let out = "";
  if (p.A) out += `${signLatex(p.A, true)}\\frac{${Math.abs(p.A)}}{t}`;
  return out + `${signLatex(p.B, out === "")}\\frac{${Math.abs(p.B)}}{t^2}`;
}

// A ln|u| - B/u + C, where u is "t" or "x - a".
function repIntegratedLatex(p, u) {
  let out = "";
  if (p.A) out += signLatex(p.A, true) + (Math.abs(p.A) === 1 ? "" : Math.abs(p.A)) + `\\ln|${u}|`;
  return out + `${signLatex(-p.B, out === "")}\\frac{${Math.abs(p.B)}}{${u}}+C`;
}

const repAntiderivativeLatex = (p) =>
  joinPlus(integratedQLatex(repQ(p)), repIntegratedLatex(p, repFactorLatex(p)));

// Worked solution by substitution. A numerator of degree 2 or more is
// divided first (N/(x-a)^2 = Q + R/(x-a)^2), so the substitution only meets
// the remainder R(x) = A(x - a) + B; then factor, substitute, split,
// integrate and substitute back.
function repSolutionLatex(p) {
  const factor = repFactorLatex(p);
  const rows = [];
  const Q = repQ(p);
  const rest = { ...p, Q: [], q: 0 }; // what is left for the substitution
  const R = repNumeratorPoly(rest);
  const Iq = integratedQLatex(Q); // ∫Q dx
  const intR = (den) => `\\int \\frac{${polyLatex(R)}}{${den}}\\,dx`;

  if (Q.length) {
    rows.push(`&= \\int\\left(${polyLatex(Q)}${fracTermLatex(R, repDenLatex(p))}\\right)dx`);
    if (p.display === "expanded") rows.push(`&= \\int\\left(${polyLatex(Q)}${fracTermLatex(R, `(${factor})^2`)}\\right)dx`);
    rows.push(`&= ${joinPlus(Iq, intR(`(${factor})^2`))}`);
  } else if (p.display === "expanded") {
    rows.push(`&= ${intR(`(${factor})^2`)}`);
  }
  rows.push(`&\\qquad \\left[\\,t=${factor},\\ \\ x=t${fmtSigned(p.a, false)},\\ \\ dx=dt\\,\\right]`);
  const substituted = polyInLatex(R, `(t${fmtSigned(p.a, false)})`);
  const inT = polyLatex(repTPoly(rest), "t");
  rows.push(`&= ${joinPlus(Iq, `\\int \\frac{${substituted}}{t^2}\\,dt`)}`);
  if (inT !== substituted) rows.push(`&= ${joinPlus(Iq, `\\int \\frac{${inT}}{t^2}\\,dt`)}`);
  rows.push(`&= ${joinPlus(Iq, `\\int\\left(${repSplitLatex(rest)}\\right)dt`)}`);
  rows.push(`&= ${joinPlus(Iq, repIntegratedLatex(rest, "t"))}`);
  rows.push(`&= ${repAntiderivativeLatex(p)}`);
  return `\\begin{aligned}${repProblemLatex(p)} ${rows.join(" \\\\ ")}\\end{aligned}`;
}

const repIntegrandFn = (p) => {
  const Q = repQ(p);
  return (x) => polyEval(Q, x) + p.A / (x - p.a) + p.B / ((x - p.a) * (x - p.a));
};

function repNearMissVariants(p) {
  const variants = [
    { kind: "repLn", problem: { ...p, A: p.A + p.B, B: 0 } }, // B/t^2 integrated as B ln|t|
    { kind: "repSign", problem: { ...p, B: -p.B } }, // +B/t instead of -B/t
  ];
  if (p.A) variants.push({ kind: "sign", problem: { ...p, A: -p.A } });
  variants.push({ kind: "subSign", problem: { ...p, a: -p.a } }); // t = x + a instead of x - a
  if (repQ(p).length) variants.push({ kind: "repConst", problem: { ...p, Q: [], q: 0 } });
  return variants;
}

// ---------------------------------------------------------------------------
// Review: a mix of the three core types, with the type left for the student
// to recognize. Each run draws a plan of types up front (40% distinct roots,
// 40% irreducible, 20% repeated root; never all three the same), and each
// exercise always has its denominator to factor or complete, with a division
// (degree-2 or degree-3 numerator) 70% of the time.
// ---------------------------------------------------------------------------

function drawReviewType() {
  const r = Math.random();
  return r < 0.4 ? "distinct" : r < 0.8 ? "irreducible" : "repeated";
}

function drawReviewPlan(length) {
  const plan = [];
  while (plan.length < length) {
    const type = drawReviewType();
    const allSame = plan.length === length - 1 && plan.length > 1 && plan.every((t) => t === type);
    if (!allSame) plan.push(type);
  }
  return plan;
}

function generateReviewExercise(type) {
  const degree = chance(0.7) ? (chance(0.5) ? 2 : 3) : 1; // numerator degree
  const Q = degree === 1 ? [] : degree === 2 ? [nonZero(-3, 3)] : [randInt(-4, 4), nonZero(-3, 3)];
  if (type === "repeated") return { ...generateRepeated(Q), display: "expanded" };
  if (type === "irreducible") return generateIrreducible(Q);
  return { Q, terms: monicTerms({ coef: 6, root: 5 }), display: "expanded" };
}

// ---------------------------------------------------------------------------
// Irreducible quadratic: denominator (x + p)^2 + k^2, no real roots
//
// Taught as: (divide,) complete the square, substitute t = x + p, then use
// the two known formulas (no second substitution for the ln):
//   ∫ t/(t^2+k^2) dt = ½ ln(t^2+k^2)     ∫ 1/(t^2+k^2) dt = (1/k) arctan(t/k)
// Answer first: integrand = Q(x) + (2c t + d k)/(t^2 + k^2), so the answer is
// ∫Q + c ln((x+p)^2+k^2) + d arctan((x+p)/k) + C with whole c and d; k^2 is
// a perfect square, so no square roots appear.
// Problem: { kind: "irr", p, k, c, d, Q }  (+ ka, only in near-miss variants:
// the k inside the arctan when it differs from the one in the denominator)
// ---------------------------------------------------------------------------

function generateIrreducible(Q) {
  let c, d;
  do {
    c = chance(0.2) ? 0 : nonZero(-4, 4); // c = 0: arctan only
    d = chance(0.2) ? 0 : nonZero(-4, 4); // d = 0: ln only
  } while (c === 0 && d === 0);
  return { kind: "irr", p: chance(0.1) ? 0 : nonZero(-4, 4), k: randInt(1, 3), c, d, Q };
}

const irrDenPoly = ({ p, k }) => [p * p + k * k, 2 * p, 1];
const irrRemainderPoly = ({ p, k, c, d }) => trimPoly([2 * c * p + d * k, 2 * c]); // 2c(x+p) + dk
const irrNumeratorPoly = (q) => polyAdd(polyMul(q.Q, irrDenPoly(q)), irrRemainderPoly(q));
const irrShift = (q) => (q.p === 0 ? "x" : mxLatex(1, -q.p)); // "x + p"
const irrSquareLatex = (q) => (q.p === 0 ? "x^2" : `(${irrShift(q)})^2`) + `+${q.k * q.k}`;

function irrProblemLatex(q) {
  return `\\int \\frac{${polyLatex(irrNumeratorPoly(q))}}{${polyLatex(irrDenPoly(q))}}\\,dx`;
}

// ∫Q dx, e.g. "\frac{1}{2}x^2-3x"
function integratedQLatex(Q) {
  let out = "";
  for (let i = Q.length - 1; i >= 0; i--) out += fracMonomialLatex(Q[i], i + 1, i + 1, out === "");
  return out;
}

// c ln(lnArg) + d arctan(atanNum / k)
function irrLogAtanLatex(q, lnArg, atanNum) {
  let out = "";
  if (q.c) out += signLatex(q.c, true) + (Math.abs(q.c) === 1 ? "" : Math.abs(q.c)) + `\\ln\\left(${lnArg}\\right)`;
  if (q.d) {
    const arg = q.k === 1 ? atanNum : `\\frac{${atanNum}}{${q.k}}`;
    out += signLatex(q.d, out === "") + (Math.abs(q.d) === 1 ? "" : Math.abs(q.d)) + `\\arctan\\left(${arg}\\right)`;
  }
  return out;
}

const joinPlus = (a, b) => (a && b && !b.startsWith("-") ? `${a}+${b}` : `${a}${b}`);

function irrAntiderivativeLatex(q) {
  return joinPlus(integratedQLatex(q.Q), irrLogAtanLatex(q, polyLatex(irrDenPoly(q)), irrShift(q))) + "+C";
}

// Worked solution: divide, complete the square, substitute, split, apply the
// two formulas, substitute back.
function irrSolutionLatex(q) {
  const rows = [];
  const R = irrRemainderPoly(q);
  const D = polyLatex(irrDenPoly(q));
  const sq = irrSquareLatex(q);
  const Iq = integratedQLatex(q.Q);
  const v = q.p === 0 ? "x" : "t"; // with p = 0 there is nothing to substitute
  const vDen = `${v}^2+${q.k * q.k}`;

  if (q.Q.length) {
    rows.push(`&= \\int\\left(${polyLatex(q.Q)}${fracTermLatex(R, D)}\\right)dx`);
    rows.push(`&= ${joinPlus(Iq, `\\int \\frac{${polyLatex(R)}}{${D}}\\,dx`)}`);
  }
  if (q.p !== 0) {
    rows.push(`&= ${joinPlus(Iq, `\\int \\frac{${polyLatex(R)}}{${sq}}\\,dx`)}`);
    rows.push(`&\\qquad \\left[\\,t=${irrShift(q)},\\ \\ x=t${fmtSigned(-q.p, false)},\\ \\ dx=dt\\,\\right]`);
    const substituted = polyInLatex(R, `(t${fmtSigned(-q.p, false)})`);
    const inT = polyLatex(trimPoly([q.d * q.k, 2 * q.c]), "t");
    rows.push(`&= ${joinPlus(Iq, `\\int \\frac{${substituted}}{${vDen}}\\,dt`)}`);
    if (inT !== substituted) rows.push(`&= ${joinPlus(Iq, `\\int \\frac{${inT}}{${vDen}}\\,dt`)}`);
  }
  const parts = [];
  if (q.c) parts.push(`${signLatex(q.c, parts.length === 0)}\\frac{${Math.abs(2 * q.c)}${v}}{${vDen}}`);
  if (q.d) parts.push(`${signLatex(q.d, parts.length === 0)}\\frac{${Math.abs(q.d * q.k)}}{${vDen}}`);
  if (parts.length === 2) rows.push(`&= ${joinPlus(Iq, `\\int\\left(${parts.join("")}\\right)d${v}`)}`);
  rows.push(`&= ${joinPlus(Iq, irrLogAtanLatex(q, vDen, v))}+C`);
  if (q.p !== 0) rows.push(`&= ${joinPlus(Iq, irrLogAtanLatex(q, sq, irrShift(q)))}+C`);
  return `\\begin{aligned}${irrProblemLatex(q)} ${rows.join(" \\\\ ")}\\end{aligned}`;
}

function irrIntegrandFn(q) {
  const ka = q.ka ?? q.k;
  return (x) => {
    const t = x + q.p;
    return polyEval(q.Q, x) + (2 * q.c * t) / (t * t + q.k * q.k) + (q.d * ka) / (t * t + ka * ka);
  };
}

// No poles: sample on both sides of the vertex and around it.
const irrSampleZones = ({ p }) => [[-p - 6, -p - 2], [-p - 2, -p + 2], [-p + 2, -p + 6]];

function irrNearMissVariants(q) {
  const variants = [];
  if (q.c) variants.push({ kind: "lnHalf", problem: { ...q, c: 2 * q.c } }); // no ½ before the ln
  if (q.d && q.k !== 1) {
    variants.push({ kind: "atanCoef", problem: { ...q, d: q.d * q.k } }); // no 1/k before the arctan
    variants.push({ kind: "atanArg", problem: { ...q, ka: 1 } }); // arctan(t) instead of arctan(t/k)
  }
  if (q.c) variants.push({ kind: "sign", problem: { ...q, c: -q.c } });
  if (q.d) variants.push({ kind: "sign", problem: { ...q, d: -q.d } });
  if (q.p) variants.push({ kind: "squareSign", problem: { ...q, p: -q.p } });
  if (q.Q.length) variants.push({ kind: "quotient", problem: { ...q, Q: [] } });
  return variants;
}

// ---------------------------------------------------------------------------
// Non-monic repeated root and irreducible quadratic (the extension room)
//
// One idea in both: substitute t = m x + n, so dx = dt/m. The leading
// coefficient is a perfect square (4x^2, 9x^2), so the factor or the
// completed square is (m x + n) with m = 2 or 3 and whole numbers only.
// ---------------------------------------------------------------------------

// Repeated: (m x - n)^2. Answer first: integrand A m/(m x - n) + B m/(m x - n)^2,
// answer A ln|m x - n| - B/(m x - n) + C; after t = m x - n the numerator is
// A m t + B m, and the 1/m from dx cancels the m.
// Problem: { kind: "nmr", m, n, A, B }
function generateNonMonicRepeated() {
  let m, n;
  do {
    m = randInt(2, 3);
    n = nonZero(-5, 5);
  } while (gcd(m, n) !== 1);
  return { kind: "nmr", m, n, A: chance(0.2) ? 0 : nonZero(-5, 5), B: nonZero(-6, 6) };
}

const nmrFactorLatex = (p) => mxLatex(p.m, p.n); // "m x - n"
const nmrNumeratorPoly = ({ m, n, A, B }) => trimPoly([B * m - A * m * n, A * m * m]);
const nmrDenPoly = ({ m, n }) => [n * n, -2 * m * n, m * m];

function nmrProblemLatex(p) {
  return `\\int \\frac{${polyLatex(nmrNumeratorPoly(p))}}{${polyLatex(nmrDenPoly(p))}}\\,dx`;
}

const nmrAntiderivativeLatex = (p) => repIntegratedLatex(p, nmrFactorLatex(p));

function nmrSolutionLatex(p) {
  const factor = nmrFactorLatex(p);
  const rows = [
    `&= \\int \\frac{${polyLatex(nmrNumeratorPoly(p))}}{(${factor})^2}\\,dx`,
    `&\\qquad \\left[\\,t=${factor},\\ \\ dx=\\frac{dt}{${p.m}}\\,\\right]`,
    `&= \\int \\frac{${polyLatex(trimPoly([p.B * p.m, p.A * p.m]), "t")}}{t^2}\\cdot\\frac{dt}{${p.m}}`,
    `&= \\int \\frac{${polyLatex(trimPoly([p.B, p.A]), "t")}}{t^2}\\,dt`,
    `&= \\int\\left(${repSplitLatex(p)}\\right)dt`,
    `&= ${repIntegratedLatex(p, "t")}`,
    `&= ${nmrAntiderivativeLatex(p)}`,
  ];
  return `\\begin{aligned}${nmrProblemLatex(p)} ${rows.join(" \\\\ ")}\\end{aligned}`;
}

const nmrIntegrandFn = ({ m, n, A, B }) => (x) => {
  const u = m * x - n;
  return (A * m) / u + (B * m) / (u * u);
};

function nmrNearMissVariants(p) {
  const variants = [
    { kind: "subFactor", problem: { ...p, A: p.A * p.m, B: p.B * p.m } }, // dx = dt/m forgotten
    { kind: "repLn", problem: { ...p, A: p.A + p.B, B: 0 } },
    { kind: "repSign", problem: { ...p, B: -p.B } },
  ];
  if (p.A) variants.push({ kind: "sign", problem: { ...p, A: -p.A } });
  return variants;
}

// Irreducible: (m x + p)^2 + k^2. Answer first: c ln((m x + p)^2 + k^2) +
// d arctan((m x + p)/k) + C; after t = m x + p the integrand is
// (2c m t + d k m)/(t^2 + k^2), and dx = dt/m leaves (2c t + d k)/(t^2 + k^2).
// Problem: { kind: "nmi", m, p, k, c, d }  (+ ka in near-miss variants)
function generateNonMonicIrreducible() {
  let m, p, c, d;
  do {
    m = randInt(2, 3);
    p = nonZero(-5, 5);
  } while (gcd(m, p) !== 1); // otherwise the whole denominator has a common factor
  do {
    c = chance(0.2) ? 0 : nonZero(-3, 3);
    d = chance(0.2) ? 0 : nonZero(-3, 3);
  } while (c === 0 && d === 0);
  return { kind: "nmi", m, p, k: randInt(1, 3), c, d };
}

const nmiShift = (q) => mxLatex(q.m, -q.p); // "m x + p"
const nmiDenPoly = ({ m, p, k }) => [p * p + k * k, 2 * m * p, m * m];
const nmiNumeratorPoly = ({ m, p, k, c, d }) => trimPoly([2 * c * m * p + d * k * m, 2 * c * m * m]);
const nmiSquareLatex = (q) => `(${nmiShift(q)})^2+${q.k * q.k}`;

function nmiProblemLatex(q) {
  return `\\int \\frac{${polyLatex(nmiNumeratorPoly(q))}}{${polyLatex(nmiDenPoly(q))}}\\,dx`;
}

const nmiAntiderivativeLatex = (q) => irrLogAtanLatex(q, polyLatex(nmiDenPoly(q)), nmiShift(q)) + "+C";

function nmiSolutionLatex(q) {
  const tDen = `t^2+${q.k * q.k}`;
  const rows = [
    `&= \\int \\frac{${polyLatex(nmiNumeratorPoly(q))}}{${nmiSquareLatex(q)}}\\,dx`,
    `&\\qquad \\left[\\,t=${nmiShift(q)},\\ \\ dx=\\frac{dt}{${q.m}}\\,\\right]`,
    `&= \\int \\frac{${polyLatex(trimPoly([q.d * q.k * q.m, 2 * q.c * q.m]), "t")}}{${tDen}}\\cdot\\frac{dt}{${q.m}}`,
    `&= \\int \\frac{${polyLatex(trimPoly([q.d * q.k, 2 * q.c]), "t")}}{${tDen}}\\,dt`,
  ];
  if (q.c && q.d) {
    rows.push(`&= \\int\\left(${signLatex(q.c, true)}\\frac{${Math.abs(2 * q.c)}t}{${tDen}}${signLatex(q.d, false)}\\frac{${Math.abs(q.d * q.k)}}{${tDen}}\\right)dt`);
  }
  rows.push(`&= ${irrLogAtanLatex(q, tDen, "t")}+C`);
  rows.push(`&= ${irrLogAtanLatex(q, nmiSquareLatex(q), nmiShift(q))}+C`);
  return `\\begin{aligned}${nmiProblemLatex(q)} ${rows.join(" \\\\ ")}\\end{aligned}`;
}

function nmiIntegrandFn(q) {
  const ka = q.ka ?? q.k;
  return (x) => {
    const t = q.m * x + q.p;
    return (2 * q.c * q.m * t) / (t * t + q.k * q.k) + (q.d * q.m * ka) / (t * t + ka * ka);
  };
}

function nmiNearMissVariants(q) {
  const variants = [{ kind: "subFactor", problem: { ...q, c: q.c * q.m, d: q.d * q.m } }]; // dx = dt/m forgotten
  if (q.c) variants.push({ kind: "lnHalf", problem: { ...q, c: 2 * q.c } });
  if (q.d && q.k !== 1) {
    variants.push({ kind: "atanCoef", problem: { ...q, d: q.d * q.k } });
    variants.push({ kind: "atanArg", problem: { ...q, ka: 1 } });
  }
  if (q.c) variants.push({ kind: "sign", problem: { ...q, c: -q.c } });
  if (q.d) variants.push({ kind: "sign", problem: { ...q, d: -q.d } });
  variants.push({ kind: "squareSign", problem: { ...q, p: -q.p } });
  return variants;
}

// ---------------------------------------------------------------------------
// Checking: differentiate the student's answer numerically and compare it
// with the integrand on every interval between the poles.
// ---------------------------------------------------------------------------

function integrandFn(p) {
  if (p.kind === "parts") return partsIntegrandFn(p);
  if (p.kind === "basic") return basicIntegrandFn(p);
  if (p.kind === "nmr") return nmrIntegrandFn(p);
  if (p.kind === "nmi") return nmiIntegrandFn(p);
  if (p.kind === "irr") return irrIntegrandFn(p);
  if (p.kind === "rep") return repIntegrandFn(p);
  return (x) => polyEval(p.Q, x) + p.terms.reduce((s, t) => s + (t.A * t.m) / (t.m * x - t.n), 0);
}

function sampleZones(p) {
  if (p.kind === "parts") return partsSampleZones(p);
  if (p.kind === "basic") return basicSampleZones(p);
  if (p.kind === "nmr") return sampleZones({ kind: "rep", a: p.n / p.m });
  if (p.kind === "nmi") return irrSampleZones({ p: p.p / p.m });
  if (p.kind === "irr") return irrSampleZones(p);
  const poles = p.kind === "rep" ? [p.a] : p.terms.map((t) => t.n / t.m).sort((a, b) => a - b);
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
  if (p.kind === "parts") return partsNearMissVariants(p);
  if (p.kind === "basic") return basicNearMissVariants(p);
  if (p.kind === "nmr") return nmrNearMissVariants(p);
  if (p.kind === "nmi") return nmiNearMissVariants(p);
  if (p.kind === "irr") return irrNearMissVariants(p);
  if (p.kind === "rep") return repNearMissVariants(p);
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
  // Still in the substitution variable: a reminder, not a mistake.
  if (/t/.test(latex.replace(/\\[a-zA-Z]+/g, "").replace(/arctan|arctg|tan|ctg|tg|cot|sqrt/g, ""))) {
    return { status: "unreadable", reason: "t" };
  }
  let F;
  try {
    F = buildEvaluator(latex);
  } catch {
    return { status: "unreadable" };
  }
  return checkAntiderivative(p, F);
}

// The same check for an answer already turned into a function.
function checkAntiderivative(p, F) {
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
  repLn: `כמעט! האינטגרל של ${ltr("1/t²")} הוא לא ${ltr("ln")}: ${ltr("∫t⁻² dt = −t⁻¹ = −1/t")}.`,
  repSign: `כמעט! בדקו את הסימן של האיבר עם ${ltr("1/t")}: ${ltr("∫t⁻² dt = −1/t")}.`,
  subSign: `כמעט! בדקו את הסימן בהצבה: האם ${ltr("t = x+a")} או ${ltr("t = x−a")}?`,
  repConst: `כמעט! חסר החלק הפולינומי - המנה (${ltr("quotient")}) מהחילוק.`,
  lnHalf: `כמעט! חסר חצי לפני ה-${ltr("ln")}: ${ltr("∫ t/(t²+k²) dt = ½·ln(t²+k²)")}.`,
  atanCoef: `כמעט! בדקו את המקדם לפני ה-${ltr("arctan")}: ${ltr("∫ dt/(t²+k²) = (1/k)·arctan(t/k)")}.`,
  atanArg: `כמעט! בדקו את מה שבתוך ה-${ltr("arctan")}: צריך ${ltr("arctan(t/k)")} ולא ${ltr("arctan(t)")}.`,
  subFactor: `כמעט! לא לשכוח: ${ltr("t = mx+n")} ולכן ${ltr("dx = dt/m")} - חסר המקדם ${ltr("1/m")}.`,
  squareSign: `כמעט! בדקו את הסימן בהשלמה לריבוע - ${ltr("(x+p)²")} או ${ltr("(x−p)²")}?`,
};

// ---------------------------------------------------------------------------
// Basic integrals (floor 1, room 1): sums of entries from the integral table
//
// Answer first: the integrand is a sum of terms, each a whole coefficient
// times one table function, and the answer is the sum of their integrals.
//   { t: "pow", c, p, q }   c x^(p/q)  (q > 0, p/q in lowest terms)
//   { t: "exp", c }         c e^x
//   { t: "sin", c } / { t: "cos", c }
//   { t: "sec2", c }        c / cos^2 x
//   { t: "atan", c }        c / (1 + x^2)
// The extension room adds:
//   { t: "axp", c, b }      c b^x  (b = 2, 3, 5, 10)
//   { t: "csc2", c }        c / sin^2 x
//   { t: "asin", c }        c / sqrt(1 - x^2)
// and slips may use { t: "custom", c, f } (c f(x)).
// Only the near-miss variants use { t: "lnq", c } (2c x/(1+x^2), the
// derivative of c ln(1+x^2)) and a whole-integrand override `fn`.
// Room 2 gives a term an argument u = a x + b in place of x:
//   u: [num, den, b]  with a = num/den (den > 1 only for x/2, x/3)
// and its integral is F(u)/a - the formula taught for f(ax+b).
// Problem: { kind: "basic", shown, terms, steps?, boss? } where `shown` is
// the integrand as the exam writes it (roots, fractions) and `steps` are the
// rewriting lines of a "simplify first" exercise.
// ---------------------------------------------------------------------------

const ratio = (n, d) => {
  if (d < 0) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1;
  return [n / g, d / g];
};

function shuffled(a) {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const pick = (a) => a[randInt(0, a.length - 1)];
const pow = (c, p, q = 1) => ({ t: "pow", c, p, q });

// --- values -----------------------------------------------------------------

const linA = (t) => (t.u ? t.u[0] / t.u[1] : 1); // the a of a x + b
const linValue = (t, x) => (t.u ? linA(t) * x + t.u[2] : x);

function basicTermValue(term, x) {
  const { c } = term;
  const v = linValue(term, x);
  switch (term.t) {
    case "pow": return c * (term.q === 1 ? v ** term.p : Math.pow(v, term.p / term.q));
    case "exp": return c * Math.exp(v);
    case "sin": return c * Math.sin(v);
    case "cos": return c * Math.cos(v);
    case "sec2": return c / Math.cos(v) ** 2;
    case "atan": return c / (1 + v * v);
    case "lnq": return (2 * c * v) / (1 + v * v); // (c/a) ln(1+u^2), differentiated
    case "axp": return c * term.b ** v;
    case "csc2": return c / Math.sin(v) ** 2;
    case "asin": return c / Math.sqrt(1 - v * v);
    case "custom": return c * term.f(v);
  }
  return NaN;
}

const basicIntegrandFn = (p) => p.fn || ((x) => p.terms.reduce((s, t) => s + basicTermValue(t, x), 0));

// Where a term's argument v may be sampled: inside a root's domain, near a
// pole but not on it, inside (-pi/2, pi/2) for 1/cos^2 and for 1/(1+v^2)
// (whose slip is tan), and small enough that a big power or e^v doesn't
// swamp the other terms within the checker's 1% tolerance.
function linTermAllows(t, v) {
  const a = Math.abs(v);
  switch (t.t) {
    case "pow":
      if (t.q > 1) return v >= 0.15 && v <= 3;
      if (t.p < 0) return a >= 0.2 && a <= 2;
      return a <= 2;
    case "exp": return a <= 3;
    case "sec2":
    case "atan": return a <= 1.3;
    case "axp": return a <= 2;
    case "csc2": return a >= 0.35 && a <= 1.3;
    case "asin": return a <= 0.9;
  }
  return a <= 6;
}

// The x's in [-4, 4] (step 0.005) where every term may be sampled.
function linCandidates(p) {
  const out = [];
  for (let i = -800; i <= 800; i++) {
    const x = i / 200;
    if (p.terms.every((t) => linTermAllows(t, linValue(t, x)))) out.push(x);
  }
  return out;
}

const lnTerms = (p) => p.terms.filter((t) => t.t === "pow" && t.p === -t.q && t.u);

// Where a term carries real weight: at least half of all the other terms
// together. A slip in a term only shows (beyond the checker's 1% tolerance)
// at such points.
function dominantFor(p, i, xs) {
  return xs.filter((x) => {
    const vals = p.terms.map((t) => Math.abs(basicTermValue(t, x)));
    const others = vals.reduce((s, v) => s + v, 0) - vals[i];
    return vals[i] >= 0.5 * others;
  });
}

// Enough room to sample, every term weighty somewhere, and both signs
// inside every ln|u| (so a missing | | shows up).
function linFits(p) {
  const xs = linCandidates(p);
  if (xs.length < 60) return false;
  if (!p.terms.every((_, i) => dominantFor(p, i, xs).length >= 8)) return false;
  return lnTerms(p).every((t) => xs.filter((x) => linValue(t, x) > 0).length >= 10 && xs.filter((x) => linValue(t, x) < 0).length >= 10);
}

// Room 2: points spread over the allowed x's, three where each term is
// weighty, and three on each side of every ln|u|. One-point zones.
function linSampleZones(p) {
  const xs = linCandidates(p);
  const pts = [];
  for (let k = 0; k < 8; k++) {
    const chunk = xs.slice(Math.floor((k * xs.length) / 8), Math.floor(((k + 1) * xs.length) / 8));
    if (chunk.length) pts.push(pick(chunk));
  }
  p.terms.forEach((_, i) => {
    const own = dominantFor(p, i, xs);
    for (let k = 0; k < 3 && own.length; k++) pts.push(pick(own));
  });
  for (const t of lnTerms(p)) {
    for (const side of [1, -1]) {
      const own = xs.filter((x) => side * linValue(t, x) > 0);
      for (let k = 0; k < 3 && own.length; k++) pts.push(pick(own));
    }
  }
  return pts.map((x) => [x, x]);
}

// Points near 0 and further out, on both sides of 0 (so ln x without | |
// shows up). Within the checker's 1% tolerance a slip in one term hides
// where another term is far bigger: a wrong 1/x^n or a dropped constant
// shows near 0, a wrong x^5 only further out - so both bands are sampled.
// Roots: x > 0 only. 1/cos^2 x, and 1/(1+x^2) (whose slip is tan x):
// inside (-pi/2, pi/2).
const EXTRA_TYPES = ["axp", "csc2", "asin"];

function basicSampleZones(p) {
  if (p.terms.some((t) => t.u || EXTRA_TYPES.includes(t.t))) return linSampleZones(p);
  if (p.terms.some((t) => t.t === "pow" && t.q > 1)) return [[0.2, 0.5], [0.6, 1], [1.2, 2.5]];
  const trig = p.terms.some((t) => t.t === "sec2" || t.t === "atan");
  const pole = p.terms.some((t) => t.t === "pow" && t.p < 0);
  const [a, b, c, d] = trig ? [0.15, 0.6, 0.7, 1.3] : pole ? [0.25, 0.7, 0.8, 1.6] : [0.2, 0.8, 1, 2];
  return [[-d, -c], [-b, -a], [a, b], [c, d]];
}

// --- LaTeX ------------------------------------------------------------------

const absCoef = (c) => (Math.abs(c) === 1 ? "" : Math.abs(c)); // "x", not "1x"

// The argument a x + b: "x", "3x-2", "5-x", "\frac{x}{2}".
function argLatex(t) {
  if (!t.u) return "x";
  const [num, den, b] = t.u;
  if (den > 1) return `${num < 0 ? "-" : ""}\\frac{x}{${den}}${b ? fmtSigned(b, false) : ""}`;
  const ax = `${num < 0 ? "-" : ""}${Math.abs(num) === 1 ? "" : Math.abs(num)}x`;
  if (!b) return ax;
  return num < 0 && b > 0 ? `${b}${ax}` : `${ax}${fmtSigned(b, false)}`;
}

// The argument as a base for a power: "x" or "\left(3x-2\right)".
const baseLatex = (t) => (t.u ? `\\left(${argLatex(t)}\\right)` : "x");

// After a function name: "\sin x", "\sin 4x", "\sin\frac{x}{2}",
// "\sin\left(1-3x\right)".
const fnArgLatex = (t) => (t.u && t.u[2] !== 0 ? `\\left(${argLatex(t)}\\right)` : ` ${argLatex(t)}`);

// "x^{\frac{2}{5}}", "x^{-\frac{1}{2}}", "x^{-3}" - of the term's argument.
function powerLatex(p, q, t = {}) {
  if (q === 1) return p === 0 ? "" : p === 1 ? argLatex(t) : `${baseLatex(t)}^{${p}}`;
  return `${baseLatex(t)}^{${p < 0 ? "-" : ""}\\frac{${Math.abs(p)}}{${q}}}`;
}

// A positive whole power, as written in an exercise: "x^3", "(2x+1)^3".
const wholePowerLatex = (k, t) => (k === 1 ? argLatex(t) : t.u ? `${baseLatex(t)}^${k}` : xPower(k));

// The argument to the power p inside a root: "\sqrt{x}", "\sqrt[3]{(2x-3)^2}".
function rootLatex(p, q, t = {}) {
  const inner = wholePowerLatex(p, t);
  return q === 2 ? `\\sqrt{${inner}}` : `\\sqrt[${q}]{${inner}}`;
}

// One term as the exam shows it: roots and fractions, whole coefficients.
function shownTermLatex(term, isFirst) {
  const sign = signLatex(term.c, isFirst);
  const abs = Math.abs(term.c);
  const f = fnArgLatex(term);
  switch (term.t) {
    case "pow": {
      const { p, q } = term;
      if (q === 1) {
        if (p === 0) return sign + abs;
        if (p > 0) return sign + absCoef(term.c) + wholePowerLatex(p, term);
        return `${sign}\\frac{${abs}}{${wholePowerLatex(-p, term)}}`;
      }
      if (p > 0) return sign + absCoef(term.c) + rootLatex(p, q, term);
      return `${sign}\\frac{${abs}}{${rootLatex(-p, q, term)}}`;
    }
    case "exp": return `${sign}${absCoef(term.c)}e^{${argLatex(term)}}`;
    case "sin": return `${sign}${absCoef(term.c)}\\sin${f}`;
    case "cos": return `${sign}${absCoef(term.c)}\\cos${f}`;
    case "sec2": return `${sign}\\frac{${abs}}{\\cos^2${f}}`;
    case "atan": {
      const a2 = linA(term) ** 2; // 1/(1+(ax)^2), b = 0
      return `${sign}\\frac{${abs}}{1+${a2 === 1 ? "" : a2}x^2}`;
    }
    case "axp": return `${sign}${abs === 1 ? "" : `${abs}\\cdot `}${term.b}^{${argLatex(term)}}`;
    case "csc2": return `${sign}\\frac{${abs}}{\\sin^2${f}}`;
    case "asin": {
      const a2 = linA(term) ** 2; // 1/sqrt(1-(ax)^2), b = 0
      return `${sign}\\frac{${abs}}{\\sqrt{1-${a2 === 1 ? "" : a2}x^2}}`;
    }
  }
  return "";
}

// The same term written as a power of its argument, ready for the power rule.
function powerTermLatex(term, isFirst) {
  if (term.t !== "pow" || (term.p >= 0 && term.q === 1) || term.p === -term.q) return shownTermLatex(term, isFirst);
  return signLatex(term.c, isFirst) + absCoef(term.c) + powerLatex(term.p, term.q, term);
}

// A reduced coefficient num/den in front of `body`.
function coefLatex(num, den, body, isFirst) {
  const abs = Math.abs(num);
  const coef = den === 1 ? (abs === 1 && body ? "" : `${abs}`) : `\\frac{${abs}}{${den}}`;
  return signLatex(num, isFirst) + coef + body;
}

// (num/den) u^(P/Q), reduced; negative powers go under a fraction bar.
function powerAnswerLatex(num, den, P, Q, isFirst, t = {}) {
  if (P === 0) return coefLatex(num, den, "", isFirst);
  if (P > 0) return coefLatex(num, den, Q === 2 && P === 1 ? `\\sqrt{${argLatex(t)}}` : powerLatex(P, Q, t), isFirst);
  // c u^(-k) = c / u^k; a root when 0 < k < 1
  let under = Q === 1 ? wholePowerLatex(-P, t) : -P < Q ? rootLatex(-P, Q, t) : powerLatex(-P, Q, t);
  if (den !== 1 && t.u && Q === 1 && P === -1) under = baseLatex(t); // 3(1-3x), not 31-3x
  return `${signLatex(num, isFirst)}\\frac{${Math.abs(num)}}{${den === 1 ? "" : den}${under}}`;
}

// The table's antiderivative of one function, without coefficient.
function tableIntegralLatex(t) {
  const f = fnArgLatex(t);
  switch (t.t) {
    case "exp": return `e^{${argLatex(t)}}`;
    case "sin": return `\\cos${f}`; // with a minus
    case "cos": return `\\sin${f}`;
    case "sec2": return `\\tan${f}`;
    case "atan": return t.u ? `\\arctan\\left(${argLatex(t)}\\right)` : "\\arctan x";
    case "csc2": return `\\cot${f}`; // with a minus
    case "asin": return t.u ? `\\arcsin\\left(${argLatex(t)}\\right)` : "\\arcsin x";
    case "axp": return `\\frac{${t.b}^{${argLatex(t)}}}{\\ln ${t.b}}`;
  }
  return "";
}

// c f(ax+b)  ->  (c/a) F(ax+b).
function integratedTermLatex(term, isFirst) {
  const { c } = term;
  const [an, ad] = term.u ? [term.u[0], term.u[1]] : [1, 1]; // a = an/ad
  if (term.t === "pow") {
    const { p, q } = term;
    if (p === -q) {
      const [num, den] = ratio(c * ad, an);
      return coefLatex(num, den, `\\ln|${argLatex(term)}|`, isFirst);
    }
    const [P, Q] = ratio(p + q, q); // the new exponent
    const [num, den] = ratio(c * q * ad, (p + q) * an); // c divided by it and by a
    return powerAnswerLatex(num, den, P, Q, isFirst, term);
  }
  const minus = term.t === "sin" || term.t === "csc2";
  const [num, den] = ratio((minus ? -c : c) * ad, an);
  if (term.t === "axp") {
    // (num/den) b^u / ln b, as one fraction
    const top = `${Math.abs(num) === 1 ? "" : `${Math.abs(num)}\\cdot `}${term.b}^{${argLatex(term)}}`;
    return `${signLatex(num, isFirst)}\\frac{${top}}{${den === 1 ? "" : den}\\ln ${term.b}}`;
  }
  return coefLatex(num, den, tableIntegralLatex(term), isFirst);
}

// Room 2's middle line: each term as c * (1/a) * F(ax+b), unsimplified.
function formulaTermLatex(term, isFirst) {
  if (!term.u) return integratedTermLatex(term, isFirst);
  const [an, ad] = term.u;
  const lead = signLatex(term.c, isFirst) + (Math.abs(term.c) === 1 ? "" : `${Math.abs(term.c)}\\cdot `);
  const overA = ad === 1 ? `\\frac{1}{${an}}` : `\\frac{1}{${an < 0 ? "-" : ""}\\frac{1}{${ad}}}`;
  let F;
  if (term.t === "pow") {
    const { p, q } = term;
    if (p === -q) F = `\\ln|${argLatex(term)}|`;
    else {
      const [P, Q] = ratio(p + q, q);
      const E = Q === 1 ? `${P}` : `${P < 0 ? "-" : ""}\\frac{${Math.abs(P)}}{${Q}}`;
      F = `\\frac{${powerLatex(P, Q, term)}}{${E}}`;
    }
  } else {
    F = term.t === "sin" || term.t === "csc2" ? `\\left(-${tableIntegralLatex(term)}\\right)` : tableIntegralLatex(term);
  }
  return `${lead}${overA}\\cdot ${F}`;
}

const sumLatex = (terms, fmt) => terms.map((t, i) => fmt(t, i === 0)).join("");
const sumIntegrand = (terms, fmt) => (terms.length > 1 ? `\\left(${sumLatex(terms, fmt)}\\right)` : sumLatex(terms, fmt));

const basicProblemLatex = (p) => `\\int ${p.shown}\\,dx`;
const basicAntiderivativeLatex = (p) => sumLatex(p.terms, integratedTermLatex) + "+C";

// Worked solution: the exercise, any rewriting (simplify, then powers),
// in room 2 the formula F(ax+b)/a written out, and the integral.
function basicSolutionLatex(p) {
  const lines = (p.steps || []).map((s) => `\\int ${s}\\,dx`);
  const asPowers = `\\int ${sumIntegrand(p.terms, powerTermLatex)}\\,dx`;
  if (asPowers !== basicProblemLatex(p) && !lines.includes(asPowers)) lines.push(asPowers);
  if (p.terms.some((t) => t.u)) lines.push(sumLatex(p.terms, formulaTermLatex));
  lines.push(basicAntiderivativeLatex(p));
  return `\\begin{aligned}${basicProblemLatex(p)} &= ${lines.join(" \\\\ &= ")}\\end{aligned}`;
}

function basicProblem(terms, extra = {}) {
  return { kind: "basic", shown: sumIntegrand(terms, shownTermLatex), terms, ...extra };
}

// --- generators ---------------------------------------------------------------

// A coefficient for c x^(p/q) that, with probability `clean`, the power rule
// divides evenly: a multiple of the new exponent's numerator p + q.
function powCoef(p, q, clean = 0.65, range = 2, loose = 9) {
  const m = Math.abs(p + q);
  if (m > 1 && chance(clean)) return m * nonZero(-range, range);
  return nonZero(-loose, loose);
}

const ROOT_POWERS = [[1, 2], [1, 3], [2, 3], [3, 4], [2, 5], [3, 5]];
const ROOT_POWERS_NEG = [[-1, 2], [-1, 2], [-1, 3], [-2, 3]];

// 1. Polynomial: a x^n + b x + c.
function genBasicPoly() {
  const n = randInt(2, 5);
  return basicProblem([pow(powCoef(n, 1, 0.65, 2), n), pow(nonZero(-9, 9), 1), pow(nonZero(-9, 9), 0)]);
}

// 2. Negative powers: a/x^n (+ b/x^m), n, m in 2..4.
function genBasicNegative() {
  const ns = shuffled([2, 3, 4]).slice(0, chance(0.6) ? 2 : 1);
  return basicProblem(ns.map((n) => pow(powCoef(-n, 1, 0.6, 3), -n)));
}

// 3. Roots: a root of a power of x, and one in a denominator.
function genBasicRoots() {
  const [p1, q1] = pick(ROOT_POWERS);
  const [p2, q2] = pick(ROOT_POWERS_NEG);
  return basicProblem([pow(powCoef(p1, q1, 0.7, 2, 6), p1, q1), pow(powCoef(p2, q2, 0.6, 3, 6), p2, q2)]);
}

// 4. 1/x next to 1/x^n (and sometimes a constant), in a shuffled order.
function genBasicLn() {
  const n = randInt(2, 3);
  const terms = [pow(nonZero(-9, 9), -1), pow(powCoef(-n, 1, 0.6, 3), -n)];
  if (chance(0.4)) terms.push(pow(nonZero(-9, 9), 0));
  return basicProblem(shuffled(terms));
}

// 5. The function table: three of e^x, sin, cos, 1/cos^2, 1/(1+x^2), always
// with sin or cos and with 1/cos^2 or 1/(1+x^2).
function genBasicTable() {
  const a = pick(["sin", "cos"]);
  const b = pick(["sec2", "atan"]);
  const c = pick(["exp", "sin", "cos", "sec2", "atan"].filter((t) => t !== a && t !== b));
  return basicProblem(shuffled([a, b, c]).map((t) => ({ t, c: nonZero(-6, 6) })));
}

// 6. Boss: simplify first, then integrate - one of three templates.
function genBasicBoss() {
  return pick([bossDivide, bossSquare, bossProduct])();
}

// (a) A polynomial over x^k: split into powers, one of them 1/x.
function bossDivide() {
  const k = randInt(1, 2);
  const powers = k === 2 ? [randInt(3, 4), 1, 0] : chance(0.5) ? [randInt(2, 3), 1, 0] : [randInt(2, 3), 0];
  const N = [];
  powers.forEach((j, i) => {
    N[j] = i === 0 ? powCoef(j - k, 1, 0.6, 2, 6) : nonZero(-6, 6);
  });
  for (let j = 0; j < N.length; j++) N[j] = N[j] || 0;
  const terms = powers.map((j) => pow(N[j], j - k));
  const split = powers.map((j, i) => `${signLatex(N[j], i === 0)}\\frac{${j === 0 ? Math.abs(N[j]) : absCoef(N[j]) + xPower(j)}}{${xPower(k)}}`).join("");
  return {
    kind: "basic",
    shown: `\\frac{${polyLatex(N)}}{${xPower(k)}}`,
    terms,
    steps: [`\\left(${split}\\right)`],
    boss: { type: "divide", N, k },
  };
}

// (b) (sqrt x + b)^2 over x or over sqrt x: expand, then split.
function bossSquare() {
  const b = nonZero(-3, 3);
  const overRoot = chance(0.5);
  // (sqrt x + b)^2 = x + 2b sqrt x + b^2
  const terms = overRoot
    ? [pow(1, 1, 2), pow(2 * b, 0), pow(b * b, -1, 2)]
    : [pow(1, 0), pow(2 * b, -1, 2), pow(b * b, -1)];
  const den = overRoot ? "\\sqrt{x}" : "x";
  const expanded = `x${signLatex(b, false)}${Math.abs(2 * b)}\\sqrt{x}+${b * b}`;
  return {
    kind: "basic",
    shown: `\\frac{\\left(\\sqrt{x}${fmtSigned(b, false)}\\right)^2}{${den}}`,
    terms,
    steps: [`\\frac{${expanded}}{${den}}`],
    boss: { type: "square", b, overRoot },
  };
}

// (c) Products of powers: c x^a * root, and d / (x * root).
function bossProduct() {
  const roots = [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4]];
  const a = randInt(1, 2);
  const [m1, n1] = pick(roots);
  const [m2, n2] = pick(roots);
  const c1 = nonZero(-5, 5);
  const c2 = m2 * nonZero(-3, 3); // so its integral's coefficient comes out whole
  const [p1, q1] = ratio(a * n1 + m1, n1);
  const [p2, q2] = ratio(-(n2 + m2), n2);
  const terms = [pow(c1, p1, q1), pow(c2, p2, q2)];
  const shown =
    `\\left(${signLatex(c1, true)}${absCoef(c1)}${xPower(a)}${rootLatex(m1, n1)}` +
    `${signLatex(c2, false)}\\frac{${Math.abs(c2)}}{x${rootLatex(m2, n2)}}\\right)`;
  const step =
    `\\left(${signLatex(c1, true)}${absCoef(c1)}x^{${a}+\\frac{${m1}}{${n1}}}` +
    `${signLatex(c2, false)}${absCoef(c2)}x^{-1-\\frac{${m2}}{${n2}}}\\right)`;
  return { kind: "basic", shown, terms, steps: [step], boss: { type: "product", a, m1, n1, m2, n2 } };
}

// --- room 2: f(ax+b) ----------------------------------------------------------

// Arguments: a positive a (3x-2), a negative a (5-x, 1-2x; a = -1 often),
// a fraction (x/2, x/3), or a x alone (4x).
// No common factor: 2x+1, not 4x+2.
function coprimeArg(drawA, drawB) {
  for (;;) {
    const a = drawA();
    const b = drawB();
    if (gcd(a, b) === 1) return [a, 1, b];
  }
}
const posArg = () => coprimeArg(() => randInt(2, 5), () => nonZero(-5, 5));
const negArg = () => coprimeArg(() => (chance(0.5) ? -1 : -randInt(2, 3)), () => randInt(1, 6));
const fracArg = () => [1, randInt(2, 3), 0];
const scaledArg = (max = 5) => [randInt(2, max), 1, 0];

// A coefficient that, with probability `clean`, makes the answer's
// coefficient whole: a multiple of `div` (when that is small).
function linCoef(div, clean = 0.55) {
  div = Math.abs(div);
  if (div > 1 && div <= 12 && chance(clean)) return div * pick([1, -1]);
  return nonZero(-6, 6);
}

const withArg = (t, u) => ({ ...t, u });

// Draw until the terms leave room to sample (see linFits).
function linProblem(makeTerms) {
  for (;;) {
    const p = basicProblem(makeTerms());
    if (linFits(p)) return p;
  }
}

// 1. Powers of ax+b: c (ax+b)^n and c / (ax+b)^m.
function genLinPow() {
  return linProblem(() => {
    const n = randInt(2, 5);
    const m = randInt(2, 3);
    const u1 = posArg();
    const u2 = chance(0.5) ? posArg() : negArg();
    return [
      withArg(pow(linCoef(u1[0] * (n + 1)), n), u1),
      withArg(pow(linCoef(u2[0] * (m - 1)), -m), u2),
    ];
  });
}

// 2. Roots of ax+b: one over a positive a, one in a denominator over a
// negative a (5 - x).
function genLinRoot() {
  return linProblem(() => {
    const [p1, q1] = pick([[1, 2], [1, 2], [1, 3], [2, 3]]);
    const [p2, q2] = pick([[-1, 2], [-1, 2], [-1, 3]]);
    const u1 = posArg();
    const u2 = negArg();
    return [
      withArg(pow(linCoef(u1[0] * (p1 + q1)), p1, q1), u1),
      withArg(pow(linCoef(u2[0] * (p2 + q2)), p2, q2), u2),
    ];
  });
}

// 3. e^(ax+b) and c/(ax+b), in a shuffled order.
function genLinExpLn() {
  return linProblem(() => {
    const u1 = chance(0.5) ? posArg() : negArg();
    const u2 = chance(0.5) ? posArg() : negArg();
    return shuffled([withArg({ t: "exp", c: linCoef(u1[0]) }, u1), withArg(pow(linCoef(u2[0]), -1), u2)]);
  });
}

// 4. Trig: sin, cos and 1/cos^2, one of them of x/n, the others of a x
// (sin/cos sometimes of b - a x). 1/cos^2(a x) keeps x near 0, where
// sin(x/n) would be too small to check - so x/n then goes to cos.
function genLinTrig() {
  return linProblem(() => {
    const secFrac = chance(0.4);
    const [f1, f2] = secFrac ? shuffled(["sin", "cos"]) : ["sin", "cos"];
    const u1 = chance(0.7) ? scaledArg() : negArg();
    const u2 = secFrac ? (chance(0.7) ? scaledArg() : negArg()) : fracArg();
    const u3 = secFrac ? fracArg() : scaledArg(3);
    return shuffled([
      withArg({ t: f1, c: linCoef(u1[0]) }, u1),
      withArg({ t: f2, c: linCoef(u2[0]) }, u2),
      withArg({ t: "sec2", c: nonZero(-5, 5) }, u3),
    ]);
  });
}

// Boss: 1/(1+(ax)^2) and two of e^(x/n), c/(b-ax), c/(b-ax)^2, sqrt(ax+b).
function genLinBoss() {
  return linProblem(() => {
    const ua = scaledArg(3);
    const others = shuffled([
      () => withArg({ t: "exp", c: nonZero(-4, 4) }, fracArg()),
      () => { const u = negArg(); return withArg(pow(linCoef(u[0]), -1), u); },
      () => { const u = negArg(); return withArg(pow(linCoef(u[0]), -2), u); },
      () => { const u = posArg(); return withArg(pow(linCoef(u[0] * 3), 1, 2), u); },
    ]).slice(0, 2);
    return shuffled([withArg({ t: "atan", c: linCoef(ua[0]) }, ua), ...others.map((f) => f())]);
  });
}

// --- extension room: a^x, 1/sin^2, arcsin -------------------------------------

const AXP_BASES = [2, 3, 5, 10];
const axp = (c, b) => ({ t: "axp", c, b });

// 1. e^x next to a^x (sometimes two bases).
function genExtAx() {
  return linProblem(() => {
    const [b1, b2] = shuffled(AXP_BASES);
    const terms = [{ t: "exp", c: nonZero(-6, 6) }, axp(nonZero(-6, 6), b1)];
    if (chance(0.4)) terms.push(axp(nonZero(-6, 6), b2));
    return shuffled(terms);
  });
}

// 2. 1/sin^2 next to 1/cos^2 (sometimes with sin or cos).
function genExtCot() {
  return linProblem(() => {
    const terms = [{ t: "csc2", c: nonZero(-6, 6) }, { t: "sec2", c: nonZero(-6, 6) }];
    if (chance(0.4)) terms.push({ t: pick(["sin", "cos"]), c: nonZero(-6, 6) });
    return shuffled(terms);
  });
}

// 3. 1/sqrt(1-x^2) next to 1/(1+x^2): arcsin or arctan.
function genExtAsin() {
  return linProblem(() => shuffled([{ t: "asin", c: nonZero(-6, 6) }, { t: "atan", c: nonZero(-6, 6) }]));
}

// 4. Linear change on the new functions: two of b^(ax+c), 1/sin^2(ax),
// 1/sqrt(1-(ax)^2) - only the (ax) form, as in room 2.
function genExtLin() {
  return linProblem(() => {
    const makers = shuffled([
      () => { const u = chance(0.5) ? posArg() : negArg(); return withArg(axp(linCoef(u[0]), pick([2, 3, 5])), u); },
      () => { const u = chance(0.7) ? scaledArg(3) : fracArg(); return withArg({ t: "csc2", c: linCoef(u[0]) }, u); },
      () => { const u = scaledArg(3); return withArg({ t: "asin", c: linCoef(u[0]) }, u); },
    ]).slice(0, 2);
    return makers.map((f) => f());
  });
}

// 5. Boss: simplify first - a trig identity, or a quotient of powers.
function genExtBoss() {
  return pick([extBossTan, extBossCot, extBossSinCos, extBossRatio])();
}

const coefTimes = (c, body) => `${c < 0 ? "-" : ""}${Math.abs(c) === 1 ? "" : Math.abs(c)}${body}`;

// c tan^2 x = c (1/cos^2 x - 1)
function extBossTan() {
  const c = nonZero(-5, 5);
  return {
    kind: "basic",
    shown: coefTimes(c, "\\tan^2x"),
    terms: [{ t: "sec2", c }, pow(-c, 0)],
    steps: [coefTimes(c, "\\left(\\frac{1}{\\cos^2 x}-1\\right)")],
    boss: { type: "tan2", c },
  };
}

// c cot^2 x = c (1/sin^2 x - 1)
function extBossCot() {
  const c = nonZero(-5, 5);
  return {
    kind: "basic",
    shown: coefTimes(c, "\\cot^2x"),
    terms: [{ t: "csc2", c }, pow(-c, 0)],
    steps: [coefTimes(c, "\\left(\\frac{1}{\\sin^2 x}-1\\right)")],
    boss: { type: "cot2", c },
  };
}

// c / (sin^2 x cos^2 x) = c (sin^2 x + cos^2 x) / (sin^2 x cos^2 x)
//                       = c / cos^2 x + c / sin^2 x
function extBossSinCos() {
  const c = nonZero(-5, 5);
  const sign = c < 0 ? "-" : "";
  const k = Math.abs(c) === 1 ? "" : Math.abs(c);
  return {
    kind: "basic",
    shown: `${sign}\\frac{${Math.abs(c)}}{\\sin^2x\\cos^2x}`,
    terms: [{ t: "sec2", c }, { t: "csc2", c }],
    steps: [`${sign}${k ? `${k}\\cdot` : ""}\\frac{\\sin^2x+\\cos^2x}{\\sin^2x\\cos^2x}`],
    boss: { type: "sincos", c },
  };
}

// ((k d)^x + m d^x) / d^x = k^x + m
function extBossRatio() {
  for (;;) {
    const d = pick([2, 3, 5]);
    const k = pick([2, 3, 5].filter((v) => v * d <= 15));
    const m = nonZero(-6, 6);
    const terms = [axp(1, k), pow(m, 0)];
    const p = {
      kind: "basic",
      shown: `\\frac{${k * d}^x${signLatex(m, false)}${Math.abs(m) === 1 ? "" : `${Math.abs(m)}\\cdot `}${d}^x}{${d}^x}`,
      terms,
      steps: [
        `\\left(\\frac{${k * d}^x}{${d}^x}${signLatex(m, false)}\\frac{${Math.abs(m) === 1 ? "" : `${Math.abs(m)}\\cdot `}${d}^x}{${d}^x}\\right)`,
        `\\left(\\left(\\frac{${k * d}}{${d}}\\right)^x${fmtSigned(m, false)}\\right)`,
      ],
      boss: { type: "ratio", k, d, m },
    };
    if (linFits(p)) return p;
  }
}

// --- common slips -------------------------------------------------------------

const numDeriv = (F) => (x) => (F(x + 1e-5) - F(x - 1e-5)) / 2e-5;

// The antiderivative of a polynomial (coefficients lowest first).
const polyIntegralEval = (N, x) => N.reduce((s, c, j) => s + (c * x ** (j + 1)) / (j + 1), 0);

// Each slip as the problem the slipped answer would be correct for.
function basicNearMissVariants(p) {
  const variants = [];
  const replace = (i, t) => ({ ...p, terms: p.terms.map((u, j) => (j === i ? t : u)).filter(Boolean) });
  const boss = p.boss;

  // Integrating the numerator and the denominator separately.
  if (boss && boss.type === "divide") {
    const F = (x) => polyIntegralEval(boss.N, x) / (x ** (boss.k + 1) / (boss.k + 1));
    variants.push({ kind: "split", problem: { ...p, fn: numDeriv(F) } });
  }
  if (boss && boss.type === "square") {
    const { b, overRoot } = boss;
    const F = (x) =>
      (x * x / 2 + (4 * b / 3) * x ** 1.5 + b * b * x) / (overRoot ? (2 / 3) * x ** 1.5 : (x * x) / 2);
    variants.push({ kind: "split", problem: { ...p, fn: numDeriv(F) } });
    variants.push({ kind: "squareExpand", problem: replace(1, null) }); // (sqrt x + b)^2 as x + b^2
  }
  // Extension boss: the power rule on tan^2 / cot^2, or the identity's sign.
  if (boss && (boss.type === "tan2" || boss.type === "cot2")) {
    const c = boss.c;
    const tr = boss.type === "tan2" ? Math.tan : (x) => 1 / Math.tan(x);
    variants.push({ kind: "trigPow", problem: { ...p, fn: numDeriv((x) => (c * tr(x) ** 3) / 3) } });
    variants.push({ kind: "trigIdentity", problem: replace(1, pow(c, 0)) });
  }
  if (boss && boss.type === "product") {
    const { a, m1, n1, m2, n2 } = boss;
    // x^a * x^(m/n) taken as x^(a*m/n); 1/(x * x^(m/n)) as x^(-m/n)
    const [p1, q1] = ratio(a * m1, n1);
    variants.push({ kind: "expAdd", problem: replace(0, pow(p.terms[0].c, p1, q1)) });
    variants.push({ kind: "expAdd", problem: replace(1, pow(p.terms[1].c, -m2, n2)) });
  }

  // Room 2: the division by a. Each slip as the coefficient the slipped
  // answer's derivative would carry: c a (not divided), c a^2 (multiplied),
  // -c (divided by |a|, the sign lost).
  p.terms.forEach((t, i) => {
    const a = linA(t);
    if (a === 1) return;
    if (a < 0) variants.push({ kind: "linSign", problem: replace(i, { ...t, c: -t.c }) });
    if (a !== -1) variants.push({ kind: "linForgot", problem: replace(i, { ...t, c: t.c * a }) });
    if (a * a !== 1) variants.push({ kind: t.u[1] > 1 ? "linFrac" : "linMult", problem: replace(i, { ...t, c: t.c * a * a }) });
    if (t.t === "atan") {
      // 1/(1+4x^2) taken as 1/(1+x^2): c arctan x, or (c/a) arctan x
      const { u, ...plain } = t;
      variants.push({ kind: "atanArg", problem: replace(i, plain) });
      variants.push({ kind: "atanArg", problem: replace(i, { ...plain, c: t.c / a }) });
    }
  });

  p.terms.forEach((t, i) => {
    if (t.t === "pow") {
      const e = t.p / t.q;
      if (e === -1) return;
      if (e === 0) {
        variants.push({ kind: "constX", problem: replace(i, null) });
        return;
      }
      const at = (c, num, den) => ({ ...t, c, p: num, q: den });
      variants.push({ kind: "powCoef", problem: replace(i, { ...t, c: (t.c * (e + 1)) / e }) }); // divided by n, not n+1
      if ((e + 1) ** 2 !== 1) variants.push({ kind: "powCoef", problem: replace(i, { ...t, c: t.c * (e + 1) ** 2 }) }); // multiplied
      if (e < 0) {
        variants.push({ kind: "powLn", problem: replace(i, { ...t, p: -1, q: 1 }) }); // c ln|x|
        const [P, Q] = ratio(t.p - 2 * t.q, t.q); // exponent went down: c x^(e-1)/(e-1)
        variants.push({ kind: "powExp", problem: replace(i, at(t.c, P, Q)) });
      }
      if (t.q > 1) {
        const [P, Q] = ratio(Math.sign(t.p) * t.q, Math.abs(t.p)); // root read upside down
        variants.push({ kind: "rootConv", problem: replace(i, at(t.c, P, Q)) });
      }
    }
    if (t.t === "sin" || t.t === "cos") variants.push({ kind: "trigSign", problem: replace(i, { ...t, c: -t.c }) });
    if (t.t === "sec2") {
      variants.push({ kind: "tanSign", problem: replace(i, { ...t, c: -t.c }) });
      variants.push({ kind: "tanAtan", problem: replace(i, { ...t, t: "atan" }) });
    }
    if (t.t === "atan") {
      variants.push({ kind: "atanLn", problem: replace(i, { ...t, t: "lnq" }) });
      variants.push({ kind: "tanAtan", problem: replace(i, { ...t, t: "sec2" }) });
      variants.push({ kind: "asinAtan", problem: replace(i, { ...t, t: "asin" }) });
    }
    if (t.t === "asin") {
      variants.push({ kind: "asinAtan", problem: replace(i, { ...t, t: "atan" }) });
      if (t.u) {
        // 1/sqrt(1-4x^2) taken as 1/sqrt(1-x^2): c arcsin x, or (c/a) arcsin x
        const { u, ...plain } = t;
        variants.push({ kind: "asinArg", problem: replace(i, plain) });
        variants.push({ kind: "asinArg", problem: replace(i, { ...plain, c: t.c / linA(t) }) });
      }
    }
    if (t.t === "csc2") {
      variants.push({ kind: "cotSign", problem: replace(i, { ...t, c: -t.c }) });
      variants.push({ kind: "cotTan", problem: replace(i, { ...t, t: "sec2" }) });
      variants.push({ kind: "cotTan", problem: replace(i, { ...t, t: "sec2", c: -t.c }) });
    }
    if (t.t === "axp") {
      const L = Math.log(t.b);
      variants.push({ kind: "expLn", problem: replace(i, { ...t, c: t.c * L }) }); // without ln b
      variants.push({ kind: "expLn", problem: replace(i, { ...t, c: t.c * L * L }) }); // times ln b
      // the power rule: b^(u+1)/(u+1), differentiated in u
      const f = (v) => (t.b ** (v + 1) * (L * (v + 1) - 1)) / (v + 1) ** 2;
      variants.push({ kind: "expPow", problem: replace(i, { t: "custom", c: t.c, f, u: t.u }) });
    }
  });
  // Both sin and cos with the wrong sign.
  if (p.terms.filter((t) => t.t === "sin" || t.t === "cos").length > 1) {
    variants.push({ kind: "trigSign", problem: { ...p, terms: p.terms.map((t) => (t.t === "sin" || t.t === "cos" ? { ...t, c: -t.c } : t)) } });
  }
  // ln b left out of every b^x.
  if (p.terms.filter((t) => t.t === "axp").length > 1) {
    variants.push({ kind: "expLn", problem: { ...p, terms: p.terms.map((t) => (t.t === "axp" ? { ...t, c: t.c * Math.log(t.b) } : t)) } });
  }
  p.terms.forEach((t, i) => {
    if (!["sin", "cos", "sec2", "csc2"].includes(t.t)) variants.push({ kind: "sign", problem: replace(i, { ...t, c: -t.c }) });
  });
  return variants;
}

Object.assign(GENERATORS, {
  basicPoly: genBasicPoly,
  basicNegative: genBasicNegative,
  basicRoots: genBasicRoots,
  basicLn: genBasicLn,
  basicTable: genBasicTable,
  basicBoss: genBasicBoss,
  linPow: genLinPow,
  linRoot: genLinRoot,
  linExpLn: genLinExpLn,
  linTrig: genLinTrig,
  linBoss: genLinBoss,
  extAx: genExtAx,
  extCot: genExtCot,
  extAsin: genExtAsin,
  extLin: genExtLin,
  extBoss: genExtBoss,
});

Object.assign(NEAR_MISS_TEXT, {
  powCoef: `כמעט! בדקו את המקדם: ${ltr("∫xⁿdx = xⁿ⁺¹/(n+1)")} - מחלקים בחזקה החדשה.`,
  powExp: `כמעט! בדקו את החזקה: באינטגרל החזקה עולה ב-1, גם כשהיא שלילית (${ltr("x⁻³ → x⁻²")}).`,
  powLn: `כמעט! ${ltr("ln")} מתקבל רק מ-${ltr("1/x")}. לחזקה אחרת של ${ltr("x")} משתמשים בכלל החזקה.`,
  constX: `כמעט! האינטגרל של קבוע ${ltr("k")} הוא ${ltr("kx")}.`,
  rootConv: `כמעט! בדקו את המעבר משורש לחזקה: ${ltr("ⁿ√xᵐ = x^(m/n)")}.`,
  trigSign: `כמעט! בדקו סימנים: ${ltr("∫sin x dx = −cos x")} ו-${ltr("∫cos x dx = sin x")}.`,
  tanSign: `כמעט! ${ltr("∫dx/cos²x = tan x")}, בלי מינוס.`,
  tanAtan: `כמעט! נראה ש-${ltr("tan")} ו-${ltr("arctan")} התחלפו.`,
  atanLn: `כמעט! ${ltr("∫dx/(1+x²) = arctan x")}, לא ${ltr("ln")}.`,
  split: "לא מבצעים אינטגרל למונה ולמכנה בנפרד. קודם מפשטים לסכום של חזקות.",
  squareExpand: `כמעט! בפתיחת הסוגריים חסר האיבר האמצעי: ${ltr("(a+b)² = a²+2ab+b²")}.`,
  expAdd: `כמעט! בכפל חזקות מחברים את המעריכים: ${ltr("xᵃ·xᵇ = xᵃ⁺ᵇ")}.`,
  linForgot: `כמעט! חסרה החלוקה ב-${ltr("a")}: ${ltr("∫f(ax+b)dx = F(ax+b)/a")}.`,
  linMult: `כמעט! מחלקים ב-${ltr("a")}, לא כופלים: ${ltr("∫f(ax+b)dx = F(ax+b)/a")}.`,
  linSign: `כמעט! בדקו את הסימן: כאן ${ltr("a")} שלילי, ומחלקים בו עם הסימן.`,
  linFrac: `כמעט! חלוקה ב-${ltr("1/n")} היא כפל ב-${ltr("n")}.`,
  atanArg: `כמעט! ${ltr("1+a²x² = 1+(ax)²")}, ולכן בתוך ה-${ltr("arctan")} צריך ${ltr("ax")}.`,
  expLn: `כמעט! ${ltr("∫aˣdx = aˣ/ln a")} - מחלקים ב-${ltr("ln a")}.`,
  expPow: `כמעט! ${ltr("aˣ")} היא לא חזקה של ${ltr("x")}, ולכן כלל החזקה לא עובד: ${ltr("∫aˣdx = aˣ/ln a")}.`,
  cotSign: `כמעט! ${ltr("∫dx/sin²x = −cot x")} - עם מינוס.`,
  cotTan: `כמעט! ${ltr("∫dx/sin²x = −cot x")}, לא ${ltr("tan")}.`,
  asinAtan: `כמעט! נראה ש-${ltr("arcsin")} ו-${ltr("arctan")} התחלפו: ${ltr("∫dx/√(1−x²) = arcsin x")}, ${ltr("∫dx/(1+x²) = arctan x")}.`,
  asinArg: `כמעט! ${ltr("1−a²x² = 1−(ax)²")}, ולכן בתוך ה-${ltr("arcsin")} צריך ${ltr("ax")}.`,
  trigPow: `כמעט! כלל החזקה עובד רק על חזקה של ${ltr("x")}, לא על ${ltr("tan²x")} או ${ltr("cot²x")}.`,
  trigIdentity: `כמעט! בדקו את הזהות: ${ltr("1+tan²x = 1/cos²x")}, ${ltr("1+cot²x = 1/sin²x")}.`,
});

// ---------------------------------------------------------------------------
// Integration by parts (the parts tower):  ∫u dv = uv − ∫v du
//
// Room 1, a polynomial times e^(ax+b), sin(ax) or cos(ax):
//   { kind: "parts", fam: "poly", P: [p0, p1, p2], g: "exp" | "sin" | "cos", a, b }
// u is the polynomial; applying the rule again and again gives
//   ∫P g dx = Σ_j (−1)^j P^(j) G_(j+1),   G_1 = ∫g, G_(j+1) = ∫G_j.
// Room 2, a power of x times ln x or ln² x:
//   { kind: "parts", fam: "ln", c, r: [P, Q], k: 1 | 2 }    c x^(P/Q) ln^k x
// u is ln^k x; with s = r + 1,
//   ∫c x^r ln^k x dx = c x^s Σ_i (−1)^i k!/(k−i)! ln^(k−i) x / s^(i+1).
// A slip is the same sum with a sign or a division changed. The answer is
// kept as a list of terms: { c: [num, den], Q, fn } (room 1, c Q(x) G(x)) or
// { c: [num, den], lnPow } (room 2, c x^s ln^lnPow x).
// ---------------------------------------------------------------------------

const ratMul = ([a, b], [c, d]) => ratio(a * c, b * d);
const polyDeriv = (P) => P.slice(1).map((c, i) => c * (i + 1));
const polyDegree = (P) => trimPoly(P).length - 1;
const polyTermCount = (P) => P.filter((c) => c !== 0).length;
const partsS = (p) => ratio(p.r[0] + p.r[1], p.r[1]); // s = r + 1
const G_FNS = { exp: Math.exp, sin: Math.sin, cos: Math.cos };

// G_1 .. G_n: g integrated again and again. A slip may get the trig signs
// wrong (∫sin = sinTo·cos, ∫cos = cosTo·sin; right: −1, +1) or not divide
// by a at step j (div(j) = 1).
function partsChain(p, n, { sinTo = -1, cosTo = 1, div = () => p.a } = {}) {
  const out = [];
  let fn = p.g;
  let c = [1, 1];
  for (let j = 1; j <= n; j++) {
    c = ratio(c[0], c[1] * div(j));
    if (fn === "sin") {
      c = ratMul(c, [sinTo, 1]);
      fn = "cos";
    } else if (fn === "cos") {
      c = ratMul(c, [cosTo, 1]);
      fn = "sin";
    }
    out.push({ fn, c });
  }
  return out;
}

const altSign = (j) => (j % 2 ? -1 : 1);

// Room 1's answer as terms; `signs` (one per application) may slip.
function partsPolyTerms(p, { signs, ...rules } = {}) {
  const n = polyDegree(p.P) + 1;
  const G = partsChain(p, n, rules);
  const out = [];
  let D = p.P;
  for (let j = 0; j < n; j++) {
    out.push({ c: ratMul(G[j].c, [signs ? signs[j] : altSign(j), 1]), Q: D, fn: G[j].fn });
    D = polyDeriv(D);
  }
  return out;
}

// Room 2's answer as terms. divs[i] = false: that step forgot to divide by s.
function partsLnTerms(p, { signs, divs } = {}) {
  const s = partsS(p);
  const out = [];
  let c = [p.c, 1];
  let f = 1; // k!/(k-i)!
  for (let i = 0; i <= p.k; i++) {
    if (!divs || divs[i]) c = ratMul(c, [s[1], s[0]]);
    out.push({ c: ratMul(c, [(signs ? signs[i] : altSign(i)) * f, 1]), lnPow: p.k - i });
    f *= p.k - i;
  }
  return out;
}

const partsTerms = (p) => (p.fam === "ln" ? partsLnTerms(p) : partsPolyTerms(p));

function partsValue(p, terms, x) {
  if (p.fam === "ln") {
    const [sn, sd] = partsS(p);
    const L = Math.log(x);
    return terms.reduce((acc, t) => acc + (t.c[0] / t.c[1]) * x ** (sn / sd) * L ** t.lnPow, 0);
  }
  const v = p.a * x + p.b;
  return terms.reduce((acc, t) => acc + (t.c[0] / t.c[1]) * polyEval(t.Q, x) * G_FNS[t.fn](v), 0);
}

function partsIntegrandFn(p) {
  if (p.fn) return p.fn;
  if (p.fam === "ln") return (x) => p.c * x ** (p.r[0] / p.r[1]) * Math.log(x) ** p.k;
  return (x) => polyEval(p.P, x) * G_FNS[p.g](p.a * x + p.b);
}

// ln x only for x > 0. e^(ax+b) where |ax+b| <= 4, so no term swamps the
// others within the checker's 1% tolerance.
function partsSampleZones(p) {
  if (p.fam === "ln") return [[0.2, 0.6], [0.7, 1.6], [1.8, 4]];
  let lo = -2.5;
  let hi = 2.5;
  if (p.g === "exp") {
    const e1 = (-4 - p.b) / p.a;
    const e2 = (4 - p.b) / p.a;
    lo = Math.max(lo, Math.min(e1, e2));
    hi = Math.min(hi, Math.max(e1, e2));
  }
  const w = (hi - lo) / 4;
  return [0, 1, 2, 3].map((i) => [lo + i * w, lo + (i + 1) * w]);
}

// --- LaTeX ---

// g with its argument: "e^{2x+1}", "\sin 3x", "\cos x".
const gLatex = (fn, p) => {
  const t = { u: [p.a, 1, p.b] };
  return fn === "exp" ? `e^{${argLatex(t)}}` : `\\${fn}${fnArgLatex(t)}`;
};

// A polynomial as a factor: "x^2", "3x", "\left(2x-1\right)".
const polyFactorLatex = (Q) => (polyTermCount(Q) > 1 ? `\\left(${polyLatex(Q)}\\right)` : polyLatex(Q));

// (num/den) Q(x) body: a one-term Q goes into the coefficient
// ("\frac{3}{2}x^2e^{2x}"); a longer one into brackets, its whole common
// factor and leading sign pulled out ("-\frac{1}{2}\left(2x-3\right)\cos x").
function partsTermLatex([num, den], Q, body, isFirst) {
  Q = trimPoly(Q);
  if (polyTermCount(Q) === 1) {
    const k = Q.length - 1;
    const [n, d] = ratio(num * Q[k], den);
    return coefLatex(n, d, xPower(k) + body, isFirst);
  }
  const g = Q.reduce((acc, c) => gcd(acc, c), 0) * Math.sign(Q[Q.length - 1]);
  const [n, d] = ratio(num * g, den);
  return coefLatex(n, d, `\\left(${polyLatex(Q.map((c) => c / g))}\\right)${body}`, isFirst);
}

const lnPowLatex = (k) => (k === 0 ? "" : k === 1 ? "\\ln x" : `\\ln^${k}x`);

// (num/den) x^(P/Q) ln^k x: roots, and negative powers under a fraction bar
// ("-\frac{\ln x}{x}").
function lnTermLatex([num, den], [P, Q], k, isFirst) {
  const ln = lnPowLatex(k);
  if (P === 0) return coefLatex(num, den, ln, isFirst);
  if (P > 0) return coefLatex(num, den, (Q === 2 && P === 1 ? "\\sqrt{x}" : powerLatex(P, Q)) + ln, isFirst);
  const under = Q === 1 ? xPower(-P) : -P < Q ? rootLatex(-P, Q) : powerLatex(-P, Q);
  const top = Math.abs(num) === 1 && ln ? ln : `${Math.abs(num)}${ln}`;
  return `${signLatex(num, isFirst)}\\frac{${top}}{${den === 1 ? "" : den}${under}}`;
}

// x^(P/Q), P/Q > 0, as an exam writes it: "x^2", "\sqrt{x}", "x\sqrt{x}".
function shownPowLatex(P, Q) {
  if (Q === 1) return xPower(P);
  return xPower(Math.floor(P / Q)) + rootLatex(P % Q, Q);
}

function partsProblemLatex(p) {
  if (p.fam === "poly") return `\\int ${polyFactorLatex(p.P)}${gLatex(p.g, p)}\\,dx`;
  const [P, Q] = p.r;
  const ln = lnPowLatex(p.k);
  if (P >= 0) return `\\int ${coefLatex(p.c, 1, shownPowLatex(P, Q) + ln, true)}\\,dx`;
  const under = Q === 1 ? xPower(-P) : -P < Q ? rootLatex(-P, Q) : xPower(Math.floor(-P / Q)) + rootLatex(-P % Q, Q);
  return `\\int ${p.c < 0 ? "-" : ""}\\frac{${Math.abs(p.c) === 1 ? "" : Math.abs(p.c)}${ln}}{${under}}\\,dx`;
}

const partsSumLatex = (p, terms) =>
  terms
    .map((t, i) => (p.fam === "ln" ? lnTermLatex(t.c, partsS(p), t.lnPow, i === 0) : partsTermLatex(t.c, t.Q, gLatex(t.fn, p), i === 0)))
    .join("");

const partsAntiderivativeLatex = (p) => partsSumLatex(p, partsTerms(p)) + "+C";

// A factor after "\cdot": bracketed when it starts with a minus.
const cdotFactor = (s) => (s.startsWith("-") ? `\\left(${s}\\right)` : s);
const partsUdvLine = (u, dv, du, v) => `&u=${u},\\qquad v^\\prime=${dv} \\\\ &u^\\prime=${du},\\qquad v=${v}`;

// Worked solution: the choice of u and v′ (u′, v), uv − ∫u′v, a second
// application where needed, and the result.
function partsSolutionLatex(p) {
  const lines = [];
  const first = problemLatex(p);
  if (p.fam === "poly") {
    const [G1, G2] = partsChain(p, 2);
    const v1 = partsTermLatex(G1.c, [1], gLatex(G1.fn, p), true);
    const v2 = partsTermLatex(G2.c, [1], gLatex(G2.fn, p), true);
    const D1 = polyDeriv(p.P);
    const D2 = polyDeriv(D1);
    lines.push(partsUdvLine(polyLatex(p.P), gLatex(p.g, p), polyFactorLatex(D1), v1));
    const uv = `${polyFactorLatex(p.P)}\\cdot ${cdotFactor(v1)}`;
    const vdu1 = `${cdotFactor(polyFactorLatex(D1))}\\cdot ${cdotFactor(v1)}`;
    lines.push(`${first} &= ${uv}-\\int ${vdu1}\\,dx`);
    if (D2.length) {
      lines.push(partsUdvLine(polyLatex(D1), v1, polyFactorLatex(D2), v2));
      lines.push(`&= ${uv}-\\left(${polyFactorLatex(D1)}\\cdot ${cdotFactor(v2)}-\\int ${cdotFactor(polyFactorLatex(D2))}\\cdot ${cdotFactor(v2)}\\,dx\\right)`);
    }
  } else {
    const s = partsS(p);
    const r = p.r;
    const dv = p.c === 1 ? "" : p.c === -1 ? "-" : `${p.c}`;
    const xr = r[0] === 0 ? "" : powerLatex(r[0], r[1]);
    const dvLatex = xr ? `${dv}${xr}` : `${p.c}`;
    const v = ratMul([p.c, 1], [s[1], s[0]]); // v = (c/s) x^s
    const vLatex = lnTermLatex(v, s, 0, true);
    if (p.k === 1) {
      lines.push(partsUdvLine("\\ln x", dvLatex, "\\frac{1}{x}", vLatex));
      lines.push(`${first} &= ${lnTermLatex(v, s, 1, true)}-\\int ${cdotFactor(lnTermLatex(v, r, 0, true))}\\,dx`);
    } else {
      lines.push(partsUdvLine("\\ln^2x", dvLatex, "\\frac{2\\ln x}{x}", vLatex));
      const K = ratMul(v, [2, 1]); // ∫v·(2 ln x / x) dx = K ∫x^r ln x dx
      const inner = `\\int ${r[0] === 0 ? "" : powerLatex(r[0], r[1])}\\ln x\\,dx`;
      lines.push(`${first} &= ${lnTermLatex(v, s, 2, true)}${coefLatex(-K[0], K[1], inner, false)}`);
      const w = [s[1], s[0]]; // second application: v = x^s / s
      lines.push(partsUdvLine("\\ln x", xr || "1", "\\frac{1}{x}", lnTermLatex(w, s, 0, true)));
      lines.push(
        `&= ${lnTermLatex(v, s, 2, true)}${K[1] === 1 && K[0] === 1 ? "-" : coefLatex(-K[0], K[1], "", false)}` +
          `\\left(${lnTermLatex(w, s, 1, true)}-\\int ${lnTermLatex(w, r, 0, true)}\\,dx\\right)`
      );
    }
  }
  lines.push(`&= ${partsAntiderivativeLatex(p)}`);
  return `\\begin{aligned}${lines.join(" \\\\ ")}\\end{aligned}`;
}

// --- slips ---

// Each slip as the problem its answer would be correct for (with the
// slipped antiderivative F, for the tests).
function partsNearMissVariants(p) {
  const out = [];
  const add = (kind, terms) => {
    const F = (x) => partsValue(p, terms, x);
    out.push({ kind, F, problem: { ...p, fn: numDeriv(F) } });
  };
  // the right signs, with those of the steps in `which` flipped
  const flip = (n, which) => Array.from({ length: n }, (_, j) => (which(j) ? -1 : 1) * altSign(j));
  if (p.fam === "poly") {
    const n = polyDegree(p.P) + 1;
    add("partsSign", partsPolyTerms(p, { signs: flip(n, (j) => j >= 1) })); // uv + ∫v du
    if (n > 2) {
      add("partsSign", partsPolyTerms(p, { signs: flip(n, (j) => j === 1) })); // + both times
      add("partsSecond", partsPolyTerms(p, { signs: flip(n, (j) => j >= 2) })); // −(uv − ∫) as −uv − ∫
    }
    if (p.a !== 1) {
      const kind = p.g === "exp" ? "partsDivExp" : "partsDivTrig";
      add(kind, partsPolyTerms(p, { div: () => 1 })); // never divided by a
      add(kind, partsPolyTerms(p, { div: (j) => (j === 1 ? p.a : 1) })); // only in v
      add(kind, partsPolyTerms(p, { div: (j) => (j === 1 ? 1 : p.a) })); // all but v
    }
    if (p.g !== "exp") {
      for (const [sinTo, cosTo] of [[1, 1], [-1, -1], [1, -1]]) add("trigSign", partsPolyTerms(p, { sinTo, cosTo }));
    }
  } else {
    const n = p.k + 1;
    add("partsSign", partsLnTerms(p, { signs: flip(n, (i) => i >= 1) }));
    if (n > 2) {
      add("partsSign", partsLnTerms(p, { signs: flip(n, (i) => i === 1) }));
      add("partsSecond", partsLnTerms(p, { signs: flip(n, (i) => i >= 2) }));
    }
    if (p.r[0] === 0) add("xlnx", partsLnTerms(p).slice(0, -1)); // ∫ln x dx = x ln x, the −x lost
    const s = partsS(p);
    if (s[0] !== s[1]) {
      add("partsPowV", partsLnTerms(p, { divs: [false, ...Array(p.k).fill(true)] })); // v = c x^s
      add("partsPowV", partsLnTerms(p, { divs: Array(n).fill(false) }));
    }
  }
  return out;
}

// --- generators ---

const partsPoly = (P, g, a, b = 0) => ({ kind: "parts", fam: "poly", P, g, a, b });
const partsLn = (c, r, k = 1) => ({ kind: "parts", fam: "ln", c, r, k });
const expA = () => pick([1, 1, 2, 3, -1, -2, -3]);
const trigK = () => pick([1, 2, 2, 3]);
// m x + n with no common factor, not both negative: "2x-1", "-x+3", "4x".
function linPoly() {
  for (;;) {
    const m = nonZero(-4, 4);
    const n = chance(0.85) ? nonZero(-5, 5) : 0;
    if ((n === 0 || gcd(m, n) === 1) && (m > 0 || n > 0)) return [n, m];
  }
}

// Room 1: 1. (mx+n) e^(ax+b)  2. (mx+n) sin/cos kx  3. x^2 times either
// (twice)  4. boss: a full quadratic times either.
const genPartsLinExp = () => partsPoly(linPoly(), "exp", expA(), chance(0.6) ? 0 : nonZero(-3, 3));
const genPartsLinTrig = () => partsPoly(linPoly(), pick(["sin", "cos"]), trigK());
function genPartsSquare() {
  const g = pick(["exp", "sin", "cos"]);
  return partsPoly([0, 0, pick([1, 1, 1, -1, 2, 3])], g, g === "exp" ? expA() : trigK());
}
function genPartsPolyBoss() {
  const g = pick(["exp", "sin", "cos"]);
  let P;
  do P = [randInt(-5, 5), nonZero(-5, 5), pick([1, 1, 1, -1, 2])];
  while (gcd(gcd(P[0], P[1]), P[2]) !== 1 || (P[2] < 0 && P[0] <= 0));
  return partsPoly(P, g, g === "exp" ? expA() : trigK());
}

// Room 2: 1. ln x  2. x^n ln x  3. x^r ln x, r a fraction or negative
// (√x ln x, ln x / x², ln x / √x ...)  4. boss: ln² x, x ln² x, √x ln² x.
const genPartsLnAlone = () => partsLn(pick([1, 1, 2, 3, 5, -1, -2]), [0, 1]);
function genPartsLnPow() {
  const n = randInt(1, 3);
  return partsLn(pick([1, 1, n + 1, -(n + 1)]), [n, 1]);
}
const genPartsLnRoot = () => partsLn(1, pick([[1, 2], [1, 2], [-2, 1], [-1, 2], [-1, 2], [-3, 1], [3, 2], [1, 3]]));
const genPartsLnBoss = () => partsLn(1, pick([[0, 1], [1, 1], [1, 2]]), 2);

Object.assign(GENERATORS, {
  partsLinExp: genPartsLinExp,
  partsLinTrig: genPartsLinTrig,
  partsSquare: genPartsSquare,
  partsPolyBoss: genPartsPolyBoss,
  partsLnAlone: genPartsLnAlone,
  partsLnPow: genPartsLnPow,
  partsLnRoot: genPartsLnRoot,
  partsLnBoss: genPartsLnBoss,
});

Object.assign(NEAR_MISS_TEXT, {
  partsSign: `כמעט! בדקו את הסימן: ${ltr("∫uv′ = uv − ∫u′v")} - בין ${ltr("uv")} לאינטגרל יש מינוס.`,
  partsSecond: `כמעט! בדקו את הסימן בהפעלה השנייה: המינוס שלפני ${ltr("∫u′v")} חל על כל התוצאה שלו, ${ltr("−(uv − ∫u′v)")}.`,
  partsDivExp: `כמעט! בחישוב ${ltr("v")} מחלקים במקדם של ${ltr("x")}: ${ltr("∫e^(ax)dx = e^(ax)/a")}.`,
  partsDivTrig: `כמעט! בחישוב ${ltr("v")} מחלקים במקדם של ${ltr("x")}: ${ltr("∫cos(ax)dx = sin(ax)/a")}, ${ltr("∫sin(ax)dx = −cos(ax)/a")}.`,
  xlnx: `כמעט! חסר איבר: ${ltr("∫ln x dx = x·ln x − x")}.`,
  partsPowV: `כמעט! בדקו את ${ltr("v")}: ${ltr("∫xⁿdx = xⁿ⁺¹/(n+1)")} - מחלקים בחזקה החדשה.`,
});

// ---------------------------------------------------------------------------
// The tower: floor 1
// ---------------------------------------------------------------------------


const ROOMS = [
  {
    id: "basic",
    place: "ground",
    kind: "core",
    num: 1,
    title: "אינטגרלים מיידיים",
    en: "Basic integrals",
    tag: "טבלת האינטגרלים",
    nodes: [
      { gen: "basicPoly" },
      { gen: "basicNegative" },
      { gen: "basicRoots" },
      { gen: "basicLn" },
      { gen: "basicTable" },
      { gen: "basicBoss", boss: true },
    ],
  },
  {
    id: "linear",
    place: "ground",
    kind: "core",
    num: 2,
    title: "שינוי לינארי",
    en: "f(ax+b)",
    tag: "שיטה: חלוקה ב-a",
    requires: ["basic"],
    nodes: [
      { gen: "linPow" },
      { gen: "linRoot" },
      { gen: "linExpLn" },
      { gen: "linTrig" },
      { gen: "linBoss", boss: true },
    ],
  },
  {
    id: "more",
    place: "ground",
    kind: "ext",
    title: "אינטגרלים נוספים",
    en: "More basic integrals",
    tag: "עוד פונקציות מהטבלה",
    label: "הרחבה",
    stars: 1,
    requires: ["linear"],
    nodes: [
      { gen: "extAx" },
      { gen: "extCot" },
      { gen: "extAsin" },
      { gen: "extLin" },
      { gen: "extBoss", boss: true },
    ],
  },
  {
    id: "division",
    place: "pf",
    kind: "prep",
    title: "חילוק פולינומים",
    en: "Polynomial division",
    tag: "לא חובה",
    label: "מבוא",
    blurb: "חישוב אינטגרל על ידי חילוק פולינומים. יודעים לחלק פולינומים? אפשר לדלג.",
    nodes: [
      { gen: "div1" },
      { gen: "div3", boss: true },
    ],
  },
  {
    id: "repeated",
    place: "pf",
    kind: "core",
    num: 1,
    title: "שורש כפול",
    en: "Repeated root",
    tag: "שיטה: הצבה",
    nodes: [
      { gen: "repFactored" },
      { gen: "repExpanded" },
      { gen: "repDegree2" },
    ],
  },
  {
    id: "pf1",
    place: "pf",
    kind: "core",
    num: 2,
    title: "שני שורשים שונים",
    en: "Partial fractions: distinct roots",
    tag: "שיטה: שברים חלקיים",
    nodes: [
      { gen: "pfFactored" },
      { gen: "pfExpanded" },
      { gen: "pfDivide" },
      { gen: "pfBoss", boss: true },
    ],
  },
  {
    id: "irreducible",
    place: "pf",
    kind: "core",
    num: 3,
    title: "מכנה שלא מתפרק",
    en: "Irreducible quadratic",
    tag: "שיטה: השלמה לריבוע",
    nodes: [
      { gen: "irrPlain" },
      { gen: "irrDegree2" },
      { gen: "irrBoss", boss: true },
    ],
  },
  {
    id: "review",
    place: "pf",
    kind: "review",
    title: "תרגילים מעורבבים",
    en: "Mixed review",
    tag: "חזרה · כל הסוגים, בלי רמז",
    label: "חזרה",
    requires: ["repeated", "pf1", "irreducible"],
    nodes: [
      { gen: "review" },
      { gen: "review" },
      { gen: "review" },
    ],
  },
  {
    id: "nonmonic",
    place: "pf",
    kind: "ext",
    title: "מכנה עם מקדם מוביל",
    en: "Non-monic",
    tag: "טכניקה גבוהה",
    label: "טכניקה גבוהה",
    stars: 2,
    requires: ["repeated", "pf1", "irreducible"],
    nodes: [
      { gen: "nmExpanded" },
      { gen: "nmRepeated" },
      { gen: "nmIrreducible" },
    ],
  },
  {
    id: "partsPoly",
    place: "parts",
    kind: "core",
    num: 1,
    title: "פולינום כפול eˣ / טריגו",
    en: "Polynomial × eˣ, sin, cos",
    tag: "u = הפולינום",
    nodes: [
      { gen: "partsLinExp" },
      { gen: "partsLinTrig" },
      { gen: "partsSquare" },
      { gen: "partsPolyBoss", boss: true },
    ],
  },
  {
    id: "partsLn",
    place: "parts",
    kind: "core",
    num: 2,
    title: "חלקים עם ln",
    en: "Parts with ln x",
    tag: "u = ln",
    requires: ["partsPoly"],
    nodes: [
      { gen: "partsLnAlone" },
      { gen: "partsLnPow" },
      { gen: "partsLnRoot" },
      { gen: "partsLnBoss", boss: true },
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

// Where the map is: the ground floor or one of the towers above it.
// Saves from before the towers kept store.floor (2: partial fractions) and
// a single "stairs".
const PLACES = ["ground", "pf", "parts"];
if (!PLACES.includes(store.place)) store.place = store.floor === 2 ? "pf" : "ground";
delete store.floor;
if (store.lastRoom === "stairs") store.lastRoom = "stairsPf";

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

// The place the map shows: the ground floor (basic integrals) unless the
// student has gone up into a tower (or is in one of its rooms).
const currentPlace = () => (PLACES.includes(store.place) ? store.place : "ground");

// The ground floor and the parts tower are lines of rooms, each opening
// after the one before it; the partial-fractions tower has its own gate.
const isLinearPlace = (place) => place !== "pf";

// The rooms this one builds on that aren't conquered yet.
function missingRequirements(room) {
  return [].concat(room.requires || []).filter((id) => !isConquered(id));
}

const quotedTitles = (ids) => ids.map((id) => `"${ROOM_BY_ID[id].title}"`).join(", ");

// The upper wing (review, non-monic, the topic medal) opens once the three core
// rooms are conquered - or earlier, if the student opens its gate anyway.
const CORE_IDS = ["repeated", "pf1", "irreducible"];
const FLOOR1_IDS = ["basic", "linear"];
const PARTS_IDS = ["partsPoly", "partsLn"];
const coreDone = () => CORE_IDS.every(isConquered);
const wingOpen = () => coreDone() || !!store.wingOpen;

// On the ground floor and in the parts tower going into a room is always
// free; what is barred is the way OUT of a room not won yet (an iron grate in
// its exit), until it is won or the student opens it anyway. In the
// partial-fractions tower the upper area opens as a whole (or when forced).
const hasExit = (id) => ROOMS.some((r) => isLinearPlace(r.place) && r.requires && r.requires[0] === id);
function exitForced(id) {
  if ((store.openedExits || {})[id]) return true;
  // Older stores: a room opened anyway, or the stairs.
  if (id === "linear" && store.stairsOpen) return true;
  return ROOMS.some((r) => r.requires && r.requires[0] === id && isLinearPlace(r.place) && (store.openedRooms || {})[r.id]);
}
const exitOpen = (id) => isConquered(id) || exitForced(id);
const exitBlocked = (id) => !!ROOM_BY_ID[id] && hasExit(id) && !exitOpen(id);

// A room the student can't reach yet: on a line, behind a barred exit.
function isLocked(room) {
  if (!room.requires) return false;
  const rec = roomRecord(room.id);
  if (rec.run || rec.wins > 0) return false;
  if (isLinearPlace(room.place)) return !exitOpen(room.requires[0]);
  return !wingOpen();
}

// The stairs up to the towers (both): past room 2's exit.
const stairsOpen = () => exitOpen("linear");

function recommendedRoomId() {
  if (currentPlace() === "ground") return FLOOR1_IDS.find((id) => !isConquered(id)) || null;
  if (currentPlace() === "parts") return PARTS_IDS.find((id) => !isConquered(id)) || null;
  if (!isConquered("repeated")) return "repeated";
  if (!isConquered("pf1")) return "pf1";
  if (!isConquered("irreducible")) return "irreducible";
  if (!isConquered("review")) return "review";
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
const medalView = $("medalView");
const towerEl = $("tower");

// --- sound -------------------------------------------------------------------
// A few short, quiet effects, synthesized with Web Audio (no sound files).
// Off on every load: the student turns it on with the button in the corner,
// and the choice is deliberately not saved.

let soundOn = false;
let audioCtx = null;
let masterGain = null;

function audio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.7;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// One note: a pitch (sliding to f2), a quick rise and a fade.
function tone({ f, f2 = f, t = 0, dur = 0.2, type = "sine", vol = 0.1, attack = 0.005 }) {
  const c = audioCtx;
  const t0 = c.currentTime + t;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(masterGain);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// A burst of filtered noise: steps, clicks, iron, a rumble.
let noiseBuf = null;
function noise({ t = 0, dur = 0.1, vol = 0.1, freq = 1000, q = 1, type = "bandpass", attack = 0.003 }) {
  const c = audioCtx;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = c.currentTime + t;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(masterGain);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.05);
}

const SFX = {
  // Soft footsteps for a walk of `ms` milliseconds.
  steps(ms) {
    const n = Math.max(1, Math.round(ms / 170));
    for (let i = 0; i < n; i++) noise({ t: i * 0.17, dur: 0.06, vol: 0.2, freq: 420 + (i % 2) * 90, type: "lowpass" });
  },
  // Into a room: a heavy door, low and short.
  door() {
    tone({ f: 120, f2: 70, dur: 0.3, type: "triangle", vol: 0.14 });
    noise({ dur: 0.2, vol: 0.05, freq: 600, type: "lowpass" });
  },
  // Up (or down) the stairs: steps rising (or falling) in pitch.
  stairs(up) {
    for (let i = 0; i < 5; i++) {
      const k = up ? i : 4 - i;
      noise({ t: i * 0.13, dur: 0.06, vol: 0.28, freq: 380 * 1.18 ** k, q: 2 });
    }
  },
  // An iron grate drawn up: a chain's rattle, then a clunk at the top.
  grate() {
    for (let i = 0; i < 9; i++) noise({ t: i * 0.07, dur: 0.035, vol: 0.05, freq: 2400 + (i % 3) * 300, q: 9 });
    tone({ f: 95, f2: 60, t: 0.68, dur: 0.3, type: "triangle", vol: 0.12 });
  },
  // A padlock springing open: two small clicks.
  padlock() {
    noise({ dur: 0.03, vol: 0.35, freq: 3200, q: 6 });
    noise({ t: 0.11, dur: 0.04, vol: 0.3, freq: 2600, q: 6 });
  },
  // The gate's doors swinging open: a slow low rumble.
  gate() {
    noise({ dur: 1.3, vol: 0.09, freq: 170, type: "lowpass", attack: 0.35 });
    tone({ f: 58, f2: 46, dur: 1.3, type: "triangle", vol: 0.08, attack: 0.35 });
  },
  // A room won: a soft rising chord; a perfect run adds the octave.
  win(perfect) {
    const notes = [261.63, 329.63, 392, 523.25];
    if (perfect) notes.push(659.25);
    notes.forEach((f, i) => tone({ f, t: i * 0.1, dur: 1.4, type: "triangle", vol: 0.06, attack: 0.02 }));
  },
  // Torches catching fire: a soft rising whoosh.
  ignite() {
    noise({ dur: 0.55, vol: 0.07, freq: 700, q: 0.8, attack: 0.18 });
    noise({ t: 0.1, dur: 0.5, vol: 0.05, freq: 1500, q: 0.8, attack: 0.2 });
  },
  // An answer: right - two small high notes up; wrong - one soft low note down.
  correct() {
    tone({ f: 659.25, dur: 0.14, vol: 0.05 });
    tone({ f: 880, t: 0.08, dur: 0.22, vol: 0.05 });
  },
  wrong() {
    tone({ f: 220, f2: 185, dur: 0.22, type: "triangle", vol: 0.08, attack: 0.01 });
  },
  // A boss: one deep drum beat and a low note under it.
  boss() {
    tone({ f: 82, f2: 44, dur: 0.6, vol: 0.2 });
    tone({ f: 110, t: 0.05, dur: 1.2, type: "triangle", vol: 0.05, attack: 0.25 });
    tone({ f: 116.5, t: 0.05, dur: 1.2, type: "triangle", vol: 0.03, attack: 0.25 });
  },
};

function sfx(name, ...args) {
  if (!soundOn || document.hidden || !audio()) return;
  try {
    SFX[name](...args);
  } catch {
    // no sound is fine
  }
}

const SOUND_ICON_OFF =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>';
const SOUND_ICON_ON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>';

function renderSoundBtn() {
  const btn = $("soundBtn");
  btn.innerHTML = soundOn ? SOUND_ICON_ON : SOUND_ICON_OFF;
  btn.setAttribute("aria-pressed", String(soundOn));
  btn.title = soundOn ? "השתקה" : "הפעלת צלילים";
  btn.setAttribute("aria-label", btn.title);
}

$("soundBtn").addEventListener("click", (e) => {
  soundOn = !soundOn;
  renderSoundBtn();
  // Let go of the focus, so Enter goes back to the map (into the room the
  // marker stands in) instead of toggling the sound again.
  e.currentTarget.blur();
  if (soundOn) sfx("padlock"); // a small click: sound is on
});
renderSoundBtn();

// --- going into a room and back: the map zooms in on the room, and out ---

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let mapZoom = null; // the zoom-in, held at its end until the room is showing
let lastView = null;

// Point of the map (relative to the map view) at the centre of an element.
function mapOrigin(el) {
  const v = mapView.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return `${r.left + r.width / 2 - v.left}px ${r.top + r.height / 2 - v.top}px`;
}

function zoomIntoRoom(id) {
  if (ROOM_BY_ID[id]) sfx("door");
  const el = nodeEl(id);
  if (!el || reducedMotion()) return Promise.resolve();
  mapView.style.transformOrigin = mapOrigin(el);
  mapZoom = mapView.animate(
    [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(2.4)", opacity: 0 }],
    { duration: 380, easing: "cubic-bezier(0.5, 0, 0.75, 0.4)", fill: "forwards" }
  );
  return mapZoom.finished.catch(() => {});
}

function zoomOutOfRoom(id) {
  if (mapZoom) {
    mapZoom.cancel();
    mapZoom = null;
  }
  const el = id && nodeEl(id);
  if (!el || reducedMotion()) return;
  mapView.style.transformOrigin = mapOrigin(el);
  mapView.animate(
    [{ transform: "scale(2.2)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
    { duration: 420, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" }
  );
}

function showView(view) {
  const from = lastView;
  lastView = view;
  if ((view === roomView || view === medalView) && !reducedMotion()) {
    view.animate(
      [{ transform: "scale(0.94)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: from === mapView ? 300 : 0, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" }
    );
  }
  for (const v of [mapView, roomView, conquestView, medalView, castleView]) v.hidden = v !== view;
  window.scrollTo(0, 0);
}

// --- map --------------------------------------------------------------------

let justConquered = null; // room id whose card flips on the next map render
let justLit = null; // ...and whose torches catch fire then (its first win only)


// A gold victory banner hanging on a completed room.
const PENNANT_SVG =
  '<svg class="conquered-flag" viewBox="0 0 24 34" aria-hidden="true"><rect class="rod" x="0" y="0" width="24" height="3" rx="1.5"/><path class="cloth" d="M3 3h18v28l-9-6-9 6z"/><path class="star" d="M12 7.5l1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>';

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
  const onLineFloor = isLinearPlace(room.place);
  const locked = !onLineFloor && isLocked(room); // a line has grates, not locked rooms
  const conquered = rec.wins > 0;
  const recommended = recommendedRoomId() === room.id;
  const classes = ["room-card", `room-${room.kind}`];
  if (locked) classes.push("locked");
  if (conquered) classes.push("conquered");
  if (rec.run) classes.push("in-progress");
  if (recommended && !locked) classes.push("recommended");
  if (justConquered === room.id) classes.push("just-conquered");

  let side = "";
  if (conquered) {
    side = `<span class="wins" title="מספר הניצחונות בחדר">×${rec.wins}</span>` +
      `<span class="score-chip small tier-${scoreTier(rec.best)}" title="הציון הטוב ביותר">${rec.best}</span>`;
  }

  const info = [`<div class="info-en" dir="ltr">${room.en}</div>`, `<div class="info-tag">${room.tag}${room.stars ? " " + "★".repeat(room.stars) : ""}</div>`];
  if (room.blurb) info.push(`<div>${room.blurb}</div>`);
  if (onLineFloor && exitBlocked(room.id)) info.push(`<div class="info-note">היציאה נפתחת כשמסיימים את החדר.</div>`);
  if (locked) {
    const missing = missingRequirements(room);
    const nums = missing.map((id) => ROOM_BY_ID[id].num).join(", ");
    info.push(`<div class="info-note">נפתח אחרי ${missing.length > 1 ? "חדרים" : "חדר"} <bdi dir="ltr">${nums}</bdi>.</div>`);
  }
  if (rec.run) info.push(`<div class="info-note">בתהליך: תרגיל ${rec.run.node + 1} מתוך ${room.nodes.length} · ניקוד כרגע: ${rec.run.score}</div>`);
  if (conquered) info.push(`<div class="info-note">ניצחתם בחדר ${rec.wins === 1 ? "פעם אחת" : `${rec.wins} פעמים`} · השיא: ${rec.best}</div>`);

  const done = rec.run ? rec.run.node : conquered ? room.nodes.length : 0;
  return `
    <div class="${classes.join(" ")}" data-room="${room.id}" role="button" tabindex="0">
      ${conquered ? PENNANT_SVG : ""}
      ${onLineFloor ? exitGrateHtml(room.id) : ""}
      ${roomTorchesHtml(conquered, justLit === room.id)}
      <div class="room-head">
        ${room.num ? `<span class="room-num" title="הסדר המומלץ">${room.num}</span>` : ""}<span class="room-title">${room.title}</span>
        <span class="info-wrap">
          <button type="button" class="info-btn" data-info aria-label="מידע על החדר" aria-expanded="false">i</button>
          <span class="room-info" role="tooltip">${info.join("")}</span>
        </span>
      </div>
      ${room.label ? `<div class="room-label">${room.label}</div>` : ""}
      <div class="room-progress">
        <div class="mini-path">${nodeDotsHtml(room, done, rec.run ? rec.run.node : -1)}</div>
        <div class="room-side">${side}</div>
      </div>
    </div>`;
}

// Arched wooden door in the outer wall: the way into the floor.
const DOOR_SVG = `
  <svg class="map-door" viewBox="0 0 60 56" aria-hidden="true">
    <path class="door-frame" d="M2 56V26a28 26 0 0 1 56 0v30z"/>
    <path class="door-wood" d="M8 56V27a22 21 0 0 1 44 0v29z"/>
    <path class="door-planks" d="M19 56V10M30 56V6M41 56V10"/>
    <path class="door-band" d="M8 24h44M8 44h44"/>
    <circle class="door-ring" cx="37" cy="36" r="2.6"/>
  </svg>`;

// A torch on the bare rock of an empty map cell, with a pool of warm light
// around it (laptops and tablets only - the phone layout has no empty cells).
const mapTorch = (col, row, cls = "") =>
  `<div class="cell map-torch${cls}" style="grid-column:${col};grid-row:${row}" aria-hidden="true">${torchHtml(col < 3 ? "l" : "r")}</div>`;

// Every floor wakes up as it is won: each room has two small torches on the
// wall above it, cold until the room is won; they catch fire once, right
// after the win (`lighting`). A floor's big torches light when its main rooms
// are won (`core`), the last ones when all are, and the floor's name gets a
// gold frame when every room is.
const roomTorchesHtml = (lit, lighting) =>
  `<span class="room-torches${lit ? " lit" : ""}${lighting ? " lighting" : ""}" aria-hidden="true">${torchHtml("l")}${torchHtml("r")}</span>`;

function floorLighting(place, coreIds) {
  const ids = ROOMS.filter((r) => r.place === place).map((r) => r.id);
  const fresh = !!justLit && ids.includes(justLit);
  if (fresh && !reducedMotion()) setTimeout(() => sfx("ignite"), 1000);
  const done = ids.every(isConquered);
  const lit = (on, byThisWin) => (on ? (fresh && byThisWin ? " lit lighting" : " lit") : "");
  return {
    core: lit(coreIds.every(isConquered), coreIds.includes(justLit)),
    all: lit(done, true),
    label: done ? " floor-done" : "",
  };
}

// A doorway through the wall between two areas of the map.
const doorway = (col, row) => `<div class="doorway" style="grid-column:${col};grid-row:${row}" aria-hidden="true"></div>`;

// The iron grate across a room's exit, on a line. Drawn while the exit is
// barred - and, closed, once more right after the win, so playUnlock() can
// raise it in front of the student.
function exitGrateHtml(id) {
  if (!hasExit(id)) return "";
  const rising = pendingUnlock && pendingUnlock.exit === id;
  if (exitOpen(id) && !rising) return "";
  return `<span class="exit-grate" data-exit="${id}" aria-label="היציאה חסומה">${GRATE_SVG}</span>`;
}

const GRATE_SVG = `
  <svg viewBox="0 0 20 58" aria-hidden="true" preserveAspectRatio="none">
    <rect x="1.5" y="1.5" width="17" height="53" rx="1" fill="rgba(30, 26, 22, 0.35)" stroke="#2b2620" stroke-width="3"/>
    <path d="M7.2 2V54M12.8 2V54" stroke="#2b2620" stroke-width="2.6"/>
    <path d="M2 16H18M2 40H18" stroke="#2b2620" stroke-width="2.6"/>
    <path d="M7.2 54v3M12.8 54v3M2.5 54v3M17.5 54v3" stroke="#2b2620" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`;

// One padlock on the wing's gate, numbered after its core room.
function padlockSvg(n, open) {
  return `
    <svg class="padlock${open ? " open" : ""}" viewBox="0 0 24 30" role="img" aria-label="מנעול ${n}${open ? " - פתוח" : ""}">
      <path class="shackle" d="M6.5 13V8.5a5.5 5.5 0 0 1 11 0V13"/>
      <rect class="lock-body" x="2.5" y="12" width="19" height="16" rx="3"/>
      <text x="12" y="24.5" text-anchor="middle">${n}</text>
    </svg>`;
}

// --- medals: one per topic, shown in the medals room (the button beside the map) ---
// A medal is earned by winning its rooms; its score is their average best.
// Upgrades (rational functions only): a gold rim and a star for optional rooms.

const MEDAL_COLORS = { high: "#3f8a5c", mid: "#c08a12", low: "#b5523b" };

const MEDALS = [
  {
    id: "pf",
    title: "פונקציות רציונליות",
    rooms: CORE_IDS,
    need: "שלושת החדרים במסדרון",
    gold: { room: "review", text: "תרגילים מעורבבים" },
    star: { room: "nonmonic", text: "מכנה עם מקדם מוביל" },
  },
  {
    id: "parts",
    title: "אינטגרציה בחלקים",
    rooms: ROOMS.filter((r) => r.place === "parts").map((r) => r.id),
    need: "כל החדרים במגדל",
  },
];

function medalState(medal) {
  const earned = medal.rooms.every(isConquered);
  const avg = earned ? medal.rooms.reduce((s, id) => s + roomRecord(id).best, 0) / medal.rooms.length : null;
  return {
    id: medal.id,
    title: medal.title,
    earned,
    avg: avg === null ? null : Math.round(avg * 10) / 10,
    gold: !!medal.gold && isConquered(medal.gold.room),
    star: !!medal.star && isConquered(medal.star.room),
  };
}

const allMedalStates = () => MEDALS.map(medalState);
const medalSig = (m) => (m.earned ? `${m.avg}|${m.gold}|${m.star}` : "");
// Earned (or changed) since the student last looked at the medals room.
// (Older stores kept one string, store.medalSeen, for the rational medal.)
const medalsSeen = () => store.medalsSeen || { pf: store.medalSeen };
const medalIsNew = (m) => m.earned && medalsSeen()[m.id] !== medalSig(m);

// Two laurel branches curving up either side of the medal.
function laurelLeaves(color) {
  let leaves = "";
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const deg = 250 - i * 22; // from the bottom, up the side
      const a = (deg * Math.PI) / 180;
      const x = 60 + side * 47 * Math.cos(a);
      const y = 58 - 47 * Math.sin(a);
      const rot = side * (deg - 90);
      leaves += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="3.6" ry="8" transform="rotate(${rot.toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${color}"/>`;
    }
  }
  return leaves;
}

function medalSvg(m) {
  const star = '<path class="medal-star" d="M60 4l3.8 7.8 8.6 1.2-6.2 6 1.5 8.6L60 23.5l-7.7 4.1 1.5-8.6-6.2-6 8.6-1.2z"/>';
  const ribbon = `
    <path class="medal-ribbon" d="M10 94h100l-6 9 6 9H10l6-9z"/>
    <text class="medal-ribbon-text" x="60" y="106.5" text-anchor="middle">${m.title}</text>`;
  if (!m.earned) {
    return `
      <svg class="medal empty" viewBox="0 0 120 116" role="img" aria-label="המדליה עוד לא הושגה">
        <g opacity="0.3">${laurelLeaves("#8c8270")}</g>
        <circle cx="60" cy="58" r="34" class="medal-outline"/>
        <text x="60" y="69" text-anchor="middle" class="medal-q">?</text>
        ${ribbon}
      </svg>`;
  }
  const fill = MEDAL_COLORS[scoreTier(m.avg)];
  return `
    <svg class="medal${m.gold ? " gold" : ""}" viewBox="0 0 120 116" role="img" aria-label="מדליה: ממוצע ${m.avg}">
      ${laurelLeaves(m.gold ? "#c9a227" : "#6f8f4e")}
      <circle cx="60" cy="58" r="35" class="medal-rim"/>
      <circle cx="60" cy="58" r="30" fill="${fill}"/>
      <circle cx="60" cy="58" r="26" class="medal-inner"/>
      <text x="60" y="47" text-anchor="middle" class="medal-int">∫</text>
      <text x="60" y="72" text-anchor="middle" class="medal-avg">${m.avg}</text>
      ${m.star ? star : ""}
      ${ribbon}
    </svg>`;
}

// The old medal room on the rational floor: kept in its place, empty for now
// (the medals moved to their own room, opened from the button by the map).
function trophyHtml() {
  return `
    <div class="room-card room-medals" data-node="trophy" role="button" tabindex="0">
      <div class="room-head"><span class="room-title">חדר ריק</span></div>
    </div>`;
}

// A carved stone pedestal for the medal: a slab on top, a fluted column, and
// two steps at the foot, with a pool of light on its top.
const PEDESTAL_SVG = `
  <svg class="pedestal" viewBox="0 0 180 130" aria-hidden="true">
    <defs>
      <linearGradient id="pedStone" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#7d715e"/><stop offset="0.45" stop-color="#cfc3a8"/><stop offset="1" stop-color="#6f6453"/>
      </linearGradient>
    </defs>
    <ellipse class="ped-light" cx="90" cy="9" rx="60" ry="7"/>
    <rect x="22" y="8" width="136" height="14" rx="2" fill="url(#pedStone)" stroke="#3e362c"/>
    <rect x="34" y="22" width="112" height="6" fill="#8d806a" stroke="#3e362c"/>
    <rect x="44" y="28" width="92" height="70" fill="url(#pedStone)" stroke="#3e362c"/>
    <path d="M58 30V96M72 30V96M86 30V96M100 30V96M114 30V96M128 30V96" stroke="#5e5446" stroke-opacity="0.55" stroke-width="2"/>
    <rect x="34" y="98" width="112" height="10" fill="url(#pedStone)" stroke="#3e362c"/>
    <rect x="20" y="108" width="140" height="14" rx="2" fill="url(#pedStone)" stroke="#3e362c"/>
  </svg>`;

// The medals room: a torch-lit hall with a pedestal per medal, each with its
// score and what is still open. A medal seen here for the first time shines.
function renderMedalView() {
  const states = allMedalStates();
  const fresh = states.map(medalIsNew);
  if (fresh.some(Boolean)) {
    store.medalsSeen = Object.fromEntries(states.map((m) => [m.id, medalSig(m)]));
    saveStore();
  }
  const item = (done, text) =>
    `<li class="${done ? "done" : ""}"><span class="check" aria-hidden="true">${done ? "✓" : ""}</span>${text}</li>`;
  const spot = (m, i) => {
    const medal = MEDALS[i];
    const n = medal.rooms.length;
    return `
      <div class="medal-spot${m.earned ? " lit" : ""}">
        <div class="medal-alcove">
          <div class="medal-beam" aria-hidden="true"></div>
          <div class="medal-big${fresh[i] ? " medal-new" : ""}">${medalSvg(m)}</div>
          ${PEDESTAL_SVG}
        </div>
        <div class="medal-score">${m.earned ? `ממוצע ${{ 2: "שני ", 3: "שלושת " }[n] || ""}החדרים: <b>${m.avg}</b>` : "המדליה עוד לא הושגה"}</div>
        <ul class="medal-checklist">${item(m.earned, medal.need)}</ul>
        ${medal.gold || medal.star ? `
          <div class="medal-extras">
            <div class="medal-extras-head">שדרוגים</div>
            <ul class="medal-checklist">
              ${medal.gold ? item(m.gold, `<span class="extra-what">זהב</span> ${medal.gold.text}`) : ""}
              ${medal.star ? item(m.star, `<span class="extra-what">כוכב</span> ${medal.star.text}`) : ""}
            </ul>
          </div>` : ""}
      </div>`;
  };
  $("medalStage").innerHTML = `
    <div class="medal-hall">
      ${torchHtml("l")}${torchHtml("r")}
      ${states.map(spot).join("")}
    </div>`;
}

// The medals button beside the map: glows while a medal waits unseen.
function renderMedalsBtn() {
  $("medalsBtn").classList.toggle("has-new", allMedalStates().some(medalIsNew));
}

// Back on the map after a first win in a core room: once the zoom-out has
// settled, that padlock jiggles and springs open; if it was the last one, the
// gate doors swing open and the fog lifts off the upper wing.
function playUnlock() {
  const u = pendingUnlock;
  pendingUnlock = null;
  if (!u) return;
  const t0 = reducedMotion() ? 0 : 750;
  if (u.exit) {
    // On a line: the grate across the room's exit slides up and is gone.
    const grate = towerEl.querySelector(`.exit-grate[data-exit="${u.exit}"]`);
    setTimeout(() => {
      if (!grate) return;
      grate.classList.add("rising");
      sfx("grate");
    }, t0);
    setTimeout(() => grate && grate.remove(), t0 + 1000);
    return;
  }
  const lock = towerEl.querySelectorAll(".padlock")[u.lock - 1];
  setTimeout(() => lock && lock.classList.add("unlocking"), t0);
  setTimeout(() => {
    if (!lock) return;
    sfx("padlock");
    lock.classList.add("open");
    lock.setAttribute("aria-label", `מנעול ${u.lock} - פתוח`);
  }, t0 + 420);
  if (!u.gate) return;
  setTimeout(() => {
    const passage = towerEl.querySelector(".passage");
    if (passage) passage.classList.add("open");
    sfx("gate");
    towerEl.querySelectorAll("[data-open-wing]").forEach((b) => b.remove());
    towerEl.querySelectorAll(".wing.fogged").forEach((c) => c.classList.replace("fogged", "wing-reveal"));
  }, t0 + 1300);
}

function goToMedals() {
  location.hash = "#/medals";
}

$("medalBackBtn").addEventListener("click", () => goToMap());
$("medalsBtn").addEventListener("click", () => goToMedals());

// The stairs on the ground floor, one per tower.
const STAIRS_TO = { pf: "stairsPf", parts: "stairsParts" };
const STAIRS_PLACE = { stairsPf: "pf", stairsParts: "parts" };

// Up or down the stairs: the map of the other place comes in, with the
// marker standing where the stairs arrive (a tower's way down, or that
// tower's stairs on the ground floor) - or, from the floor panel, at `at`.
function goToPlace(place, at) {
  const from = currentPlace();
  store.place = place;
  store.lastRoom = at || (place === "ground" ? STAIRS_TO[from] || "entrance" : "entrance");
  saveStore();
  if (mapZoom) {
    mapZoom.cancel();
    mapZoom = null;
  }
  renderMap();
  window.scrollTo(0, 0);
  if (!reducedMotion()) {
    mapView.animate(
      [{ transform: `translateY(${place === "ground" ? -24 : 24}px)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 380, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" }
    );
  }
}

const goUpstairs = (stairs) => {
  sfx("stairs", true);
  return zoomIntoRoom(stairs).then(() => goToPlace(STAIRS_PLACE[stairs]));
};
const goDownstairs = () => {
  sfx("stairs", false);
  goToPlace("ground");
};

function renderMap() {
  const place = currentPlace();
  if (place === "ground") renderBasicFloor();
  else if (place === "parts") renderPartsFloor();
  else renderRationalFloor();
  renderTowerNav();
}

// --- the floor panel: the castle in cross-section ----------------------------
// Beside the map: the ground floor at the bottom, the towers side by side
// above it. A click goes straight to a place; a locked tower asks, with
// "open anyway". The partial-fractions tower's gate to its upper area is not
// here: it is opened on the map, by hand.

const towerNavEl = $("towerNav");

function towerNavItems() {
  const place = currentPlace();
  const towers = [
    {
      go: "pf",
      mark: "½",
      name: "שברים חלקיים",
      full: "מגדל השברים החלקיים",
      locked: !stairsOpen(),
      done: coreDone(),
      here: place === "pf",
    },
    {
      go: "parts",
      mark: "uv",
      name: "אינטגרציה בחלקים",
      full: "מגדל האינטגרציה בחלקים",
      locked: !stairsOpen(),
      done: PARTS_IDS.every(isConquered),
      here: place === "parts",
    },
  ];
  const ground = {
    go: "ground",
    mark: "∫",
    name: "קומת הקרקע",
    sub: "אינטגרלים בסיסיים",
    full: "קומת הקרקע · אינטגרלים בסיסיים",
    locked: false,
    done: FLOOR1_IDS.every(isConquered),
    here: place === "ground",
  };
  return { towers, ground };
}

function towerNavButton(f) {
  const cls = ["tn-floor"];
  if (f.here) cls.push("here");
  if (f.locked) cls.push("locked");
  if (f.done) cls.push("done");
  const state = f.locked ? padlockSvg("", false) : f.done ? '<span class="tn-done" title="הושלם">✓</span>' : "";
  const label = `${f.full}${f.locked ? " - נעול" : ""}${f.here ? " - אתם כאן" : ""}`;
  return `
    <button type="button" class="${cls.join(" ")}" data-go="${f.go}" title="${label}" aria-label="${label}"${f.here ? ' aria-current="location"' : ""}>
      <span class="tn-mark" dir="ltr">${f.mark}</span>
      <span class="tn-text"><span class="tn-name">${f.name}</span>${f.sub ? `<span class="tn-sub">${f.sub}</span>` : ""}</span>
      <span class="tn-state">${state}</span>
      ${f.here ? '<span class="tn-here" aria-hidden="true"></span>' : ""}
    </button>`;
}

// A plain list of the places, with the castle (the big picture) on top.
function renderTowerNav() {
  const { towers, ground } = towerNavItems();
  towerNavEl.innerHTML = `
    <button type="button" class="tn-castle" data-castle title="הטירה" aria-label="הטירה">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21V9h3v3h2V6h3v3h2V6h3v6h2V9h3v12z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4" fill="#2c2721"/></svg>
      <span class="tn-name">הטירה</span>
    </button>
    <div class="tn-list">${[ground, ...towers].map(towerNavButton).join("")}</div>`;
}

// Go to a place from the panel - or ask, if its stairs are locked.
function towerNavGo(place) {
  if (markerBusy || !PLACES.includes(place)) return;
  dismissMapTip();
  if (place !== "ground" && !stairsOpen()) {
    openStairsDialog(() => goToPlace(place, "entrance"));
    return;
  }
  if (place !== currentPlace()) goToPlace(place, place === "ground" ? "entrance" : undefined);
}

towerNavEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-castle]")) {
    location.hash = "#/castle";
    return;
  }
  const b = e.target.closest("[data-go]");
  if (b) towerNavGo(b.dataset.go);
});

// --- the castle from outside -------------------------------------------------
// At night: the ground floor as the base, the towers side by side on it. A
// window per room - dark, flickering (in progress) or lit (won) - and a flag
// on a tower whose medal is earned. A window lit since the last look lights
// up in front of the student, once. A click on a place goes there.

const castleView = $("castleView");
const CASTLE_INTRO = true; // a short look at the castle when the game opens
let castleIntroTimer = null;

function castleWindow(id, x, y, i) {
  const rec = roomRecord(id);
  const state = rec.wins > 0 ? "lit" : rec.run ? "half" : "dark";
  const isNew = state === "lit" && !(store.castleSeen || []).includes(id);
  const tip = `${ROOM_BY_ID[id].title}${rec.wins > 0 ? ` · ${rec.best}` : ""}`;
  return `<path class="cs-win ${state}${isNew ? " cs-new" : ""}"${isNew ? ` style="animation-delay:${0.5 + i * 0.25}s"` : ""} d="M${x} ${y + 24}V${y + 8}a8 8 0 0 1 16 0V${y + 24}z"><title>${tip}</title></path>`;
}

function castleFlag(x, y, medalId) {
  const m = medalState(MEDALS.find((md) => md.id === medalId));
  const isNew = m.earned && !(store.castleSeen || []).includes(`flag:${medalId}`);
  return `
    <line x1="${x}" y1="${y}" x2="${x}" y2="${y - 34}" class="cs-pole"/>
    ${m.earned ? `<path class="cs-flag${isNew ? " cs-new" : ""}" d="M${x} ${y - 34}h22l-5 7 5 7h-22z"><title>מדליה · ${m.avg}</title></path>` : ""}`;
}

// Crenellations along a wall's top edge.
const castleMerlons = (x1, x2, y) => {
  let s = "";
  for (let x = x1; x + 10 <= x2; x += 18) s += `<rect x="${x}" y="${y - 9}" width="10" height="9" class="cs-stone"/>`;
  return s;
};

function renderCastleView(intro = false) {
  const locked = !stairsOpen();
  let n = 0; // order in which new windows light up
  const win = (id, x, y) => castleWindow(id, x, y, n++);
  const towerCls = (place) => `cs-place${locked ? " cs-locked" : ""}${currentPlace() === place ? " cs-here" : ""}`;
  const stars = [[40, 40], [110, 90], [190, 30], [300, 70], [350, 24], [470, 50], [560, 95], [600, 30], [520, 140], [70, 160]]
    .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 ? 1.2 : 1.8}" class="cs-star"/>`)
    .join("");
  $("castleStage").innerHTML = `
    <svg class="castle-svg" viewBox="0 0 640 400" role="img" aria-label="הטירה">
      <defs>
        <linearGradient id="csSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f1424"/><stop offset="1" stop-color="#2a2a3a"/></linearGradient>
      </defs>
      <rect width="640" height="400" fill="url(#csSky)"/>
      ${stars}
      <circle cx="560" cy="62" r="18" class="cs-moon"/>
      <path d="M0 382Q320 352 640 382V400H0z" class="cs-hill"/>

      <g class="${towerCls("pf")}" data-go="pf">
        <title>מגדל השברים החלקיים</title>
        <polygon points="138,124 302,124 220,54" class="cs-roof"/>
        <rect x="150" y="124" width="140" height="170" class="cs-wall"/>
        ${win("review", 184, 150)}${win("nonmonic", 240, 150)}
        ${win("repeated", 166, 200)}${win("pf1", 212, 200)}${win("irreducible", 258, 200)}
        ${win("division", 212, 248)}
        <text x="220" y="140" class="cs-label">שברים חלקיים</text>
        ${castleFlag(220, 54, "pf")}
      </g>

      <g class="${towerCls("parts")}" data-go="parts">
        <title>מגדל האינטגרציה בחלקים</title>
        <polygon points="350,194 470,194 410,134" class="cs-roof"/>
        <rect x="360" y="194" width="100" height="100" class="cs-wall"/>
        <text x="410" y="210" class="cs-label">אינטגרציה בחלקים</text>
        ${PARTS_IDS.map((id, i) => win(id, 402, 256 - i * 36)).join("")}
        ${castleFlag(410, 134, "parts")}
      </g>

      <g class="cs-place${currentPlace() === "ground" ? " cs-here" : ""}" data-go="ground">
        <title>קומת הקרקע</title>
        <rect x="110" y="294" width="420" height="80" class="cs-wall"/>
        ${castleMerlons(112, 530, 294)}
        <path d="M300 374V344a20 20 0 0 1 40 0V374z" class="cs-gate"/>
        ${win("basic", 420, 324)}${win("linear", 370, 324)}${win("more", 222, 324)}
        <text x="180" y="366" class="cs-label">קומת הקרקע</text>
      </g>
    </svg>
    <p class="castle-hint">${intro ? "לחצו בכל מקום כדי להמשיך" : locked ? "המגדלים נפתחים אחרי חדר 2 בקומת הקרקע" : "לחצו על מקום בטירה כדי ללכת אליו"}</p>`;
  // What the student has now seen lit: those windows and flags won't light up again.
  const seen = ROOMS.filter((r) => isConquered(r.id)).map((r) => r.id);
  MEDALS.forEach((md) => medalState(md).earned && seen.push(`flag:${md.id}`));
  store.castleSeen = seen;
  saveStore();
}

function castleGo(place) {
  clearTimeout(castleIntroTimer);
  castleView.classList.remove("intro");
  if (place && place !== "ground" && !stairsOpen()) return;
  if (place && place !== currentPlace()) {
    store.place = place;
    store.lastRoom = "entrance";
    saveStore();
  }
  if (location.hash === "#/" || location.hash === "") route();
  else location.hash = "#/";
}

castleView.addEventListener("click", (e) => {
  const place = e.target.closest("[data-go]");
  if (place) castleGo(place.dataset.go);
  else if (castleView.classList.contains("intro") || e.target.closest("#castleBackBtn")) castleGo(null);
});

// When the game opens: the castle for a moment, then on to the map.
function showCastleIntro() {
  renderCastleView(true);
  castleView.classList.add("intro");
  showView(castleView);
  castleIntroTimer = setTimeout(() => castleGo(null), 2600);
}

// The way up: stone steps climbing into a dark arched stairwell, lit from
// the corridor and fading into the dark. Locked, an iron grille closes it.
function stairsSvg(locked) {
  const steps = [];
  let y = 118;
  for (let i = 0; i < 8; i++) {
    const k = 1 - i * 0.075; // farther steps are smaller
    const w = 60 * k;
    const x = 50 - w / 2;
    const riser = 5 * k;
    const tread = 7 * k;
    const light = 1 - i / 9;
    const mix = (a, b) => Math.round(b + (a - b) * light);
    const tc = `rgb(${mix(222, 70)},${mix(208, 58)},${mix(178, 44)})`;
    const rc = `rgb(${mix(150, 48)},${mix(134, 40)},${mix(108, 30)})`;
    steps.push(`<rect x="${x}" y="${y - riser}" width="${w}" height="${riser}" fill="${rc}"/>`);
    steps.push(`<rect x="${x}" y="${y - riser - tread}" width="${w}" height="${tread}" fill="${tc}"/>`);
    y -= riser + tread;
  }
  const bars = locked
    ? [30, 40, 50, 60, 70].map((x) => `<line x1="${x}" y1="${x === 50 ? 17 : 22}" x2="${x}" y2="118"/>`).join("") +
      '<line x1="18" y1="60" x2="82" y2="60"/><line x1="18" y1="92" x2="82" y2="92"/>'
    : "";
  return `
  <svg class="stairs-steps" viewBox="0 0 100 120" aria-hidden="true">
    <defs>
      <linearGradient id="stairs-dark" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#140f0a"/><stop offset="1" stop-color="#3d3226"/>
      </linearGradient>
    </defs>
    <path d="M6 120 V46 A44 44 0 0 1 94 46 V120 Z" fill="#8d806a" stroke="#5e5446" stroke-width="2"/>
    <path d="M18 120 V48 A32 32 0 0 1 82 48 V120 Z" fill="url(#stairs-dark)"/>
    <g>${steps.join("")}</g>
    <path d="M18 120 V48 A32 32 0 0 1 82 48 V120" fill="none" stroke="#3e352a" stroke-width="2"/>
    <path d="M6 72 H18 M6 98 H18 M82 72 H94 M82 98 H94 M9 34 L20 40 M91 34 L80 40 M50 2 V16" stroke="#6f6452" stroke-width="1.5"/>
    ${bars ? `<g class="stairs-bars">${bars}</g>` : ""}
  </svg>`;
}

// The way down: an opening in the floor, its steps sinking into the dark
// (seen from above - the nearest step is the top one).
const STAIRS_DOWN_SVG = (() => {
  const steps = [];
  let y = 9;
  for (let i = 0; i < 7; i++) {
    const k = 1 - i * 0.08;
    const w = 70 * k;
    const x = 50 - w / 2;
    const tread = 8 * k;
    const riser = 3.5 * k;
    const light = 1 - i / 7.5;
    const mix = (a, b) => Math.round(b + (a - b) * light);
    steps.push(`<rect x="${x}" y="${y}" width="${w}" height="${tread}" fill="rgb(${mix(222, 62)},${mix(208, 52)},${mix(178, 40)})"/>`);
    steps.push(`<rect x="${x}" y="${y + tread}" width="${w}" height="${riser}" fill="rgb(${mix(140, 34)},${mix(124, 28)},${mix(98, 22)})"/>`);
    y += tread + riser;
  }
  return `
  <svg class="map-door stairs-down" viewBox="0 0 100 92" aria-hidden="true">
    <defs>
      <linearGradient id="stairs-down-dark" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3d3226"/><stop offset="1" stop-color="#120d08"/>
      </linearGradient>
    </defs>
    <rect x="3" y="3" width="94" height="86" rx="3" fill="#8d806a" stroke="#5e5446" stroke-width="2"/>
    <rect x="13" y="7" width="74" height="80" fill="url(#stairs-down-dark)"/>
    <g>${steps.join("")}</g>
    <rect x="13" y="7" width="74" height="80" fill="none" stroke="#3e352a" stroke-width="2"/>
    <path d="M3 30 H13 M3 60 H13 M87 30 H97 M87 60 H97" stroke="#6f6452" stroke-width="1.5"/>
  </svg>`;
})();

// One staircase up to a tower, on the ground floor's landing. Never locked
// itself: the way to it is room 2's exit.
function stairsHtml(id, name, full) {
  return `
    <div class="stairs" data-node="${id}" role="button" tabindex="0" aria-label="מדרגות ל${full}">
      ${stairsSvg(false)}
      <span class="stairs-label">${name}</span>
    </div>`;
}

const mapTipHtml = () =>
  store.mapTipSeen
    ? ""
    : `
        <div class="map-tip" role="note">
          <span>לוחצים על חדר כדי להיכנס, או זזים בחיצים ונכנסים ב-<kbd dir="ltr">Enter</kbd></span>
          <button type="button" class="map-tip-close" data-tip-close aria-label="סגירה">✕</button>
        </div>`;

// Top-down plan of the ground floor (basic integrals): one room after the
// other. One line, right to left (RTL): entrance · hall · room 1 · hall ·
// room 2 · hall · a landing with the stairs up to the two towers (row 3).
// The marker stands in the hall in front of a door; the way on goes through
// the room. A side hall goes up from the last hall to the extension room
// (row 1).
function renderBasicFloor() {
  const stairs = `
    <div class="cell stairs-landing" style="grid-column:7;grid-row:3">
      ${stairsHtml("stairsPf", "שברים חלקיים", "מגדל השברים החלקיים")}
      ${stairsHtml("stairsParts", "אינטגרציה בחלקים", "מגדל האינטגרציה בחלקים")}
    </div>`;
  // The floor waking up (see floorLighting): the big torch after rooms 1-2.
  const light = floorLighting("ground", FLOOR1_IDS);
  towerEl.innerHTML = `
    <div class="floor-map floor-alive">
      <div class="floor-label${light.label}">קומת הקרקע · אינטגרלים בסיסיים <span class="floor-en" dir="ltr">(basic integrals)</span></div>
      ${mapTipHtml()}
      <div class="floor-grid floor-basic">
        ${mapTorch(3, 1, light.core)}
        <div class="cell ext-cell" style="grid-column:6;grid-row:1">${roomCardHtml(ROOM_BY_ID.more)}</div>
        <div class="cell entrance" style="grid-column:1;grid-row:3" data-node="entrance">
          ${torchHtml("l")}${DOOR_SVG}${torchHtml("r")}<span class="door-label">כניסה</span>
        </div>
        <div class="hall" style="grid-column:2;grid-row:3" data-spot="basic" aria-hidden="true"></div>
        <div class="cell" style="grid-column:3;grid-row:3">${roomCardHtml(ROOM_BY_ID.basic)}</div>
        <div class="hall" style="grid-column:4;grid-row:3" data-spot="linear" aria-hidden="true"></div>
        <div class="cell" style="grid-column:5;grid-row:3">${roomCardHtml(ROOM_BY_ID.linear)}</div>
        <div class="hall-branch" style="grid-column:6;grid-row:2 / 4" aria-hidden="true">
          <div class="hall hall-v" data-spot="more"></div>
          <div class="hall" data-spot="landing" data-node="landing"></div>
        </div>
        ${stairs}
        <div class="map-marker" aria-hidden="true">
          <span class="marker-pin"></span>
          <span class="marker-hint"></span>
        </div>
      </div>
    </div>`;
  justConquered = justLit = null;
  requestAnimationFrame(() =>
    Promise.all(mapView.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => placeMarker(markerNode(), false))
  );
}

// Top-down plan of floor 2. Grid columns run right to left (RTL): rooms 1-3,
// then the gate up to the upper wing.
//   row 1  upper wing: review · non-monic · the topic medal
//   row 3  upper corridor (fogged until the wing opens)
//   row 5  core rooms 1 · 2 · 3, and the gate with its three locks
//   row 7  main corridor
//   row 9  polynomial division (walk through it - or solve it)
//   row 11 entrance
// Even rows are the walls, with doorways through them.
function renderRationalFloor() {
  const [prep, rep, core, irr, review, ext] = ["division", "repeated", "pf1", "irreducible", "review", "nonmonic"].map((id) => ROOM_BY_ID[id]);
  const open = wingOpen();
  const reveal = open && !store.wingRevealed;
  if (reveal) {
    store.wingRevealed = true;
    saveStore();
  }
  // A lock (and the gate) that this visit opened is drawn shut first, then
  // opens in front of the student - see playUnlock().
  const unlockNow = pendingUnlock;
  const shownOpen = open && !(unlockNow && unlockNow.gate);
  const wingCls = shownOpen ? (reveal ? " wing-reveal" : "") : " fogged";
  const gateCls = shownOpen ? (coreDone() ? " open" : " open forced") : "";
  const locks = CORE_IDS.map((id, i) => padlockSvg(i + 1, isConquered(id) && !(unlockNow && unlockNow.lock === i + 1))).join("");

  // The floor waking up (see floorLighting): the two torches by the main
  // corridor after rooms 1-3, the one up by the wing when every room is won.
  const light = floorLighting("pf", CORE_IDS);
  towerEl.innerHTML = `
    <div class="floor-map floor-alive">
      <div class="floor-label${light.label}">מגדל השברים החלקיים <span class="floor-en" dir="ltr">(partial fractions)</span></div>
      ${mapTipHtml()}
      <div class="floor-grid">
        ${mapTorch(1, 9, light.core)}${mapTorch(3, 9, light.core)}${mapTorch(4, 1, light.all)}
        <div class="cell wing${wingCls}" style="grid-column:1;grid-row:1">${roomCardHtml(review)}</div>
        <div class="cell wing${wingCls}" style="grid-column:2;grid-row:1">${roomCardHtml(ext)}</div>
        <div class="cell wing${wingCls}" style="grid-column:3;grid-row:1">${trophyHtml()}</div>
        ${doorway(1, 2)}${doorway(2, 2)}${doorway(3, 2)}
        <div class="cell corridor upper wing${wingCls}" style="grid-column:1 / 5;grid-row:3">
          <div class="corridor-label">מסדרון עליון</div>
          ${shownOpen ? "" : '<button type="button" class="open-anyway phone-only" data-open-wing>לפתוח בכל זאת</button>'}
        </div>
        <div class="cell" style="grid-column:1;grid-row:5">${roomCardHtml(rep)}</div>
        <div class="cell" style="grid-column:2;grid-row:5">${roomCardHtml(core)}</div>
        <div class="cell" style="grid-column:3;grid-row:5">${roomCardHtml(irr)}</div>
        <div class="cell passage${gateCls}" style="grid-column:4;grid-row:4 / 7" data-node="gate">
          <div class="gate-arch">
            <div class="gate-locks">${locks}</div>
            <div class="gate-doors" aria-hidden="true"><div class="gate-door"></div><div class="gate-door"></div></div>
          </div>
          ${shownOpen ? "" : '<button type="button" class="open-anyway gate-anyway" data-open-wing>לפתוח בכל זאת</button>'}
        </div>
        ${doorway(1, 6)}${doorway(2, 6)}${doorway(3, 6)}
        <div class="cell corridor main" style="grid-column:1 / 5;grid-row:7"><div class="corridor-label">מסדרון · בחרו חדר</div></div>
        ${doorway(2, 8)}
        <div class="cell" style="grid-column:2;grid-row:9">${roomCardHtml(prep)}</div>
        ${doorway(2, 10)}
        <div class="cell entrance" style="grid-column:2;grid-row:11" data-node="entrance">
          ${torchHtml("l")}${STAIRS_DOWN_SVG}${torchHtml("r")}<span class="door-label">מדרגות לקומת הקרקע</span>
        </div>
        <div class="map-marker" aria-hidden="true">
          <span class="marker-pin"></span>
          <span class="marker-hint"></span>
        </div>
      </div>
    </div>`;
  justConquered = justLit = null;
  // Measure once any zoom of the map has settled; positions taken mid-zoom
  // would be scaled.
  requestAnimationFrame(() =>
    Promise.all(mapView.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => placeMarker(markerNode(), false))
  );
}

// Top-down plan of the parts tower's first floor: a line like the ground
// floor's - the stairs down · hall · room 1 · hall · room 2.
function renderPartsFloor() {
  const [r1, r2] = PARTS_IDS.map((id) => ROOM_BY_ID[id]);
  const light = floorLighting("parts", PARTS_IDS); // no big torch on this floor yet
  towerEl.innerHTML = `
    <div class="floor-map floor-alive">
      <div class="floor-label${light.label}">מגדל האינטגרציה בחלקים <span class="floor-en" dir="ltr">(integration by parts)</span></div>
      ${mapTipHtml()}
      <div class="floor-grid floor-basic floor-parts">
        <div class="cell entrance" style="grid-column:1;grid-row:1" data-node="entrance">
          ${torchHtml("l")}${STAIRS_DOWN_SVG}${torchHtml("r")}<span class="door-label">מדרגות לקומת הקרקע</span>
        </div>
        <div class="hall" style="grid-column:2;grid-row:1" data-spot="partsPoly" aria-hidden="true"></div>
        <div class="cell" style="grid-column:3;grid-row:1">${roomCardHtml(r1)}</div>
        <div class="hall" style="grid-column:4;grid-row:1" data-spot="partsLn" aria-hidden="true"></div>
        <div class="cell" style="grid-column:5;grid-row:1">${roomCardHtml(r2)}</div>
        <div class="map-marker" aria-hidden="true">
          <span class="marker-pin"></span>
          <span class="marker-hint"></span>
        </div>
      </div>
    </div>`;
  justConquered = justLit = null;
  requestAnimationFrame(() =>
    Promise.all(mapView.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => placeMarker(markerNode(), false))
  );
}

// --- the "you are here" marker ---------------------------------------------
// It stands at the doorway of a room (or the entrance, or the gate). Arrow
// keys step it between neighbouring places; Enter goes in. A click on a room
// walks it there along the corridors, then goes in.

// The ground floor: a line, then a landing with the stairs to the two
// towers; the extension room up a side hall from the last hall.
const BASIC_FLOOR_NODES = {
  entrance: { nav: { left: "basic" } },
  basic: { nav: { left: "linear", right: "entrance" } },
  linear: { nav: { right: "basic", left: "landing" } },
  // The hall past room 2: up to the extension room, on to the stairs.
  landing: { nav: { right: "linear", left: "stairsPf", up: "more" } },
  stairsPf: { nav: { right: "landing", left: "stairsParts", up: "more" } },
  stairsParts: { nav: { right: "stairsPf", up: "more" } },
  more: { nav: { down: "landing", left: "stairsParts", right: "linear" } },
};

// The parts tower: the way down, room 1, room 2.
const PARTS_FLOOR_NODES = {
  entrance: { nav: { left: "partsPoly" } },
  partsPoly: { nav: { right: "entrance", left: "partsLn" } },
  partsLn: { nav: { right: "partsPoly" } },
};

// The places of a line in walking order. On the ground floor both stairs
// and the side room are as far along as the landing (past room 2).
const LINE_PATHS = {
  ground: ["entrance", "basic", "linear", "landing", "stairsPf"],
  parts: ["entrance", "partsPoly", "partsLn"],
};
const linePath = () => LINE_PATHS[currentPlace()];
const pathIndex = (id) => linePath().indexOf(id === "more" || id === "stairsParts" ? "stairsPf" : id);

const RATIONAL_FLOOR_NODES = {
  entrance: { area: "lower", at: "top", nav: { up: "division" } },
  division: { area: "lower", at: "top", nav: { up: "pf1", down: "entrance" } },
  repeated: { area: "lower", at: "bottom", nav: { left: "pf1", down: "division" } },
  pf1: { area: "lower", at: "bottom", nav: { right: "repeated", left: "irreducible", down: "division" } },
  irreducible: { area: "lower", at: "bottom", nav: { right: "pf1", left: "gate", down: "division" } },
  gate: { area: "gate", at: "bottom", dy: 13, nav: { right: "irreducible", up: "trophy", down: "irreducible" } },
  trophy: { area: "upper", at: "bottom", nav: { right: "nonmonic", down: "gate" } },
  nonmonic: { area: "upper", at: "bottom", nav: { right: "review", left: "trophy", down: "gate" } },
  review: { area: "upper", at: "bottom", nav: { left: "nonmonic", down: "gate" } },
};

const PLACE_NODES = { ground: BASIC_FLOOR_NODES, pf: RATIONAL_FLOOR_NODES, parts: PARTS_FLOOR_NODES };
const mapNodes = () => PLACE_NODES[currentPlace()];
const onLine = () => isLinearPlace(currentPlace());

const markerNode = () => (mapNodes()[store.lastRoom] ? store.lastRoom : "entrance");
let markerBusy = false;

function nodeEl(id) {
  return ROOM_BY_ID[id] ? towerEl.querySelector(`[data-room="${id}"]`) : towerEl.querySelector(`[data-node="${id}"]`);
}

// The line's halls are showing (laptops and tablets; not the phone layout).
const hallsShown = () => {
  const hall = towerEl.querySelector(".hall");
  return !!(hall && hall.offsetWidth);
};

// A point relative to the floor grid.
function nodePoint(id) {
  const grid = towerEl.querySelector(".floor-grid").getBoundingClientRect();
  if (onLine()) {
    if (STAIRS_PLACE[id] && hallsShown()) {
      // On the landing, at the foot of the stairs.
      const s = nodeEl(id).querySelector(".stairs-steps").getBoundingClientRect();
      return { x: s.left + s.width / 2 - grid.left, y: s.bottom + 6 - grid.top };
    }
    // A room's spot is inside it, on the strip of floor at its foot (under
    // its progress); so the marker is already in the room when a barred exit
    // stops it.
    if (ROOM_BY_ID[id] && hallsShown()) {
      const r = nodeEl(id).getBoundingClientRect();
      return { x: r.left + r.width / 2 - grid.left, y: r.bottom - 22 - grid.top };
    }
    // The entrance's spot is its threshold.
    const hall = towerEl.querySelector(`.hall[data-spot="${id === "entrance" ? linePath()[1] : id}"]`);
    if (hall && hall.offsetWidth) {
      const h = hall.getBoundingClientRect();
      return { x: (id === "entrance" ? h.right - 6 : h.left + h.width / 2) - grid.left, y: h.top + h.height / 2 - grid.top };
    }
    const r = nodeEl(id).getBoundingClientRect(); // phone layout: no halls
    return { x: r.left + r.width / 2 - grid.left, y: r.bottom - grid.top };
  }
  const r = nodeEl(id).getBoundingClientRect();
  const at = mapNodes()[id].at;
  const y = at === "top" ? r.top : at === "bottom" ? r.bottom : r.top + r.height / 2;
  return { x: r.left + r.width / 2 - grid.left, y: y - grid.top + (mapNodes()[id].dy || 0) };
}

function corridorY(which) {
  const grid = towerEl.querySelector(".floor-grid").getBoundingClientRect();
  const r = towerEl.querySelector(`.corridor.${which}`).getBoundingClientRect();
  return r.top + r.height / 2 - grid.top;
}

const dropRepeats = (pts) => pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1);

// The way between two places: out into the corridor, along it, and in -
// through the gate when going between the lower floor and the upper area.
function routePoints(from, to) {
  const a = nodePoint(from);
  const b = nodePoint(to);
  if (onLine()) {
    // Along the line, through the rooms; off it (the side hall, the
    // landing's stairs) straight up or down from the line.
    if (!hallsShown()) return [a, b];
    const y = nodePoint(linePath()[1]).y;
    return dropRepeats([a, { x: a.x, y }, { x: b.x, y }, b]);
  }
  if (getComputedStyle(towerEl.querySelector(".doorway")).display === "none") return [a, b]; // phone layout
  const fa = mapNodes()[from].area;
  const ta = mapNodes()[to].area;
  const lowY = corridorY("main");
  if (fa === "lower" && ta === "lower") return dropRepeats([a, { x: a.x, y: lowY }, { x: b.x, y: lowY }, b]);
  const upY = corridorY("upper");
  const g = nodePoint("gate");
  const pts = [a];
  if (fa === "lower") pts.push({ x: a.x, y: lowY });
  if (fa === "upper") pts.push({ x: a.x, y: upY });
  if (fa === "gate") pts.push({ x: a.x, y: ta === "upper" ? upY : lowY });
  if ((fa === "lower" && ta === "upper") || (fa === "upper" && ta === "lower")) {
    const [y1, y2] = fa === "lower" ? [lowY, upY] : [upY, lowY];
    pts.push({ x: g.x, y: y1 }, { x: g.x, y: y2 });
  }
  if (ta === "gate") pts.push({ x: b.x, y: fa === "upper" ? upY : lowY });
  if (ta === "lower") pts.push({ x: b.x, y: lowY });
  if (ta === "upper") pts.push({ x: b.x, y: upY });
  pts.push(b);
  return dropRepeats(pts);
}

const markerTransform = (p) => `translate(${p.x}px, ${p.y}px)`;

function markerHintText(id) {
  if (id === "gate") return wingOpen() ? "" : "שער ↵";
  if (id === "trophy") return "";
  if (STAIRS_PLACE[id]) return "עולים ↵";
  if (id === "entrance" && currentPlace() !== "ground") return "יורדים ↵";
  if (!ROOM_BY_ID[id]) return "";
  if (!onLine() && isLocked(ROOM_BY_ID[id])) return "";
  return "לתרגילים ↵";
}

function placeMarker(id, save = true) {
  const marker = towerEl.querySelector(".map-marker");
  if (!marker || mapView.hidden || !nodeEl(id)) return;
  marker.style.transform = markerTransform(nodePoint(id));
  marker.querySelector(".marker-hint").textContent = markerHintText(id);
  towerEl.querySelectorAll(".marker-here").forEach((el) => el.classList.remove("marker-here"));
  nodeEl(id).classList.add("marker-here");
  if (save && store.lastRoom !== id) {
    store.lastRoom = id;
    saveStore();
  }
}

// The first-visit tip goes away for good once the student has moved the
// marker (or closed it).
function dismissMapTip() {
  if (store.mapTipSeen) return;
  store.mapTipSeen = true;
  saveStore();
  const tip = towerEl.querySelector(".map-tip");
  if (!tip) return;
  tip.classList.add("leaving");
  setTimeout(() => tip.remove(), reducedMotion() ? 0 : 350);
}

towerEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-tip-close]")) dismissMapTip();
});

// Walk to a place; resolves when the marker has arrived.
function walkTo(id) {
  dismissMapTip();
  const from = markerNode();
  const marker = towerEl.querySelector(".map-marker");
  if (from === id || !marker) {
    placeMarker(id);
    return Promise.resolve();
  }
  const pts = routePoints(from, id);
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const total = lens.reduce((s, l) => s + l, 0) || 1;
  let acc = 0;
  const frames = pts.map((p, i) => {
    if (i > 0) acc += lens[i - 1];
    return { transform: markerTransform(p), offset: acc / total };
  });
  marker.querySelector(".marker-hint").textContent = "";
  markerBusy = true;
  marker.classList.add("walking");
  const duration = Math.min(700, Math.max(180, total * 1.1));
  sfx("steps", duration);
  const anim = marker.animate(frames, { duration, easing: "ease-in-out" });
  return anim.finished.catch(() => {}).then(() => {
    markerBusy = false;
    marker.classList.remove("walking");
    placeMarker(id);
  });
}

// Step from the marker's place in a direction, if there's a way there.
function stepMarker(dir) {
  const here = markerNode();
  const to = mapNodes()[here].nav[dir];
  if (!to) return;
  // On a line, going on from a room whose exit is barred asks first.
  if (onLine() && pathIndex(to) > pathIndex(here) && exitBlocked(here)) {
    openExitDialog(here, () => walkTo(to));
    return;
  }
  if (mapNodes()[to].area === "upper" && !wingOpen()) {
    if (here === "gate") openGateDialog();
    else walkTo("gate");
    return;
  }
  walkTo(to);
}

// On a line, a click: walk towards a place - but not out of a room whose
// exit is barred; the marker stops in that room and asks whether to open the
// exit (then walks on). A place reached is entered.
function lineGo(id) {
  const path = linePath();
  const a = pathIndex(markerNode());
  const b = pathIndex(id);
  let stop = id;
  for (let k = Math.max(a, 0); k < b; k++) {
    if (exitBlocked(path[k])) {
      stop = path[k];
      break;
    }
  }
  walkTo(stop).then(() => {
    if (stop !== id) openExitDialog(stop, () => lineGo(id));
    else if (STAIRS_PLACE[stop]) goUpstairs(stop);
    else if (ROOM_BY_ID[stop]) zoomIntoRoom(stop).then(() => goToRoom(stop));
  });
}

// Enter: go into the room the marker stands at (or try the gate).
function activateMarker() {
  const id = markerNode();
  if (id === "gate") {
    if (!wingOpen()) openGateDialog();
    return;
  }
  if (id === "trophy") {
    if (!wingOpen()) openGateDialog(); // open, it is empty for now
    return;
  }
  if (STAIRS_PLACE[id]) {
    if (stairsOpen()) goUpstairs(id);
    else openExitDialog("linear", () => goUpstairs(id));
    return;
  }
  if (id === "entrance") {
    if (currentPlace() !== "ground") goDownstairs();
    return;
  }
  const room = ROOM_BY_ID[id];
  if (!room) return;
  if (!onLine() && isLocked(room)) openLockedRoomDialog(room);
  else zoomIntoRoom(id).then(() => goToRoom(id)); // on a line, going in is always free
}

const ARROW_DIRS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

document.addEventListener("keydown", (e) => {
  if (mapView.hidden || !lockDialog.hidden || markerBusy) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (ARROW_DIRS[e.key]) {
    e.preventDefault();
    stepMarker(ARROW_DIRS[e.key]);
  } else if (e.key === "Enter" && !e.target.closest("button, [data-room], .passage, .stairs")) {
    e.preventDefault();
    activateMarker();
  }
});

window.addEventListener("resize", () => {
  if (!mapView.hidden && towerEl.querySelector(".map-marker")) placeMarker(markerNode(), false);
});

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
  if (e.target.closest("[data-open-wing]")) {
    e.stopPropagation();
    openGateDialog();
    return;
  }
  if (markerBusy) return;
  const card = e.target.closest("[data-room]");
  if (card) {
    const room = ROOM_BY_ID[card.dataset.room];
    if (onLine()) lineGo(room.id);
    else if (isLocked(room)) openLockedRoomDialog(room);
    else walkTo(room.id).then(() => zoomIntoRoom(room.id)).then(() => goToRoom(room.id));
    return;
  }
  const stairs = e.target.closest(".stairs[data-node]");
  if (stairs) {
    lineGo(stairs.dataset.node);
    return;
  }
  const gate = e.target.closest('[data-node="gate"]');
  if (gate) {
    walkTo("gate").then(() => {
      if (!wingOpen()) openGateDialog();
    });
    return;
  }
  if (e.target.closest('[data-node="trophy"]')) {
    if (!wingOpen()) openGateDialog();
    else walkTo("trophy"); // empty for now: the pawn just walks there
    return;
  }
  if (e.target.closest('[data-node="entrance"]')) {
    // A tower's way in is the way back down to the ground floor.
    walkTo("entrance").then(() => {
      if (currentPlace() !== "ground") goDownstairs();
    });
  }
});

towerEl.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches('[data-room], [data-node="trophy"], .stairs[data-node]')) {
    e.preventDefault();
    e.target.click();
  }
});

// --- "open anyway" dialog ---------------------------------------------------

// One gate for the whole upper wing, not one per room.
const lockDialog = $("lockDialog");

// What "open anyway" opens: the upper area of the partial-fractions tower,
// a room, or the stairs to the towers - and where to go then (from the floor
// panel: to the tower just opened).
let lockDialogFor = "wing";
let lockDialogThen = null;

// One dialog for every lock: a title, a text that names the rooms to do
// first, "not now" (back to the map, where the marker stands), and (when the
// lock may be forced) "open anyway". It never sends the student anywhere.
function showLockDialog({ title, html, anyway, then = null }) {
  lockDialogThen = then;
  $("lockDialogTitle").textContent = title;
  $("lockDialogText").innerHTML = html;
  $("lockBackBtn").textContent = "לא עכשיו";
  $("lockAnywayBtn").hidden = !anyway;
  lockDialogFor = anyway || "wing";
  lockDialog.hidden = false;
  $("lockBackBtn").focus();
}

function openGateDialog() {
  const missing = CORE_IDS.filter((id) => !isConquered(id));
  // Room numbers, not names; only the rooms still to do.
  const nums = missing.map((id) => ROOM_BY_ID[id].num).join(", ");
  showLockDialog({
    title: "לא מומלץ עדיין",
    html:
      `האזור העליון בנוי על שלושת החדרים במסדרון הראשון. ` +
      `מומלץ לעבור קודם את ${missing.length > 1 ? "חדרים" : "חדר"} <bdi dir="ltr">${nums}</bdi> - אבל אפשר לפתוח אותו כבר עכשיו.`,
    anyway: "wing",
  });
}

// On a line: a room opens after the one before it - or anyway.
function openLockedRoomDialog(room) {
  if (!isLinearPlace(room.place)) return openGateDialog();
  const before = ROOM_BY_ID[missingRequirements(room)[0]];
  showLockDialog({
    title: "לא מומלץ עדיין",
    html: `מומלץ לעבור קודם את חדר <bdi dir="ltr">${before.num}</bdi>, שהחדר הזה בנוי עליו - אבל אפשר לפתוח אותו כבר עכשיו.`,
    anyway: room.id,
  });
}

// On a line: the way out of a room not won yet is barred - open it anyway?
// `then` carries on where the student was going.
function openExitDialog(id, then) {
  showLockDialog({
    title: "היציאה חסומה",
    html:
      `עוד לא סיימתם את "${ROOM_BY_ID[id].title}". ` +
      `מומלץ לסיים אותו לפני שממשיכים לחדר הבא - אבל אפשר לפתוח את היציאה כבר עכשיו.`,
    anyway: `exit:${id}`,
    then,
  });
}

// The stairs to the towers (from the floor panel): past room 2, or anyway.
function openStairsDialog(then) {
  const missing = FLOOR1_IDS.filter((id) => !isConquered(id));
  const nums = missing.map((id) => ROOM_BY_ID[id].num).join(", ");
  showLockDialog({
    title: "לא מומלץ עדיין",
    html:
      `המדרגות למגדלים נפתחות אחרי חדר 2. מומלץ לעבור קודם את ${missing.length > 1 ? "חדרים" : "חדר"} <bdi dir="ltr">${nums}</bdi>` +
      ` - אבל אפשר לפתוח אותן כבר עכשיו.`,
    anyway: "stairs",
    then,
  });
}

function closeLockDialog() {
  lockDialog.hidden = true;
}

$("lockBackBtn").addEventListener("click", closeLockDialog);
$("lockAnywayBtn").addEventListener("click", () => {
  closeLockDialog();
  const exit = lockDialogFor === "stairs" ? "linear" : lockDialogFor.startsWith("exit:") ? lockDialogFor.slice(5) : null;
  if (exit) store.openedExits = { ...store.openedExits, [exit]: true };
  else if (ROOM_BY_ID[lockDialogFor]) store.openedRooms = { ...store.openedRooms, [lockDialogFor]: true };
  else store.wingOpen = true;
  sfx(exit ? "grate" : "gate");
  saveStore();
  renderMap(); // the fog lifts, or the stairs open
  if (lockDialogThen) lockDialogThen();
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

// A fresh exercise for node i of a room. Review nodes take their type from
// the run's plan, so a new exercise after "Show solution" keeps the type.
function makeProblem(room, i, run) {
  const node = room.nodes[i];
  if (node.gen === "review") return generateReviewExercise(run.plan[i]);
  return GENERATORS[node.gen]();
}

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
  store.lastRoom = id;
  store.place = room.place; // back out onto this room's floor
  saveStore();
  if (!rec.run) {
    rec.run = { node: 0, score: START_SCORE };
    if (room.kind === "review") rec.run.plan = drawReviewPlan(room.nodes.length);
    rec.run.problem = makeProblem(room, 0, rec.run);
    saveStore();
  }
  view.room = room;
  view.node = rec.run.node;
  view.problem = rec.run.problem;
  view.pending = null;
  $("roomName").textContent = room.title;
  $("roomEn").textContent = room.en;
  $("roomLabel").textContent = room.label || "";
  $("roomLabel").hidden = !room.label;
  // The header is a patch of this room's floor, framed like its card on the map.
  $("roomHeader").className = `room-header room-${room.kind}`;
  roomView.classList.toggle("in-ext-room", room.kind === "ext");
  buildPath(room);
  showView(roomView);
  updatePath(false);
  renderScore(rec.run.score);
  removeOutgoingClone();
  showProblem({ animate: false });
}

// A correct answer: one small gold spark rises from the answer card to this
// exercise's node on the path, and the node fills in as it lands.
function sparkToNode(i) {
  const node = pathEl.querySelectorAll(".pnode")[i];
  if (!node) return Promise.resolve();
  const land = () => {
    node.classList.remove("current");
    node.classList.add("done", "just-done");
    node.querySelector("span").textContent = "✓";
  };
  if (reducedMotion()) {
    land();
    return Promise.resolve();
  }
  const a = $("answerCard").getBoundingClientRect();
  const b = node.getBoundingClientRect();
  const x0 = a.left + a.width / 2;
  const y0 = a.top + 14;
  const x1 = b.left + b.width / 2;
  const y1 = b.top + b.height / 2;
  const at = (x, y, s = 1) => `translate(${x}px, ${y}px) scale(${s})`;
  // A gentle arc: out sideways a little on the way up.
  const mx = (x0 + x1) / 2 + (x1 > x0 ? -50 : 50);
  const my = (y0 + y1) / 2;
  const frames = (o) => [
    { transform: at(x0, y0, 0.4), opacity: 0 },
    { transform: at(x0, y0 - 10, 1), opacity: o, offset: 0.15 },
    { transform: at(mx, my, 1), opacity: o, offset: 0.55 },
    { transform: at(x1, y1, 0.75), opacity: o },
  ];
  // The spark, plus two fainter copies just behind it as a short tail.
  const els = [];
  const parts = [1, 0.45, 0.2].map((o, k) => {
    const el = document.createElement("div");
    el.className = k ? "spark spark-tail" : "spark";
    document.body.appendChild(el);
    els.push(el);
    return el.animate(frames(o), { duration: 850, delay: k * 45, easing: "cubic-bezier(0.45, 0, 0.3, 1)", fill: "backwards" });
  });
  return parts[0].finished.catch(() => {}).then(() => {
    land();
    return Promise.all(parts.map((a) => a.finished.catch(() => {})));
  }).then(() => els.forEach((el) => el.remove()));
}

// "Room cleared": the last step is solved. The path lights up gold node by
// node, the boss last and biggest, before the victory screen comes in.
// Returns how long to hold the room on screen.
function celebratePath() {
  const nodes = pathEl.querySelectorAll(".pnode");
  if (reducedMotion()) return 700;
  nodes.forEach((el, i) => (el.style.animationDelay = `${0.45 + i * 0.18}s`));
  roomView.classList.add("room-cleared");
  return 450 + nodes.length * 180 + 1300;
}

function buildPath(room) {
  roomView.classList.remove("room-cleared");
  pathEl.innerHTML =
    room.nodes
      .map((n, i) => `<div class="pnode${n.boss ? " boss" : ""}" data-i="${i}"><span>${n.boss ? "★" : i + 1}</span></div>`)
      .join('<div class="pconn"><div class="pconn-fill"></div></div>') +
    '<div class="pawn" id="pawn" aria-hidden="true"></div>';
}

function updatePath(animate) {
  syncRestart();
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
    ? `תרגיל ${view.node + 1} מתוך ${view.room.nodes.length}${node.boss ? " · אינטגרל בוס" : ""}`
    : "ניצחון! עברתם את החדר";
  roomView.classList.toggle("boss-node", !!(node && node.boss));
}

function placePawn(animate) {
  const pawn = $("pawn");
  const i = Math.min(view.node, view.room.nodes.length - 1);
  const target = pathEl.querySelectorAll(".pnode")[i];
  if (!pawn || !target) return;
  pawn.classList.toggle("over-boss", !!view.room.nodes[i].boss);
  pawn.style.transition = animate ? "" : "none";
  pawn.style.left = `${target.offsetLeft + target.offsetWidth / 2}px`;
  if (!animate) void pawn.offsetWidth;
  pawn.style.transition = "";
}

window.addEventListener("resize", () => {
  if (!roomView.hidden) placePawn(false);
});

// "↺ מחדש": start the room over with a full score. Shown once the student
// has moved on or lost points; asks once more before throwing the run away.
const restartBtn = $("restartBtn");
let restartTimer = null;

function syncRestart() {
  const rec = view.room && roomRecord(view.room.id);
  restartBtn.hidden = !(rec && rec.run && (rec.run.node > 0 || rec.run.score < START_SCORE));
  resetRestartBtn();
}

// A circular arrow back to the start.
const RESTART_ICON = `<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5v4h4"/></svg>`;

function resetRestartBtn() {
  clearTimeout(restartTimer);
  restartBtn.classList.remove("confirming");
  restartBtn.innerHTML = `${RESTART_ICON}<span>מחדש</span>`;
}

restartBtn.addEventListener("click", () => {
  if (!restartBtn.classList.contains("confirming")) {
    restartBtn.classList.add("confirming");
    restartBtn.innerHTML = `${RESTART_ICON}<span>לחצו שוב</span>`;
    restartTimer = setTimeout(resetRestartBtn, 4000);
    return;
  }
  resetRestartBtn();
  const rec = roomRecord(view.room.id);
  rec.run = null; // the best score and the victories stay
  saveStore();
  enterRoom(view.room.id);
});

function renderScore(score, delta) {
  syncRestart();
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

function slideInCurrentCard(arriving) {
  const node = view.room.nodes[view.node];
  if (arriving && node && node.boss && !reducedMotion()) {
    bossEntrance();
    return;
  }
  problemCardEl.classList.add("enter-start");
  void problemCardEl.offsetWidth;
  problemCardEl.classList.remove("enter-start");
}

// The boss: a short, quiet beat instead of the usual slide. The card settles
// down into place a moment later, its amber bar draws across, and the two
// torches on the room's walls flare once.
function bossEntrance() {
  sfx("boss");
  problemCardEl.classList.remove("boss-enter");
  roomView.classList.remove("boss-entering");
  void problemCardEl.offsetWidth;
  problemCardEl.classList.add("boss-enter");
  roomView.classList.add("boss-entering");
  setTimeout(() => {
    problemCardEl.classList.remove("boss-enter");
    roomView.classList.remove("boss-entering");
  }, 1300);
}

// arriving: the student just stepped onto this node (not a fresh exercise
// for the same node after "show solution").
function showProblem({ animate, arriving = false }) {
  if (animate && problemField.value) slideOutCurrentCard();
  problemField.value = problemLatex(view.problem);
  if (animate) slideInCurrentCard(arriving);
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
  setAnswerMenu(false);
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
    setFeedback(result.reason === "t"
      ? "נראה שהתשובה עדיין במשתנה t - צריך להחזיר את t ל-x בסוף. (לא ירדו נקודות.)"
      : "לא הצלחנו לקרוא את התשובה - זה לא נחשב טעות, לא ירדו נקודות. נסו לכתוב אותה בצורה פשוטה יותר.", "unreadable");
    return;
  }

  if (result.status === "wrong") {
    rec.run.score = Math.max(0, rec.run.score - WRONG_COST);
    saveStore();
    renderScore(rec.run.score, WRONG_COST);
    setAnswerState("incorrect");
    sfx("wrong");
    if (result.nearMiss) setFeedback(`${NEAR_MISS_TEXT[result.nearMiss]} ${ltr(`(−${WRONG_COST})`)}`, "near");
    else setFeedback(`לא נכון - הנגזרת של התשובה לא שווה לפונקציה שבאינטגרל. ${ltr(`(−${WRONG_COST})`)}`, "wrong");
    return;
  }

  // Correct: the node is cleared. Save the step forward right away.
  view.resolved = true;
  setAnswerState("correct");
  sfx("correct");
  setFeedback("");
  checkBtn.disabled = true;
  solutionBtn.hidden = true;
  const nextNode = view.node + 1;
  if (nextNode >= view.room.nodes.length) {
    const score = rec.run.score;
    const prevBest = rec.best;
    // The floor as it was, so the victory screen can say what this win changed.
    const before = { firstWin: rec.wins === 0, medals: allMedalStates(), exitOpen: exitOpen(view.room.id), wing: wingOpen(), stairs: stairsOpen() };
    rec.best = prevBest === null ? score : Math.max(prevBest, score);
    rec.wins += 1;
    rec.run = null;
    saveStore();
    const room = view.room;
    sparkToNode(view.node).then(() => {
      view.node = nextNode;
      updatePath(true);
      const wait = celebratePath();
      setTimeout(() => showConquest(room, { score, prevBest, wins: rec.wins, before }), wait);
    });
    return;
  }
  sparkToNode(view.node);
  rec.run.node = nextNode;
  rec.run.problem = makeProblem(view.room, nextNode, rec.run);
  saveStore();
  view.pending = { node: nextNode, problem: rec.run.problem, advance: true };
  nextBtn.textContent = view.room.nodes[nextNode].boss ? "לאינטגרל הבוס ←" : "המשך ←";
  nextBtn.hidden = false;
  nextBtn.classList.add("ready");
  nextBtn.focus();
});

solutionBtn.addEventListener("click", () => {
  if (view.resolved) return;
  const rec = roomRecord(view.room.id);
  view.resolved = true;
  rec.run.score = Math.max(0, rec.run.score - SOLUTION_COST);
  rec.run.problem = makeProblem(view.room, view.node, rec.run); // same node, fresh exercise
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
  showProblem({ animate: true, arriving: advance });
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

// The field's ▾ symbol menu (roots, fraction, power, e, ln, trig), as in
// Calcapp. mousedown is cancelled so the field keeps focus; insert() needs
// it active.
const answerMenuBtn = $("answerMenuBtn");
const answerMenu = $("answerMenu");

function setAnswerMenu(open) {
  answerMenu.hidden = !open;
  answerMenuBtn.setAttribute("aria-expanded", String(open));
}

$("answerFieldWrap").addEventListener("mousedown", (e) => {
  if (e.target.closest("#answerMenuBtn, .field-menu-item")) e.preventDefault();
});
answerMenuBtn.addEventListener("click", () => setAnswerMenu(answerMenu.hidden));
answerMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".field-menu-item");
  if (!item || view.resolved) return;
  answerField.focus();
  answerField.insert(item.dataset.insert, { selectionMode: "placeholder" });
  answerField.dispatchEvent(new Event("input", { bubbles: true }));
  setAnswerMenu(false);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#answerFieldWrap")) setAnswerMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !answerMenu.hidden) setAnswerMenu(false);
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
      <text class="seal-arc"><textPath href="#sealArc" startOffset="50%" text-anchor="middle">★ VICTORY ★</textPath></text>
      <text x="100" y="128" text-anchor="middle" class="seal-score">${score}</text>
      <text x="100" y="156" text-anchor="middle" class="seal-sub">מתוך 10</text>
    </svg>`;
}

// A wall torch: iron plate and ring, a wooden handle with a tarred head, and
// a three-layer flame. Gradient ids are unique per torch - an id first
// defined inside a hidden view would not paint in a visible one.
let torchCount = 0;
function torchHtml(side) {
  const n = ++torchCount;
  return `
    <div class="torch torch-${side}" aria-hidden="true">
      <div class="torch-fire">
        <svg class="torch-flame" viewBox="0 0 40 48">
          <defs><linearGradient id="tfl${n}" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stop-color="#d9480f"/><stop offset="0.6" stop-color="#ff8c1a"/><stop offset="1" stop-color="#ffb347" stop-opacity="0.85"/>
          </linearGradient></defs>
          <path fill="url(#tfl${n})" d="M20 2C27 14 36 22 34 34C32 43 26 47 20 47C14 47 8 43 6 34C4 22 13 14 20 2Z"/>
          <path fill="#ffc23a" d="M20 14C25 22 30 28 28 36C27 42 23 45 20 45C17 45 13 42 12 36C10 28 15 22 20 14Z"/>
          <path fill="#fff4c8" d="M20 26C23 31 25 35 24 39C23 42 21 43 20 43C19 43 17 42 16 39C15 35 17 31 20 26Z"/>
        </svg>
      </div>
      <svg class="torch-mount" viewBox="0 0 34 50">
        <defs><linearGradient id="twd${n}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#5e3b1f"/><stop offset="0.45" stop-color="#9a6a3c"/><stop offset="1" stop-color="#5e3b1f"/>
        </linearGradient></defs>
        <rect x="10" y="26" width="14" height="22" rx="2" fill="#3b342c" stroke="#1e1914" stroke-width="1.2"/>
        <circle cx="13" cy="30" r="1.1" fill="#8a7a5e"/><circle cx="21" cy="30" r="1.1" fill="#8a7a5e"/>
        <circle cx="13" cy="44" r="1.1" fill="#8a7a5e"/><circle cx="21" cy="44" r="1.1" fill="#8a7a5e"/>
        <path d="M11 10H23L20 48H14Z" fill="url(#twd${n})" stroke="#3e2714" stroke-width="1"/>
        <rect x="8" y="28" width="18" height="5" rx="2" fill="#2b241c" stroke="#6b5f4f" stroke-width="1"/>
        <path d="M5 1H29L25 11H9Z" fill="#4a3a2a" stroke="#2a2016" stroke-width="1"/>
        <path d="M7 4.5H27M8.5 8H25.5" stroke="#2a2016" stroke-width="1"/>
      </svg>
    </div>`;
}

$("roomHeader").insertAdjacentHTML("afterbegin", torchHtml("l") + torchHtml("r"));

// A small stone arch with open doors: "the gate opened".
const GATE_ICON = `
  <svg class="news-gate" viewBox="0 0 30 30" aria-hidden="true">
    <path d="M3 29V14a12 12 0 0 1 24 0v15z" fill="#2b241c" stroke="#8d806a" stroke-width="2.5"/>
    <path d="M6 29V15l4 2v12zM24 29V15l-4 2v12z" fill="#7a5230"/>
    <path d="M12 29V18a3 3 0 0 1 6 0v11z" fill="#f2c94c" opacity="0.8"/>
  </svg>`;

// What this win changed: a lock, the gate, a medal.
function victoryNews(room, before) {
  const news = [];
  if (isLinearPlace(room.place)) {
    if (hasExit(room.id) && !before.exitOpen) {
      news.push({
        icon: `<span class="news-grate">${GRATE_SVG}</span>`,
        text: room.id === "linear" ? "היציאה נפתחה - אל המדרגות למגדלים" : "היציאה מהחדר נפתחה",
      });
    }
  } else {
    if (before.firstWin && CORE_IDS.includes(room.id)) {
      news.push({ icon: padlockSvg(room.num, true), text: `מנעול ${room.num} נפתח` });
    }
    if (!before.wing && wingOpen()) news.push({ icon: GATE_ICON, text: "השער לאזור העליון נפתח" });
  }
  allMedalStates().forEach((m, i) => {
    const b = before.medals[i];
    if (m.earned && !b.earned) {
      news.push({ icon: medalSvg(m), text: `קיבלתם מדליה · ממוצע <b>${m.avg}</b>` });
    } else if (m.earned) {
      if ((m.gold && !b.gold) || (m.star && !b.star)) news.push({ icon: medalSvg(m), text: "המדליה השתדרגה" });
      else if (m.avg !== b.avg) {
        news.push({ icon: medalSvg(m), text: `ממוצע המדליה עלה: <bdi dir="ltr">${b.avg} → ${m.avg}</bdi>` });
      }
    }
  });
  return news;
}

// Set by a first win in a core room; the map opens that lock (and the gate,
// if it was the last one) when the student walks back out.
let pendingUnlock = null;

function showConquest(room, { score, prevBest, wins, before }) {
  justConquered = room.id;
  justLit = before.firstWin ? room.id : null;
  let bestLine;
  if (prevBest === null) bestLine = `ציון ראשון בחדר`;
  else if (score > prevBest) bestLine = `שיא חדש! <span class="dim">(קודם: ${prevBest})</span>`;
  else bestLine = `השיא שלכם: <b>${prevBest}</b>`;

  sfx("win", score === 10);
  const news = victoryNews(room, before);
  if (before.firstWin && CORE_IDS.includes(room.id)) {
    pendingUnlock = { lock: room.num, gate: !before.wing && wingOpen() };
  }
  if (isLinearPlace(room.place) && hasExit(room.id) && !before.exitOpen) pendingUnlock = { exit: room.id };

  // Where to go next.
  const coreLeft = CORE_IDS.filter((id) => !isConquered(id));
  let next = "";
  const floor1Left = FLOOR1_IDS.filter((id) => !isConquered(id));
  const partsLeft = PARTS_IDS.filter((id) => !isConquered(id));
  if (room.place === "ground") {
    if (floor1Left.length) next = `החדר הבא: "${ROOM_BY_ID[floor1Left[0]].title}"`;
    else if (!isConquered("more")) next = `אפשר גם "${ROOM_BY_ID.more.title}" (הרחבה), או לעלות לאחד המגדלים`;
  } else if (room.place === "parts") {
    if (partsLeft.length) next = `החדר הבא: "${ROOM_BY_ID[partsLeft[0]].title}"`;
    else if (!before.medals.find((m) => m.id === "parts").earned) next = "המדליה מחכה בחדר המדליות";
  }
  else if (coreLeft.length) next = `נשארו במסדרון: ${quotedTitles(coreLeft)}`;
  else if (!before.medals.find((m) => m.id === "pf").earned) next = "המדליה מחכה בחדר המדליות";
  else if (room.id === "review" && !isConquered("nonmonic")) next = "אפשר גם \"מכנה עם מקדם מוביל\" (טכניקה גבוהה)";

  const newsHtml = news.length
    ? `<ul class="victory-news">${news
        .map((n, i) => `<li style="animation-delay:${1.5 + i * 0.35}s"><span class="news-icon">${n.icon}</span><span>${n.text}</span></li>`)
        .join("")}</ul>`
    : "";

  $("conquest").className = `conquest tier-${scoreTier(score)}`;
  $("conquest").innerHTML = `
    ${torchHtml("l")}${torchHtml("r")}
    <div class="seal-wrap">${sealSvg(score)}</div>
    <h2>ניצחון! עברתם את החדר</h2>
    <div class="conquest-room"><span class="victory-plaque">${room.title}</span><div dir="ltr" class="conquest-room-en">${room.en}</div></div>
    <div class="conquest-dots">${room.nodes
      .map((n, i) => `<span class="mini-node done${n.boss ? " boss" : ""}" style="animation-delay:${0.9 + i * 0.15}s"></span>`)
      .join("")}</div>
    ${score === 10 ? '<div class="perfect">★ מושלם - בלי אף טעות</div>' : ""}
    <div class="conquest-best">${bestLine} · <span class="dim">ניצחונות בחדר: ${wins}</span></div>
    ${newsHtml}
    <div class="victory-end" style="animation-delay:${1.3 + news.length * 0.35}s">
      <button type="button" id="toTowerBtn" class="primary-btn">חזרה למפה</button>
      ${next ? `<div class="conquest-next">${next}</div>` : ""}
    </div>`;
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
  } else if (location.hash === "#/castle") {
    clearTimeout(castleIntroTimer);
    castleView.classList.remove("intro");
    renderCastleView();
    showView(castleView);
  } else if (location.hash === "#/medals") {
    renderMedalView();
    showView(medalView);
  } else {
    const fromRoom = lastView === roomView || lastView === conquestView;
    renderMap();
    renderMedalsBtn();
    showView(mapView);
    if (fromRoom) zoomOutOfRoom(markerNode());
    else if (mapZoom) {
      mapZoom.cancel();
      mapZoom = null;
    }
    playUnlock();
  }
}

window.addEventListener("hashchange", route);
if (CASTLE_INTRO && (!location.hash || location.hash === "#/")) showCastleIntro();
else route();
// During the opening look at the castle, any key goes on to the map.
document.addEventListener("keydown", () => {
  if (castleView.classList.contains("intro") && !castleView.hidden) castleGo(null);
});

// Test hook for the preview only: ?debug exposes the exercise on screen.
// Test panel for the lecturer only (?test in the address): answer the current
// exercise right or wrong through the real check, and wipe all progress.
if (new URLSearchParams(location.search).has("test")) {
  const panel = document.createElement("div");
  panel.className = "test-panel";
  panel.innerHTML = `
    <b>בדיקות</b>
    <button type="button" data-t="right">✓ נכון</button>
    <button type="button" data-t="wrong">✗ טעות (−1)</button>
    <button type="button" data-t="reset">איפוס משחק</button>`;
  document.body.appendChild(panel);
  let wrongs = 0;
  panel.addEventListener("click", (e) => {
    const t = e.target.dataset.t;
    if (!t) return;
    if (t === "reset") {
      if (!confirm("למחוק את כל ההתקדמות ולהתחיל מההתחלה?")) return;
      try {
        localStorage.removeItem(STORE_KEY);
      } catch {
        // nothing saved to remove
      }
      location.hash = "";
      location.reload();
      return;
    }
    if (roomView.hidden || !view.problem) return;
    if (view.resolved) {
      if (!nextBtn.hidden) nextBtn.click(); // already right: go on
      return;
    }
    // A fresh wrong answer each time, so it is never the "same answer again".
    answerField.value = t === "right" ? antiderivativeLatex(view.problem) : `${++wrongs}x`;
    checkBtn.click();
  });
}

if (new URLSearchParams(location.search).has("debug")) {
  window.__intapp = {
    problem: () => view.problem,
    answer: () => antiderivativeLatex(view.problem),
    solution: () => solutionLatex(view.problem),
    check: (p, latex) => checkAnswer(p, latex),
    generators: GENERATORS,
    reviewExercise: generateReviewExercise,
    reviewPlan: drawReviewPlan,
    antiderivativeLatex,
    problemLatex,
    store: () => store,
  };
}
