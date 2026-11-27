// ---------------------------------------------------------------------------
// The server: progress saved in Firebase (project intapp-2f266), so a student
// continues on any computer and the lecturer sees everyone's progress.
//
// A student enters once per computer with an ID number, a name and a group.
// The ID number itself is never sent: the document key is a SHA-256 hash of
// it. The browser signs in anonymously (Firebase Auth) only so that the
// database rules can turn away bots; the anonymous account carries nothing,
// and losing it (Firebase may delete it after 30 days) just makes a new one.
//
// Database: students/<hash> = { name, group, store, savedAt, updatedAt }
//   store    the whole local store (app.js) as a JSON string
//   savedAt  the store's own savedAt (client clock), to tell which is newer
// The rules (firestore.rules) let anyone signed in read or write one document
// by its key, but only the lecturer list them.
//
// This web config is not a secret - every visitor's browser gets it anyway.
// ---------------------------------------------------------------------------

export const FIREBASE_VERSION = "12.19.0";
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC6W2pyNA35_I_WeDuK89x8Clz4yUGpU8o",
  authDomain: "intapp-2f266.firebaseapp.com",
  projectId: "intapp-2f266",
  storageBucket: "intapp-2f266.firebasestorage.app",
  messagingSenderId: "1022644149710",
  appId: "1:1022644149710:web:58a0b5c640cc423f139f9f",
};

export const GROUPS = {
  software: "הנדסת תוכנה",
  mechanical: "הנדסת מכונות",
  electrical: "הנדסת חשמל",
  other: "אחר",
};

const STUDENT_KEY = "intapp.student.v1"; // { key, name, group } on this computer
const SAVE_DELAY = 2500; // saves in quick succession go up as one
const RETRY_DELAY = 30000;

const within = (ms, promise) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

// --- Firebase, loaded on first use ------------------------------------------

let fbPromise = null;
function connect() {
  fbPromise ||= (async () => {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
    const [appMod, au, fs] = await Promise.all(
      ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map((f) => import(base + f)),
    );
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
    const auth = au.getAuth(app);
    await auth.authStateReady();
    if (!auth.currentUser) await au.signInAnonymously(auth);
    return { au, fs, auth, db: fs.getFirestore(app) };
  })().catch((e) => {
    fbPromise = null;
    throw e;
  });
  return fbPromise;
}

// A write refused because the anonymous account is gone: a new one, once.
async function withUser(fn) {
  const fb = await connect();
  if (!fb.auth.currentUser) await fb.au.signInAnonymously(fb.auth);
  try {
    return await fn(fb);
  } catch (e) {
    if (e?.code !== "permission-denied" && e?.code !== "unauthenticated") throw e;
    await fb.au.signOut(fb.auth);
    await fb.au.signInAnonymously(fb.auth);
    return fn(fb);
  }
}

const fetchStudent = (key) =>
  withUser(async ({ fs, db }) => {
    const snap = await fs.getDoc(fs.doc(db, "students", key));
    return snap.exists() ? snap.data() : null;
  });

// --- ID numbers ---------------------------------------------------------------

// An Israeli ID number: up to 9 digits, the last a check digit. Returns the
// 9-digit form, or null.
export function validId(raw) {
  if (/[^\d\s-]/.test(raw)) return null;
  const s = raw.replace(/\D/g, "");
  if (s.length < 5 || s.length > 9) return null;
  const id = s.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = +id[i] * (i % 2 ? 2 : 1);
    sum += d > 9 ? d - 9 : d;
  }
  return sum % 10 === 0 && !/^0+$/.test(id) ? id : null;
}

async function idKey(id) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("intapp-student:" + id));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- this computer's student ---------------------------------------------------

function readStudent() {
  try {
    const s = JSON.parse(localStorage.getItem(STUDENT_KEY));
    if (s && /^[0-9a-f]{64}$/.test(s.key) && s.name && GROUPS[s.group]) return s;
  } catch {
    // none
  }
  return null;
}

function writeStudent(s) {
  try {
    localStorage.setItem(STUDENT_KEY, JSON.stringify(s));
  } catch {
    // they'll be asked again next time
  }
}

let current = null; // the signed-in student
let needsProfile = false; // the server has no document yet: the next save creates it
export const currentStudent = () => current;

// --- merging two copies of the progress ---------------------------------------

function parseStore(json) {
  try {
    const s = JSON.parse(json);
    if (s && typeof s.rooms === "object") return s;
  } catch {
    // unreadable
  }
  return null;
}


// The newer copy, plus every room won only in the older one, with the better
// score of the two: nothing won on either computer is lost.
function mergeStores(a, b) {
  const [newer, older] = (a.savedAt || 0) >= (b.savedAt || 0) ? [a, b] : [b, a];
  const out = JSON.parse(JSON.stringify(newer));
  for (const [id, o] of Object.entries(older.rooms || {})) {
    const r = out.rooms[id];
    if (!r) {
      out.rooms[id] = o;
      continue;
    }
    r.wins = Math.max(r.wins || 0, o.wins || 0);
    if (o.best != null && (r.best == null || o.best > r.best)) r.best = o.best;
  }
  return out;
}

// --- saving --------------------------------------------------------------------

let timer = null;
let pending = null; // the latest store as JSON, not yet on the server
let writing = false;

export function cloudSave(store) {
  if (!current) return;
  pending = JSON.stringify(store);
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY);
}

