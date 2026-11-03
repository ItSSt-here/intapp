import "https://esm.run/mathlive";

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

function problemToLatex({ A, B, a, b }) {
  const coeffX = A + B; // combined x-coefficient of the numerator
  const constTerm = -(A * b + B * a); // combined constant of the numerator

  let numerator;
  if (coeffX === 0) {
    numerator = `${constTerm}`;
  } else {
    const axTerm = coeffX === 1 ? "x" : coeffX === -1 ? "-x" : `${coeffX}x`;
    numerator = constTerm === 0 ? axTerm : axTerm + fmtSigned(constTerm, false);
  }
  const aTerm = a === 0 ? "x" : `x${fmtSigned(-a, false)}`;
  const bTerm = b === 0 ? "x" : `x${fmtSigned(-b, false)}`;
  return `\\int \\frac{${numerator}}{(${aTerm})(${bTerm})}\\,dx`;
}

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
// Game: capped real-time meter + coin economy
// ---------------------------------------------------------------------------

const METER_CAP = 20; // minutes
const BASE_REWARD = 15; // coins for a correct answer with 0 mistakes
const MISTAKE_PENALTY = 3; // coins lost per wrong attempt on the current question
const TIME_BONUS_TIERS = [
  [10, 3],
  [12.5, 2],
  [15, 1],
]; // [under this many minutes, this many bonus coins], checked in order
const SWAP_DELAY_MS = 20000; // question must be visible this long before it can be swapped
const SWAP_COST = 5; // coins
const WIN_TARGET = 4; // correct answers needed to win
const STORAGE_KEY = "calcapp-checkpoint-v1";

const game = {
  wallet: 0,
  meter: METER_CAP,
  correctCount: 0,
  problem: null,
  mistakes: 0,
  questionShownAt: 0,
  swapAvailableAt: 0,
  ended: null, // null | "win" | "lose"
};
let tickHandle = null;

const problemField = document.getElementById("problem");
const answerField = document.getElementById("answer");
const feedbackEl = document.getElementById("feedback");
const debugOut = document.getElementById("debugOut");
const checkBtn = document.getElementById("checkBtn");
const swapBtn = document.getElementById("swapBtn");
const walletValueEl = document.getElementById("walletValue");
const meterValueEl = document.getElementById("meterValue");
const meterFillEl = document.getElementById("meterFill");
const meterCardEl = document.querySelector(".meter-card");
const progressValueEl = document.getElementById("progressValue");
const addOneBtn = document.getElementById("addOneBtn");
const addFiveBtn = document.getElementById("addFiveBtn");
const overlayEl = document.getElementById("overlay");
const overlayTitleEl = document.getElementById("overlayTitle");
const overlayBodyEl = document.getElementById("overlayBody");
const overlayBtnEl = document.getElementById("overlayBtn");

function loadCheckpoint() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cp = JSON.parse(raw);
    if (typeof cp.wallet !== "number" || typeof cp.meter !== "number" || typeof cp.correctCount !== "number") {
      return null;
    }
    return cp;
  } catch {
    return null;
  }
}

function saveCheckpoint() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ wallet: game.wallet, meter: game.meter, correctCount: game.correctCount })
  );
}

function clearCheckpoint() {
  localStorage.removeItem(STORAGE_KEY);
}

