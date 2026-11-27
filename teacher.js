// The lecturer's page: every student's progress, one table per group.
// Sign-in is with Google; the database rules (firestore.rules) let only the
// lecturer's address list the students, change a group or delete one.
import { ROOMS, MEDAL_LIST } from "./rooms.js";
import { FIREBASE_VERSION, FIREBASE_CONFIG, GROUPS, validId, idKey } from "./cloud.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const PLACES = [
  ["ground", "קומת הקרקע"],
  ["pf", "פונקציות רציונליות I"],
  ["pf2", "פונקציות רציונליות II"],
  ["parts", "אינטגרציה בחלקים"],
  ["sub", "הצבה"],
];
// What each group studies (software engineering has no rational functions II).
const groupHas = (group, place) => !(group === "software" && place === "pf2");
// Without a floor II, floor I is just "rational functions".
const pfName = (group, name) => (groupHas(group, "pf2") ? name : name.replace(/ I$/, ""));

let fb = null;
let students = []; // { key, name, group, store, updatedAt }
let tab = "software";
let found = null; // the key of the student the ID search found

// --- Firebase -------------------------------------------------------------------

async function connect() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [appMod, au, fs] = await Promise.all(
    ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map((f) => import(base + f)),
  );
  const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
  const auth = au.getAuth(app);
  await auth.authStateReady();
  return { au, fs, auth, db: fs.getFirestore(app) };
}

// Signed in with Google (not the anonymous pass a student's game uses here).
const lecturer = () => {
  const u = fb.auth.currentUser;
  return u && !u.isAnonymous ? u : null;
};

function showAccount() {
  const u = lecturer();
  $("account").innerHTML = u
    ? `<span>${esc(u.email)}</span> <button type="button" class="t-link" id="signOutBtn">יציאה</button>`
    : "";
  $("signOutBtn")?.addEventListener("click", async () => {
    await fb.au.signOut(fb.auth);
    location.reload();
  });
}

async function signIn() {
  $("signInError").textContent = "";
  try {
    await fb.au.signInWithPopup(fb.auth, new fb.au.GoogleAuthProvider());
    await start();
  } catch (e) {
    if (e?.code !== "auth/popup-closed-by-user") $("signInError").textContent = "הכניסה נכשלה. נסו שוב.";
    console.warn(e);
  }
}

// --- data -----------------------------------------------------------------------

function parseStore(json) {
  try {
    const s = JSON.parse(json);
    if (s && typeof s.rooms === "object") return s;
  } catch {
    // unreadable
  }
  return { rooms: {} };
}

async function load() {
  $("status").textContent = "טוען…";
  const snap = await fb.fs.getDocs(fb.fs.collection(fb.db, "students"));
  students = snap.docs.map((d) => {
    const v = d.data();
    return { key: d.id, name: v.name || "?", group: v.group, store: parseStore(v.store), updatedAt: v.updatedAt?.toDate?.() || null };
  });
  students.sort((a, b) => a.name.localeCompare(b.name, "he"));
  $("status").textContent = "";
  render();
}

const roomsOf = (group) =>
  PLACES.filter(([p]) => groupHas(group, p)).map(([p, label]) => [pfName(group, label), ROOMS.filter((r) => r.place === p)]);
const medalsOf = (group) => MEDAL_LIST.filter((m) => groupHas(group, m.id));

const ROOM_BY_ID = Object.fromEntries(ROOMS.map((r) => [r.id, r]));

// A room's box: the best score, how many times it was finished (from twice
// on), and how far the student is in a run going on now (exercises solved
// out of the room's). `csv` is the same in one line, for the export.
function roomCell(st, id) {
  const r = st.store.rooms[id];
  const progress = r?.run ? `${r.run.node}/${ROOM_BY_ID[id].nodes.length}` : "";
  if (r?.wins > 0 && r.best != null) {
    const sub = [r.wins > 1 ? `×${r.wins}` : "", progress].filter(Boolean).join(" · ");
    const csv = [String(r.best), r.wins > 1 ? `סיים ${r.wins} פעמים` : "", progress ? `עכשיו ${progress}` : ""];
    return { text: String(r.best), sub, score: r.best, csv: csv.filter(Boolean).join(", ") };
  }
  if (progress) return { text: progress, run: true, csv: `בתהליך ${progress}` };
  return { text: "", csv: "" };
}