async function flush() {
  clearTimeout(timer);
  timer = null;
  if (!pending || !current || writing) return;
  const body = pending;
  pending = null;
  writing = true;
  try {
    await withUser(({ fs, db }) => {
      const data = { store: body, savedAt: parseStore(body)?.savedAt || Date.now(), updatedAt: fs.serverTimestamp() };
      if (needsProfile) Object.assign(data, { name: current.name, group: current.group });
      return fs.setDoc(fs.doc(db, "students", current.key), data, { merge: true });
    });
    needsProfile = false;
  } catch (e) {
    console.warn("intapp: progress not saved to the server yet", e);
    pending ??= body;
    timer = setTimeout(flush, RETRY_DELAY);
  } finally {
    writing = false;
  }
  if (pending && !timer) timer = setTimeout(flush, SAVE_DELAY);
}

// Leaving the tab (or closing it): send what's waiting now.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});

// "Not you?": send this student's last progress, then forget them here.
export async function switchStudent(storeKey) {
  try {
    await within(5000, flush());
  } catch {
    // it stays local - and goes with them
  }
  try {
    localStorage.removeItem(STUDENT_KEY);
    localStorage.removeItem(storeKey);
  } catch {
    // nothing to clear
  }
  location.reload();
}

// --- start-up --------------------------------------------------------------------

// Before the app draws anything: who is this, and which copy of the progress
// to start from. Resolves to the store to use.
export async function cloudInit(local) {
  current = readStudent();
  if (!current) return entryDialog(local);
  try {
    const doc = await within(6000, fetchStudent(current.key));
    if (!doc) {
      // Gone from the server (deleted by the lecturer?): this copy goes back up.
      needsProfile = true;
      cloudSave(local);
      return local;
    }
    if (doc.name !== current.name || doc.group !== current.group) {
      current = { ...current, name: doc.name, group: doc.group }; // the lecturer moved them
      writeStudent(current);
    }
    const remote = parseStore(doc.store);
    if (!remote) return local;
    const merged = mergeStores(local, remote);
    if ((local.savedAt || 0) !== (remote.savedAt || 0)) cloudSave(merged);
    return merged;
  } catch (e) {
    console.warn("intapp: no server, playing from this computer's copy", e);
    return local; // offline: the next save tries again
  }
}

// --- the entry dialog ------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function entryDialog(local) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dialog-backdrop entry-backdrop";
    back.innerHTML = `
      <form class="dialog entry-dialog" role="dialog" aria-modal="true" aria-labelledby="entryTitle" novalidate>
        <h2 id="entryTitle">ברוכים הבאים למגדל האינטגרלים</h2>
        <p class="entry-lead">כדי לשמור את ההתקדמות ולהמשיך גם ממחשב אחר.</p>
        <label class="entry-field"><span>שם מלא</span>
          <input name="name" autocomplete="name" maxlength="60" required></label>
        <label class="entry-field"><span>מספר תעודת זהות</span>
          <input name="id" inputmode="numeric" autocomplete="off" maxlength="12" dir="ltr" required></label>
        <fieldset class="entry-groups"><legend>קבוצה</legend>
          ${Object.entries(GROUPS)
            .map(([k, v]) => `<label><input type="radio" name="group" value="${k}"><span>${v}</span></label>`)
            .join("")}
        </fieldset>
        <p class="entry-note">מספר תעודת הזהות עצמו לא נשמר בשרת ולא מוצג לאף אחד.</p>
        <p class="entry-error" role="alert"></p>
        <div class="dialog-buttons"><button type="submit" class="primary-btn">כניסה</button></div>
      </form>`;
    document.body.appendChild(back);
    const form = back.querySelector("form");
    const err = back.querySelector(".entry-error");
    const btn = form.querySelector("button[type=submit]");
    form.elements.name.focus();

    const finish = (student, store) => {
      current = student;
      writeStudent(student);
      back.remove();
      resolve(store);
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim().replace(/\s+/g, " ");
      const id = validId(form.elements.id.value);
      const group = form.elements.group.value;
      err.textContent = "";
      if (name.length < 2) return (err.textContent = "כתבו את השם המלא.");
      if (!id) return (err.textContent = "מספר תעודת הזהות לא תקין. בדקו את הספרות, כולל ספרת הביקורת.");
      if (!GROUPS[group]) return (err.textContent = "בחרו קבוצה.");
      btn.disabled = true;
      btn.textContent = "מתחברים…";
      let key;
      let doc;
      try {
        key = await idKey(id);
        doc = await within(10000, fetchStudent(key));
      } catch (e2) {
        console.warn("intapp: entry failed", e2);
        btn.disabled = false;
        btn.textContent = "כניסה";
        err.textContent = "אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.";
        return;
      }
      if (!doc) {
        // A new student starts a new game, whatever this computer played
        // before (on a shared computer that is someone else's).
        const fresh = { rooms: {}, savedAt: Date.now() };
        needsProfile = true;
        finish({ key, name, group }, fresh);
        cloudSave(fresh);
        flush();
        return;
      }
      // Known ID: show whose progress it is before taking it.
      form.innerHTML = `
        <h2 id="entryTitle">נמצאה התקדמות שמורה</h2>
        <p class="entry-lead">של <b>${esc(doc.name)}</b> (${esc(GROUPS[doc.group] || "")}). זה אתם?</p>
        <div class="dialog-buttons">
          <button type="button" class="primary-btn" data-yes>כן, להמשיך</button>
          <button type="button" class="secondary-btn" data-no>לא, חזרה</button>
        </div>`;
      form.querySelector("[data-no]").addEventListener("click", () => {
        back.remove();
        entryDialog(local).then(resolve);
      });
      form.querySelector("[data-yes]").addEventListener("click", () => {
        // Their own progress only, not what this computer played before.
        finish({ key, name: doc.name, group: doc.group }, parseStore(doc.store) || { rooms: {}, savedAt: Date.now() });
      });
      form.querySelector("[data-yes]").focus();
    });
  });
}
