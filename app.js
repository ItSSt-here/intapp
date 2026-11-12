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
  s = s.replace(/\\operatorname\{(ln|log|arctan)\}/g, "\\$1");
  s = s.replace(/\\tan\^\{-1\}|\\tan\^-1/g, "\\arctan");
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
    if (rest.startsWith("\\arctan")) { tokens.push({ t: "ATAN" }); i += 7; continue; }
    if (rest.startsWith("\\sqrt")) { tokens.push({ t: "SQRT" }); i += 5; continue; }
    if (rest.startsWith("\\ln")) { tokens.push({ t: "LN" }); i += 3; continue; }
    if (rest.startsWith("\\log")) { tokens.push({ t: "LN" }); i += 4; continue; }
    // MathLive doesn't always expand a typed "ln"/"log" into the \ln macro
    // (it may leave it as plain italic letters) - recognize the bare word too.
    if (rest.startsWith("arctan")) { tokens.push({ t: "ATAN" }); i += 6; continue; }
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
    return ["NUM", "VAR", "CONST", "LPAREN", "LBRACE", "PIPE_OPEN", "LN", "ATAN", "SQRT", "FRAC"].includes(tok.t);
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
    if (tok.t === "ATAN") {
      next();
      const arg = parseUnary();
      return (x) => Math.atan(arg(x));
    }
    if (tok.t === "SQRT") {
      next();
      const arg = parseUnary(); // \sqrt{...}: the braces parse as a group
      return (x) => Math.sqrt(arg(x));
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
  if (p.kind === "nmr") return nmrIntegrandFn(p);
  if (p.kind === "nmi") return nmiIntegrandFn(p);
  if (p.kind === "irr") return irrIntegrandFn(p);
  if (p.kind === "rep") return repIntegrandFn(p);
  return (x) => polyEval(p.Q, x) + p.terms.reduce((s, t) => s + (t.A * t.m) / (t.m * x - t.n), 0);
}