function medalCell(st, m) {
  const recs = m.rooms.map((id) => st.store.rooms[id]);
  if (!recs.every((r) => r?.wins > 0)) {
    const got = recs.filter((r) => r?.wins > 0).length;
    return { text: got ? `${got}/${recs.length}` : "", partial: true };
  }
  const avg = Math.round((recs.reduce((s, r) => s + r.best, 0) / recs.length) * 10) / 10;
  const gold = st.store.rooms[m.gold.room]?.wins > 0;
  return { text: String(avg), score: avg, gold };
}

const tier = (s) => (s >= 9 ? "high" : s >= 7 ? "mid" : "low");
const when = (d) =>
  d ? d.toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

// --- the table ----------------------------------------------------------------

function renderTabs() {
  $("tabs").innerHTML = Object.entries(GROUPS)
    .map(([g, label]) => {
      const n = students.filter((s) => s.group === g).length;
      return `<button type="button" role="tab" class="t-tab${g === tab ? " on" : ""}" data-tab="${g}" aria-selected="${g === tab}">${label} <span class="t-count">${n}</span></button>`;
    })
    .join("");
}

function render() {
  renderTabs();
  const list = students.filter((s) => s.group === tab);
  const places = roomsOf(tab);
  const medals = medalsOf(tab);
  const rooms = places.flatMap(([, rs]) => rs);

  const head1 = `<tr><th rowspan="2" class="t-name">שם</th><th rowspan="2" class="t-when">פעילות אחרונה</th>
    ${places.map(([label, rs]) => `<th colspan="${rs.length}" class="t-place">${label}</th>`).join("")}
    <th colspan="${medals.length}" class="t-place">מדליות</th><th rowspan="2"></th></tr>`;
  const head2 = `<tr>${rooms.map((r) => `<th class="t-room${r.kind === "review" ? " review" : ""}" title="${esc(r.title)}">${esc(r.title)}</th>`).join("")}
    ${medals.map((m) => `<th class="t-room">${esc(pfName(tab, m.title))}</th>`).join("")}</tr>`;

  const cell = (c) =>
    `<td class="t-cell${c.score != null ? " " + tier(c.score) : ""}${c.run ? " t-run" : ""}${c.partial ? " t-partial" : ""}">${c.text}${c.gold ? ' <span class="t-gold">★</span>' : ""}${c.sub ? `<span class="t-sub" dir="ltr">${c.sub}</span>` : ""}</td>`;
  const rows = list
    .map(
      (st) => `<tr data-key="${st.key}"${st.key === found ? ' class="t-found"' : ""}>
        <td class="t-name">${esc(st.name)}</td><td class="t-when">${when(st.updatedAt)}</td>
        ${rooms.map((r) => cell(roomCell(st, r.id))).join("")}
        ${medals.map((m) => cell(medalCell(st, m))).join("")}
        <td class="t-row-actions">
          <select class="t-move" aria-label="העברה לקבוצה">
            <option value="">העברה…</option>
            ${Object.entries(GROUPS).filter(([g]) => g !== tab).map(([g, l]) => `<option value="${g}">${l}</option>`).join("")}
          </select>
          <button type="button" class="t-link t-del">מחיקה</button>
        </td></tr>`,
    )
    .join("");
  // How many finished each room.
  const done = (id) => list.filter((st) => st.store.rooms[id]?.wins > 0).length;
  const foot = list.length
    ? `<tr class="t-foot"><td class="t-name">סיימו</td><td></td>${rooms.map((r) => `<td>${done(r.id)}</td>`).join("")}
       ${medals.map((m) => `<td>${list.filter((st) => medalCell(st, m).score != null).length}</td>`).join("")}<td></td></tr>`
    : "";
  $("table").innerHTML = `<thead>${head1}${head2}</thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot>`;
  if (!list.length) $("status").textContent = "אין עדיין סטודנטים בקבוצה הזאת.";
  else $("status").textContent = "";
}

// --- actions ----------------------------------------------------------------------

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  found = null;
  render();
});