function fmtTime(minutes) {
  const totalSeconds = Math.max(0, Math.round(minutes * 60));
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function startNewQuestion() {
  game.problem = generateProblem();
  game.mistakes = 0;
  game.questionShownAt = Date.now();
  game.swapAvailableAt = game.questionShownAt + SWAP_DELAY_MS;
  problemField.value = problemToLatex(game.problem);
  answerField.value = "";
  answerField.focus();
}

function clearFeedback() {
  feedbackEl.textContent = "";
  feedbackEl.className = "feedback";
}

function updateWalletUI() {
  walletValueEl.textContent = String(game.wallet);
}

function updateProgressUI() {
  progressValueEl.textContent = `${game.correctCount} / ${WIN_TARGET}`;
}

function updateMeterUI() {
  const pct = Math.max(0, Math.min(100, (game.meter / METER_CAP) * 100));
  meterFillEl.style.width = `${pct}%`;
  meterValueEl.textContent = fmtTime(game.meter);

  meterFillEl.classList.remove("meter-warn", "meter-danger");
  meterCardEl.classList.remove("meter-danger");
  if (pct < 25) {
    meterFillEl.classList.add("meter-danger");
    meterCardEl.classList.add("meter-danger");
  } else if (pct < 50) {
    meterFillEl.classList.add("meter-warn");
  }

  const roomInMeter = Math.floor(METER_CAP - game.meter + 1e-9);
  addOneBtn.disabled = game.ended !== null || roomInMeter <= 0 || game.wallet <= 0;
  addFiveBtn.disabled = game.ended !== null || roomInMeter <= 0 || game.wallet <= 0;
}

function updateSwapUI() {
  if (game.ended) {
    swapBtn.disabled = true;
    return;
  }
  const remainingMs = game.swapAvailableAt - Date.now();
  if (remainingMs > 0) {
    swapBtn.disabled = true;
    swapBtn.textContent = `Swap question (available in ${Math.ceil(remainingMs / 1000)}s)`;
  } else {
    swapBtn.textContent = `Swap question (-${SWAP_COST} coins)`;
    swapBtn.disabled = game.wallet < SWAP_COST;
  }
}

function updateAll() {
  updateWalletUI();
  updateProgressUI();
  updateMeterUI();
  updateSwapUI();
  debugOut.textContent = JSON.stringify(
    { ...game.problem, wallet: game.wallet, meter: game.meter.toFixed(2), correctCount: game.correctCount, mistakes: game.mistakes },
    null,
    0
  );
}

function addToMeter(amount) {
  if (game.ended) return;
  // The meter drains continuously as a float, so "room to cap" is rarely a
  // whole number - floor it so coins (always whole) never buy a fractional
  // minute and the wallet stays an integer.
  const room = Math.floor(METER_CAP - game.meter + 1e-9);
  const spend = Math.max(0, Math.min(amount, room, game.wallet));
  if (spend <= 0) return;
  game.meter += spend;
  game.wallet -= spend;
  updateAll();
}

function stopTicking() {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function tick() {
  if (game.ended) return;
  game.meter = Math.max(0, game.meter - 0.2 / 60);
  if (game.meter <= 0) {
    loseGame();
    return;
  }
  updateMeterUI();
  updateSwapUI();
}

function startTicking() {
  stopTicking();
  tickHandle = setInterval(tick, 200);
}

function showOverlay(title, body, buttonText) {
  overlayTitleEl.textContent = title;
  overlayBodyEl.textContent = body;
  overlayBtnEl.textContent = buttonText;
  overlayEl.classList.remove("hidden");
}

function hideOverlay() {
  overlayEl.classList.add("hidden");
}

function winGame() {
  game.ended = "win";
  stopTicking();
  clearCheckpoint();
  checkBtn.disabled = true;
  showOverlay(
    "You made it!",
    `You solved ${WIN_TARGET} integrals before the meter ran out.\nFinal score: ${game.wallet} coins`,
    "Play again"
  );
}

function loseGame() {
  game.ended = "lose";
  stopTicking();
  clearCheckpoint();
  checkBtn.disabled = true;
  updateMeterUI();
  showOverlay(
    "Time's up",
    `The meter ran out on question ${game.correctCount + 1} of ${WIN_TARGET}.`,
    "Try again"
  );
}

function computeReward() {
  const elapsedMin = (Date.now() - game.questionShownAt) / 60000;
  let reward = Math.max(0, BASE_REWARD - MISTAKE_PENALTY * game.mistakes);
  let bonus = 0;
  for (const [thresholdMin, bonusCoins] of TIME_BONUS_TIERS) {
    if (elapsedMin < thresholdMin) {
      bonus = bonusCoins;
      break;
    }
  }
  reward += bonus;
  return { reward, bonus, elapsedMin };
}

function resetGame() {
  game.wallet = 0;
  game.meter = METER_CAP;
  game.correctCount = 0;
  game.ended = null;
  checkBtn.disabled = false;
  hideOverlay();
  clearFeedback();
  startNewQuestion();
  saveCheckpoint();
  startTicking();
  updateAll();
}

checkBtn.addEventListener("click", () => {
  if (game.ended) return;
  const latex = answerField.value;
  const result = checkAnswer(game.problem, latex);

  if (result.ok) {
    const { reward, bonus, elapsedMin } = computeReward();
    game.wallet += reward;
    game.correctCount += 1;
    feedbackEl.textContent =
      `Correct! +${reward} coins ` +
      `(base ${BASE_REWARD}${game.mistakes ? ` - ${MISTAKE_PENALTY * game.mistakes} mistakes` : ""}${bonus ? ` + ${bonus} speed bonus` : ""}), ` +
      `solved in ${elapsedMin.toFixed(1)} min.`;
    feedbackEl.className = "feedback correct";

    if (game.correctCount >= WIN_TARGET) {
      winGame();
      return;
    }
    startNewQuestion();
    saveCheckpoint();
  } else {
    game.mistakes += 1;
    let msg = result.reason;
    if (result.failures) {
      const f0 = result.failures[0];
      msg += `\nAt x ≈ ${f0.x.toFixed(2)}: expected f(x) ≈ ${f0.expected.toFixed(4)}, your F'(x) ≈ ${Number.isFinite(f0.got) ? f0.got.toFixed(4) : "undefined"}.`;
    }
    msg += `\nThat mistake will cost you ${MISTAKE_PENALTY} coins off this question's reward.`;
    feedbackEl.textContent = msg;
    feedbackEl.className = "feedback incorrect";
  }
  updateAll();
});

swapBtn.addEventListener("click", () => {
  if (game.ended) return;
  if (Date.now() < game.swapAvailableAt) return;
  if (game.wallet < SWAP_COST) return;
  game.wallet -= SWAP_COST;
  clearFeedback();
  startNewQuestion();
  saveCheckpoint();
  updateAll();
});

addOneBtn.addEventListener("click", () => addToMeter(1));
addFiveBtn.addEventListener("click", () => addToMeter(5));
overlayBtnEl.addEventListener("click", resetGame);

// Closing/reloading the tab always forfeits whatever happened during the
// current in-progress question and resumes from the last checkpoint - see
// design discussion: this keeps the real-time pressure honest (no free
// pausing) while capping the cost of a genuine interruption to one question.
function initGame() {
  const cp = loadCheckpoint();
  if (cp) {
    game.wallet = cp.wallet;
    game.meter = cp.meter;
    game.correctCount = cp.correctCount;
  }
  clearFeedback();
  startNewQuestion();
  saveCheckpoint();
  startTicking();
  updateAll();
}

initGame();