function sampleZones(p) {
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
  if (/t/.test(latex.replace(/\\[a-zA-Z]+/g, "").replace(/arctan|tan|sqrt/g, ""))) {
    return { status: "unreadable", reason: "t" };
  }
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
// The tower: floor 1
// ---------------------------------------------------------------------------

const ROOMS = [
  {
    id: "division",
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

// The rooms this one builds on that aren't conquered yet.
function missingRequirements(room) {
  return [].concat(room.requires || []).filter((id) => !isConquered(id));
}

const quotedTitles = (ids) => ids.map((id) => `"${ROOM_BY_ID[id].title}"`).join(", ");

// The upper wing (review, non-monic, the topic medal) opens once the three core
// rooms are conquered - or earlier, if the student opens its gate anyway.
const CORE_IDS = ["repeated", "pf1", "irreducible"];
const coreDone = () => CORE_IDS.every(isConquered);
const wingOpen = () => coreDone() || !!store.wingOpen;

function isLocked(room) {
  if (!room.requires) return false;
  const rec = roomRecord(room.id);
  return !wingOpen() && !rec.run && rec.wins === 0;
}

function recommendedRoomId() {
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
  for (const v of [mapView, roomView, conquestView, medalView]) v.hidden = v !== view;
  window.scrollTo(0, 0);
}

// --- map --------------------------------------------------------------------

let justConquered = null; // room id whose card flips on the next map render


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
  if (conquered) {
    side = `<span class="wins" title="מספר הניצחונות בחדר">×${rec.wins}</span>` +
      `<span class="score-chip small tier-${scoreTier(rec.best)}" title="הציון הטוב ביותר">${rec.best}</span>`;
  }

  const info = [`<div class="info-en" dir="ltr">${room.en}</div>`, `<div class="info-tag">${room.tag}${room.stars ? " " + "★".repeat(room.stars) : ""}</div>`];
  if (room.blurb) info.push(`<div>${room.blurb}</div>`);
  if (locked) {
    const nums = missingRequirements(room).map((id) => ROOM_BY_ID[id].num).join(", ");
    info.push(`<div class="info-note">נפתח אחרי חדרים <bdi dir="ltr">${nums}</bdi>.</div>`);
  }
  if (rec.run) info.push(`<div class="info-note">בתהליך: תרגיל ${rec.run.node + 1} מתוך ${room.nodes.length} · ניקוד כרגע: ${rec.run.score}</div>`);
  if (conquered) info.push(`<div class="info-note">ניצחתם בחדר ${rec.wins === 1 ? "פעם אחת" : `${rec.wins} פעמים`} · השיא: ${rec.best}</div>`);

  const done = rec.run ? rec.run.node : conquered ? room.nodes.length : 0;
  return `
    <div class="${classes.join(" ")}" data-room="${room.id}" role="button" tabindex="0">
      ${conquered ? PENNANT_SVG : ""}
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

// A doorway through the wall between two areas of the map.
const doorway = (col, row) => `<div class="doorway" style="grid-column:${col};grid-row:${row}" aria-hidden="true"></div>`;

// One padlock on the wing's gate, numbered after its core room.
function padlockSvg(n, open) {
  return `
    <svg class="padlock${open ? " open" : ""}" viewBox="0 0 24 30" role="img" aria-label="מנעול ${n}${open ? " - פתוח" : ""}">
      <path class="shackle" d="M6.5 13V8.5a5.5 5.5 0 0 1 11 0V13"/>
      <rect class="lock-body" x="2.5" y="12" width="19" height="16" rx="3"/>
      <text x="12" y="24.5" text-anchor="middle">${n}</text>
    </svg>`;
}

// --- the topic medal: earned by rooms 1-3, upgraded by the optional rooms ---

const MEDAL_COLORS = { high: "#3f8a5c", mid: "#c08a12", low: "#b5523b" };

function medalState() {
  const earned = coreDone();
  const avg = earned ? CORE_IDS.reduce((s, id) => s + roomRecord(id).best, 0) / CORE_IDS.length : null;
  return {
    earned,
    avg: avg === null ? null : Math.round(avg * 10) / 10,
    gold: isConquered("review"),
    star: isConquered("nonmonic"),
  };
}

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
    <text class="medal-ribbon-text" x="60" y="106.5" text-anchor="middle">פונקציות רציונליות</text>`;
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

function trophyHtml() {
  const m = medalState();
  return `
    <div class="room-card room-medals" data-node="trophy" role="button" tabindex="0">
      <div class="room-head"><span class="room-title">חדר המדליות</span></div>
      <div class="room-progress"><div class="medal-avg-line">${m.earned ? `ממוצע: <b>${m.avg}</b>` : ""}</div></div>
    </div>`;
}

// 2. Inside: the topic's medal, its score, and what is still open.
function renderMedalView() {
  const m = medalState();
  const sig = m.earned ? `${m.avg}|${m.gold}|${m.star}` : "";
  const isNew = m.earned && store.medalSeen !== sig;
  if (isNew) {
    store.medalSeen = sig;
    saveStore();
  }
  const item = (done, text) =>
    `<li class="${done ? "done" : ""}"><span class="check" aria-hidden="true">${done ? "✓" : ""}</span>${text}</li>`;
  $("medalStage").innerHTML = `
    <div class="medal-big${isNew ? " medal-new" : ""}">${medalSvg(m)}</div>
    <div class="medal-score">${m.earned ? `ממוצע שלושת החדרים: <b>${m.avg}</b>` : "המדליה עוד לא הושגה"}</div>
    <ul class="medal-checklist">
      ${item(m.earned, "שלושת החדרים במסדרון")}
      ${item(m.gold, "תרגילים מעורבבים")}
      ${item(m.star, "מכנה עם מקדם מוביל")}
    </ul>`;
}

function goToMedals() {
  location.hash = "#/medals";
}

$("medalBackBtn").addEventListener("click", () => goToMap());

// Top-down plan of floor 1. Grid columns run right to left (RTL): rooms 1-3,
// then the gate up to the upper wing.
//   row 1  upper wing: review · non-monic · the topic medal
//   row 3  upper corridor (fogged until the wing opens)
//   row 5  core rooms 1 · 2 · 3, and the gate with its three locks
//   row 7  main corridor
//   row 9  polynomial division (walk through it - or solve it)
//   row 11 entrance
// Even rows are the walls, with doorways through them.
function renderMap() {
  const [prep, rep, core, irr, review, ext] = ["division", "repeated", "pf1", "irreducible", "review", "nonmonic"].map((id) => ROOM_BY_ID[id]);
  const open = wingOpen();
  const reveal = open && !store.wingRevealed;
  if (reveal) {
    store.wingRevealed = true;
    saveStore();
  }
  const wingCls = open ? (reveal ? " wing-reveal" : "") : " fogged";
  const gateCls = open ? (coreDone() ? " open" : " open forced") : "";
  const locks = CORE_IDS.map((id, i) => padlockSvg(i + 1, isConquered(id))).join("");

  towerEl.innerHTML = `
    <div class="floor-map">
      <div class="floor-label">קומה 1 · פונקציות רציונליות <span class="floor-en" dir="ltr">(rational functions)</span></div>
      <div class="floor-grid">
        <div class="cell wing${wingCls}" style="grid-column:1;grid-row:1">${roomCardHtml(review)}</div>
        <div class="cell wing${wingCls}" style="grid-column:2;grid-row:1">${roomCardHtml(ext)}</div>
        <div class="cell wing${wingCls}" style="grid-column:3;grid-row:1">${trophyHtml()}</div>
        ${doorway(1, 2)}${doorway(2, 2)}${doorway(3, 2)}
        <div class="cell corridor upper wing${wingCls}" style="grid-column:1 / 5;grid-row:3">
          <div class="corridor-label">אגף עליון</div>
          ${open ? "" : '<button type="button" class="open-anyway phone-only" data-open-wing>לפתוח בכל זאת</button>'}
        </div>
        <div class="cell" style="grid-column:1;grid-row:5">${roomCardHtml(rep)}</div>
        <div class="cell" style="grid-column:2;grid-row:5">${roomCardHtml(core)}</div>
        <div class="cell" style="grid-column:3;grid-row:5">${roomCardHtml(irr)}</div>
        <div class="cell passage${gateCls}" style="grid-column:4;grid-row:4 / 7" data-node="gate">
          <div class="gate-arch">
            <div class="gate-locks">${locks}</div>
            <div class="gate-doors" aria-hidden="true"><div class="gate-door"></div><div class="gate-door"></div></div>
          </div>
          ${open ? "" : '<button type="button" class="open-anyway gate-anyway" data-open-wing>לפתוח בכל זאת</button>'}
        </div>
        ${doorway(1, 6)}${doorway(2, 6)}${doorway(3, 6)}
        <div class="cell corridor main" style="grid-column:1 / 5;grid-row:7"><div class="corridor-label">מסדרון · בחרו חדר</div></div>
        ${doorway(2, 8)}
        <div class="cell" style="grid-column:2;grid-row:9">${roomCardHtml(prep)}</div>
        ${doorway(2, 10)}
        <div class="cell entrance" style="grid-column:2;grid-row:11" data-node="entrance">
          ${DOOR_SVG}<span class="door-label">כניסה</span>
        </div>
        <div class="map-marker" aria-hidden="true">
          <span class="marker-pin"></span>
          <span class="marker-hint"></span>
        </div>
      </div>
    </div>`;
  justConquered = null;
  // Measure once any zoom of the map has settled; positions taken mid-zoom
  // would be scaled.
  requestAnimationFrame(() =>
    Promise.all(mapView.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => placeMarker(markerNode(), false))
  );
}

// --- the "you are here" marker ---------------------------------------------
// It stands at the doorway of a room (or the entrance, or the gate). Arrow
// keys step it between neighbouring places; Enter goes in. A click on a room
// walks it there along the corridors, then goes in.

const MAP_NODES = {
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

const markerNode = () => (MAP_NODES[store.lastRoom] ? store.lastRoom : "entrance");
let markerBusy = false;

function nodeEl(id) {
  return ROOM_BY_ID[id] ? towerEl.querySelector(`[data-room="${id}"]`) : towerEl.querySelector(`[data-node="${id}"]`);
}

// A point relative to the floor grid.
function nodePoint(id) {
  const grid = towerEl.querySelector(".floor-grid").getBoundingClientRect();
  const r = nodeEl(id).getBoundingClientRect();
  const at = MAP_NODES[id].at;
  const y = at === "top" ? r.top : at === "bottom" ? r.bottom : r.top + r.height / 2;
  return { x: r.left + r.width / 2 - grid.left, y: y - grid.top + (MAP_NODES[id].dy || 0) };
}

function corridorY(which) {
  const grid = towerEl.querySelector(".floor-grid").getBoundingClientRect();
  const r = towerEl.querySelector(`.corridor.${which}`).getBoundingClientRect();
  return r.top + r.height / 2 - grid.top;
}

// The way between two places: out into the corridor, along it, and in -
// through the gate when going between the lower floor and the upper wing.
function routePoints(from, to) {
  const a = nodePoint(from);
  const b = nodePoint(to);
  if (getComputedStyle(towerEl.querySelector(".doorway")).display === "none") return [a, b]; // phone layout
  const lowY = corridorY("main");
  const upY = corridorY("upper");
  const g = nodePoint("gate");
  const fa = MAP_NODES[from].area;
  const ta = MAP_NODES[to].area;
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
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1);
}

const markerTransform = (p) => `translate(${p.x}px, ${p.y}px)`;

function markerHintText(id) {
  if (id === "gate") return wingOpen() ? "" : "שער ↵";
  if (id === "trophy") return wingOpen() ? "היכנסו ↵" : "";
  if (!ROOM_BY_ID[id]) return "";
  return isLocked(ROOM_BY_ID[id]) ? "" : "היכנסו ↵";
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

// Walk to a place; resolves when the marker has arrived.
function walkTo(id) {
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
  const duration = Math.min(700, Math.max(180, total * 1.1));
  const anim = marker.animate(frames, { duration, easing: "ease-in-out" });
  return anim.finished.catch(() => {}).then(() => {
    markerBusy = false;
    placeMarker(id);
  });
}

// Step from the marker's place in a direction, if there's a way there.
function stepMarker(dir) {
  const here = markerNode();
  const to = MAP_NODES[here].nav[dir];
  if (!to) return;
  if (MAP_NODES[to].area === "upper" && !wingOpen()) {
    if (here === "gate") openGateDialog();
    else walkTo("gate");
    return;
  }
  walkTo(to);
}

// Enter: go into the room the marker stands at (or try the gate).
function activateMarker() {
  const id = markerNode();
  if (id === "gate") {
    if (!wingOpen()) openGateDialog();
    return;
  }
  if (id === "trophy") {
    if (wingOpen()) zoomIntoRoom(id).then(goToMedals);
    else openGateDialog();
    return;
  }
  const room = ROOM_BY_ID[id];
  if (!room) return;
  if (isLocked(room)) openGateDialog();
  else zoomIntoRoom(id).then(() => goToRoom(id));
}

const ARROW_DIRS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

document.addEventListener("keydown", (e) => {
  if (mapView.hidden || !lockDialog.hidden || markerBusy) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (ARROW_DIRS[e.key]) {
    e.preventDefault();
    stepMarker(ARROW_DIRS[e.key]);
  } else if (e.key === "Enter" && !e.target.closest("button, [data-room], .passage")) {
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
    if (isLocked(room)) openGateDialog();
    else walkTo(room.id).then(() => zoomIntoRoom(room.id)).then(() => goToRoom(room.id));
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
    else walkTo("trophy").then(() => zoomIntoRoom("trophy")).then(goToMedals);
    return;
  }
  if (e.target.closest('[data-node="entrance"]')) walkTo("entrance");
});

towerEl.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches('[data-room], [data-node="trophy"]')) {
    e.preventDefault();
    e.target.click();
  }
});

// --- "open anyway" dialog ---------------------------------------------------

// One gate for the whole upper wing, not one per room.
const lockDialog = $("lockDialog");

function openGateDialog() {
  const missing = CORE_IDS.filter((id) => !isConquered(id));
  const rec = ROOM_BY_ID[missing[0]]; // the first core room that's still open
  // Room numbers, not names; only the rooms still to do.
  const nums = missing.map((id) => ROOM_BY_ID[id].num).join(", ");
  $("lockDialogText").innerHTML =
    `האגף העליון בנוי על שלושת החדרים במסדרון הראשון. ` +
    `מומלץ לעבור קודם את ${missing.length > 1 ? "חדרים" : "חדר"} <bdi dir="ltr">${nums}</bdi> - אבל אפשר לפתוח אותו כבר עכשיו.`;
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
  store.wingOpen = true;
  saveStore();
  renderMap(); // the fog lifts
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
    ? `תרגיל ${view.node + 1} מתוך ${view.room.nodes.length}${node.boss ? " · בוס" : ""}`
    : "ניצחון! עברתם את החדר";
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

// "↺ מחדש": start the room over with a full score. Shown once the student
// has moved on or lost points; asks once more before throwing the run away.
const restartBtn = $("restartBtn");
let restartTimer = null;

function syncRestart() {
  const rec = view.room && roomRecord(view.room.id);
  restartBtn.hidden = !(rec && rec.run && (rec.run.node > 0 || rec.run.score < START_SCORE));
  resetRestartBtn();
}

function resetRestartBtn() {
  clearTimeout(restartTimer);
  restartBtn.classList.remove("confirming");
  restartBtn.textContent = "↺ מחדש";
}

restartBtn.addEventListener("click", () => {
  if (!restartBtn.classList.contains("confirming")) {
    restartBtn.classList.add("confirming");
    restartBtn.textContent = "להתחיל מחדש? לחצו שוב";
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
  rec.run.problem = makeProblem(view.room, nextNode, rec.run);
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
      <text class="seal-arc"><textPath href="#sealArc" startOffset="50%" text-anchor="middle">★ VICTORY ★</textPath></text>
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

  // What is left on the floor, now that this room is conquered.
  const coreLeft = CORE_IDS.filter((id) => !isConquered(id));
  let next;
  if (coreLeft.length) next = `נשארו במסדרון: ${quotedTitles(coreLeft)}`;
  else if (CORE_IDS.includes(room.id)) next = "עברתם את שלושת החדרים! המנעולים נפתחו - המדליה שלכם מחכה בחדר המדליות";
  else if (room.id === "review") next = "עברתם את התרגילים המעורבבים - המדליה שלכם השתדרגה! · אפשר גם \"מכנה עם מקדם מוביל\" (טכניקה גבוהה)";
  else if (room.id === "nonmonic") next = "עברתם את \"מכנה עם מקדם מוביל\" - המדליה שלכם השתדרגה!";
  else next = "";

  $("conquest").className = `conquest tier-${scoreTier(score)}`;
  $("conquest").innerHTML = `
    <div class="seal-wrap">${sealSvg(score)}</div>
    <h2>ניצחון! עברתם את החדר</h2>
    <div class="conquest-room">${room.title}<div dir="ltr" class="muted conquest-room-en">${room.en}</div></div>
    <div class="conquest-dots">${room.nodes
      .map((n, i) => `<span class="mini-node done${n.boss ? " boss" : ""}" style="animation-delay:${0.9 + i * 0.15}s"></span>`)
      .join("")}</div>
    ${score === 10 ? '<div class="perfect">★ מושלם - בלי אף טעות</div>' : ""}
    <div class="conquest-best">${bestLine}</div>
    <div class="conquest-wins">ניצחונות בחדר: ${wins}</div>
    <button type="button" id="toTowerBtn" class="primary-btn">חזרה למפה</button>
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
  } else if (location.hash === "#/medals" && wingOpen()) {
    store.lastRoom = "trophy";
    saveStore();
    renderMedalView();
    showView(medalView);
  } else {
    const fromRoom = lastView === roomView || lastView === conquestView || lastView === medalView;
    renderMap();
    showView(mapView);
    if (fromRoom) zoomOutOfRoom(markerNode());
    else if (mapZoom) {
      mapZoom.cancel();
      mapZoom = null;
    }
  }
}

window.addEventListener("hashchange", route);
route();

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