$("table").addEventListener("change", async (e) => {
  if (!e.target.matches(".t-move") || !e.target.value) return;
  const st = students.find((s) => s.key === e.target.closest("tr").dataset.key);
  const to = e.target.value;
  if (!confirm(`להעביר את ${st.name} לקבוצה ${GROUPS[to]}?`)) {
    e.target.value = "";
    return;
  }
  try {
    await fb.fs.updateDoc(fb.fs.doc(fb.db, "students", st.key), { group: to });
    st.group = to;
    render();
  } catch (err) {
    console.warn(err);
    alert("ההעברה נכשלה.");
    e.target.value = "";
  }
});

$("table").addEventListener("click", async (e) => {
  if (!e.target.matches(".t-del")) return;
  const st = students.find((s) => s.key === e.target.closest("tr").dataset.key);
  if (!confirm(`למחוק את ${st.name} ואת כל ההתקדמות שלו/ה בשרת? אי אפשר לבטל את זה.`)) return;
  try {
    await fb.fs.deleteDoc(fb.fs.doc(fb.db, "students", st.key));
    students = students.filter((s) => s !== st);
    render();
  } catch (err) {
    console.warn(err);
    alert("המחיקה נכשלה.");
  }
});

// Search by ID number: hashed here the same way the game does, and matched
// against the students' keys. The number itself goes nowhere.
$("idSearch").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = validId($("idInput").value);
  found = null;
  if (!id) {
    render();
    $("status").textContent = "מספר תעודת הזהות לא תקין.";
    return;
  }
  const key = await idKey(id);
  const st = students.find((s) => s.key === key);
  if (!st) {
    render();
    $("status").textContent = "לא נמצא סטודנט עם תעודת הזהות הזאת.";
    return;
  }
  found = key;
  tab = st.group;
  render();
  $("status").textContent = `נמצא: ${st.name} (${GROUPS[st.group] || st.group})`;
  $("table").querySelector(".t-found")?.scrollIntoView({ block: "center", behavior: "smooth" });
});

$("refreshBtn").addEventListener("click", () => load().catch(showLoadError));

// Every student, every group, as a CSV file Excel opens (the BOM keeps the
// Hebrew readable).
$("exportBtn").addEventListener("click", () => {
  const rooms = ROOMS;
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["שם", "קבוצה", "פעילות אחרונה", ...rooms.map((r) => `${PLACES.find(([p]) => p === r.place)[1]}: ${r.title}`), ...MEDAL_LIST.map((m) => `מדליה: ${m.title}`)];
  const lines = [header.map(q).join(",")];
  for (const g of Object.keys(GROUPS)) {
    for (const st of students.filter((s) => s.group === g)) {
      const roomVals = rooms.map((r) => (groupHas(g, r.place) ? roomCell(st, r.id).csv : "-"));
      const medalVals = MEDAL_LIST.map((m) => {
        if (!groupHas(g, m.id)) return "-";
        const c = medalCell(st, m);
        return c.score != null ? `${c.text}${c.gold ? " זהב" : ""}` : "";
      });
      lines.push([st.name, GROUPS[g] || g, when(st.updatedAt), ...roomVals, ...medalVals].map(q).join(","));
    }
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `intapp-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function showLoadError(e) {
  console.warn(e);
  $("status").textContent =
    e?.code === "permission-denied"
      ? "לחשבון הזה אין הרשאה לראות את הסטודנטים. (הכתובת בכללי האבטחה ב-Firebase צריכה להיות בדיוק הכתובת הזאת.)"
      : "הטעינה נכשלה. בדקו את החיבור ונסו שוב.";
}

// --- start ------------------------------------------------------------------------

async function start() {
  showAccount();
  if (!lecturer()) {
    $("board").hidden = true;
    $("signIn").hidden = false;
    return;
  }
  $("signIn").hidden = true;
  $("board").hidden = false;
  await load().catch(showLoadError);
}

$("signInBtn").addEventListener("click", signIn);
// Test hook for the preview only: ?debug draws the table from sample
// students (no sign-in, no server - the real data stays behind the rules).
if (new URLSearchParams(location.search).has("debug")) {
  window.__teacher = (list) => {
    students = list.map((s) => ({ updatedAt: new Date(), ...s }));
    $("signIn").hidden = true;
    $("board").hidden = false;
    render();
  };
}
connect()
  .then((f) => {
    fb = f;
    return start();
  })
  .catch((e) => {
    console.warn(e);
    $("main").textContent = "אין חיבור לשרת. בדקו את החיבור לאינטרנט ורעננו.";
  });
