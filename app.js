import { auth, db, configured } from "./firebase.js";
import { LOGO } from "./logo.js";
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  updateProfile, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection, query, orderBy, limit, onSnapshot, addDoc, doc, updateDoc, deleteDoc,
  serverTimestamp, arrayUnion, arrayRemove, increment, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $app = document.getElementById("app");
const MAX = 280;

let user = null;
let unsubPosts = null;
let posts = [];
const openComments = new Set();
const commentUnsubs = new Map();
const commentsByPost = new Map();

/* ---------- أدوات صغيرة ---------- */
const ERR = {
  "auth/invalid-email": "اسم المستخدم مش صالح",
  "auth/missing-password": "اكتب الباسورد",
  "auth/weak-password": "الباسورد ضعيف (6 حروف على الأقل)",
  "auth/email-already-in-use": "اسم المستخدم ده مأخوذ، جرّب غيره",
  "auth/invalid-credential": "اسم المستخدم أو الباسورد غلط",
  "auth/user-not-found": "اسم المستخدم أو الباسورد غلط",
  "auth/wrong-password": "اسم المستخدم أو الباسورد غلط",
  "auth/too-many-requests": "محاولات كتير، استنى شوية",
  "auth/popup-closed-by-user": "",
  "auth/cancelled-popup-request": "",
  "auth/network-request-failed": "مشكلة في الإنترنت",
  "permission-denied": "مش مسموحلك بالعملية دي",
};
const errMsg = e => ERR[e?.code] ?? "حصلت مشكلة، حاول تاني";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const displayName = u => u.displayName || (u.email ? u.email.split("@")[0] : "مستخدم");

function ago(ts) {
  if (!ts) return "دلوقتي";
  const s = Math.floor((Date.now() - ts.toDate().getTime()) / 1000);
  if (s < 60) return "دلوقتي";
  if (s < 3600) return Math.floor(s / 60) + " د";
  if (s < 86400) return Math.floor(s / 3600) + " س";
  return Math.floor(s / 86400) + " يوم";
}

function toast(msg) {
  if (!msg) return;
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove("show"), 3000);
}

function teardown() {
  unsubPosts?.(); unsubPosts = null;
  commentUnsubs.forEach(u => u());
  commentUnsubs.clear(); commentsByPost.clear(); openComments.clear();
  posts = [];
}

/* ---------- شاشة الإعداد (لو Firebase لسه متظبطش) ---------- */
function showSetup() {
  $app.innerHTML = `
    <div class="setup card">
      <h2 class="grad">Mindbook: باقي خطوة الإعداد</h2>
      <p>افتح الملف <code>js/firebase.js</code> والصق إعدادات مشروعك من Firebase بدل القيم اللي شكلها <code>YOUR_...</code>.</p>
      <p>الخطوات كاملة في ملف <code>README.md</code>.</p>
    </div>`;
}

/* ---------- شاشة الدخول (اسم مستخدم + باسورد) ---------- */
// Firebase بيشتغل بالإيميل، فبنحوّل اسم المستخدم لإيميل داخلي شكله ثابت.
// الإيميل ده مش حقيقي ومفيش رسائل بتتبعت عليه.
const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;
const toEmail = u => u.toLowerCase() + "@mindbook.example.com";

function showAuth(mode = "login") {
  teardown();
  const signup = mode === "signup";
  $app.innerHTML = `
    <div class="auth">
      ${LOGO}
      <h2 class="grad">Mindbook</h2>
      <p>شارك أفكارك، ونوّر عقول غيرك</p>
      <form id="authForm" class="card">
        <input type="text" id="username" placeholder="اسم المستخدم (إنجليزي وأرقام)" maxlength="20"
               required autocapitalize="none" autocorrect="off" autocomplete="username" dir="ltr">
        ${signup ? `<input type="text" id="name" placeholder="الاسم الظاهر (اختياري)" maxlength="30">` : ""}
        <input type="password" id="pass" placeholder="الباسورد" required minlength="6"
               autocomplete="${signup ? "new-password" : "current-password"}">
        <button type="submit" id="submitBtn">${signup ? "إنشاء حساب" : "دخول"}</button>
        <div class="switch">${signup ? "عندك حساب؟" : "مفيش حساب؟"}
          <a href="#" id="switch">${signup ? "سجّل دخول" : "أنشئ حساب"}</a></div>
      </form>
    </div>`;

  document.getElementById("switch").onclick = e => { e.preventDefault(); showAuth(signup ? "login" : "signup"); };

  document.getElementById("authForm").onsubmit = async e => {
    e.preventDefault();
    const username = document.getElementById("username").value.trim();
    const pass = document.getElementById("pass").value;
    if (!USERNAME_RE.test(username)) {
      toast("اسم المستخدم: حروف إنجليزي وأرقام و _ فقط، من 3 لـ 20 حرف");
      return;
    }
    const btn = document.getElementById("submitBtn");
    btn.disabled = true;
    try {
      if (signup) {
        const name = document.getElementById("name").value.trim() || username;
        const cred = await createUserWithEmailAndPassword(auth, toEmail(username), pass);
        await updateProfile(cred.user, { displayName: name });
        showApp(); // نعيد الرسم عشان الاسم الظاهر يتحدّث
      } else {
        await signInWithEmailAndPassword(auth, toEmail(username), pass);
      }
    } catch (err) {
      toast(errMsg(err));
    } finally {
      btn.disabled = false;
    }
  };
}

/* ---------- التطبيق الرئيسي ---------- */
function showApp() {
  teardown();
  user = auth.currentUser;
  if (!user) return showAuth();

  $app.innerHTML = `
    <header>
      <div class="brand">${LOGO}<h1 class="grad">Mindbook</h1></div>
      <span class="who">${esc(displayName(user))} · <a href="#" id="logout">خروج</a></span>
    </header>
    <main>
      <div class="card">
        <textarea id="postText" placeholder="إيه اللي في عقلك يا ${esc(displayName(user))}؟" maxlength="${MAX}"></textarea>
        <div class="row">
          <span class="count" id="count">0/${MAX}</span>
          <button id="postBtn" disabled>نشر</button>
        </div>
      </div>
      <div id="feed"></div>
    </main>`;

  const ta = document.getElementById("postText");
  const btn = document.getElementById("postBtn");
  ta.oninput = () => {
    document.getElementById("count").textContent = ta.value.length + "/" + MAX;
    btn.disabled = !ta.value.trim();
  };
  btn.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      await addDoc(collection(db, "posts"), {
        uid: user.uid, author: displayName(user), text,
        createdAt: serverTimestamp(), likes: [], commentCount: 0,
      });
      ta.value = "";
      document.getElementById("count").textContent = "0/" + MAX;
    } catch (err) {
      toast(errMsg(err));
      btn.disabled = false;
    }
  };
  document.getElementById("logout").onclick = e => { e.preventDefault(); signOut(auth); };

  const $feed = document.getElementById("feed");
  $feed.addEventListener("click", onFeedClick);
  $feed.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches("input[data-draft]")) sendComment(e.target.closest(".card"));
  });

  unsubPosts = onSnapshot(
    query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(50)),
    snap => { posts = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderFeed(); },
    err => toast(errMsg(err)),
  );
}

function renderFeed() {
  const $feed = document.getElementById("feed");
  if (!$feed) return;

  // نحفظ اللي المستخدم بيكتبه في خانات التعليق عشان ما يضيعش مع التحديث
  const drafts = {};
  $feed.querySelectorAll("input[data-draft]").forEach(i => { drafts[i.dataset.draft] = i.value; });
  const active = document.activeElement;
  const focusId = active?.matches?.("input[data-draft]") ? active.dataset.draft : null;

  if (!posts.length) {
    $feed.innerHTML = `<div class="empty">لسه مفيش أفكار. شارك أول واحدة!</div>`;
    return;
  }

  $feed.innerHTML = posts.map(p => {
    const likes = p.likes ?? [];
    const liked = likes.includes(user.uid);
    const open = openComments.has(p.id);
    const comments = commentsByPost.get(p.id) ?? [];
    return `
    <div class="card" data-id="${p.id}">
      <div class="meta">
        <div class="avatar">${esc((p.author || "?")[0])}</div>
        <div><div class="name">${esc(p.author)}</div><div class="time">${ago(p.createdAt)}</div></div>
      </div>
      <div class="text">${esc(p.text)}</div>
      <div class="actions">
        <button class="ghost ${liked ? "on" : ""}" data-act="like">💡 ${likes.length}</button>
        <button class="ghost" data-act="comments">💬 ${p.commentCount ?? 0}</button>
        ${p.uid === user.uid ? `<button class="ghost del" data-act="delete">🗑️ حذف</button>` : ""}
      </div>
      ${open ? `
      <div class="comments">
        ${comments.map(c => `
          <div class="comment">
            <span><b>${esc(c.author)}</b>${esc(c.text)}</span>
            ${c.uid === user.uid ? `<button data-act="delComment" data-cid="${c.id}" title="حذف">✕</button>` : ""}
          </div>`).join("")}
        <div class="row">
          <input type="text" placeholder="اكتب تعليق..." maxlength="140" data-draft="${p.id}">
          <button data-act="addComment">إرسال</button>
        </div>
      </div>` : ""}
    </div>`;
  }).join("");

  $feed.querySelectorAll("input[data-draft]").forEach(i => { if (drafts[i.dataset.draft]) i.value = drafts[i.dataset.draft]; });
  if (focusId) {
    const el = $feed.querySelector(`input[data-draft="${focusId}"]`);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
}

/* ---------- التفاعلات ---------- */
async function onFeedClick(e) {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const card = b.closest(".card");
  const id = card.dataset.id;
  const ref = doc(db, "posts", id);
  try {
    switch (b.dataset.act) {
      case "like": {
        const p = posts.find(x => x.id === id);
        const liked = (p.likes ?? []).includes(user.uid);
        await updateDoc(ref, { likes: liked ? arrayRemove(user.uid) : arrayUnion(user.uid) });
        break;
      }
      case "comments":
        toggleComments(id);
        break;
      case "delete":
        if (!confirm("تحذف البوست؟")) return;
        closeComments(id);
        await deleteDoc(ref);
        break;
      case "addComment":
        await sendComment(card);
        break;
      case "delComment": {
        const batch = writeBatch(db);
        batch.delete(doc(db, "posts", id, "comments", b.dataset.cid));
        batch.update(ref, { commentCount: increment(-1) });
        await batch.commit();
        break;
      }
    }
  } catch (err) {
    toast(errMsg(err));
  }
}

function toggleComments(id) {
  if (openComments.has(id)) { closeComments(id); renderFeed(); return; }
  openComments.add(id);
  const q = query(collection(db, "posts", id, "comments"), orderBy("createdAt", "asc"));
  commentUnsubs.set(id, onSnapshot(q, snap => {
    commentsByPost.set(id, snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderFeed();
  }, err => toast(errMsg(err))));
  renderFeed();
}

function closeComments(id) {
  commentUnsubs.get(id)?.();
  commentUnsubs.delete(id); commentsByPost.delete(id); openComments.delete(id);
}

async function sendComment(card) {
  const id = card.dataset.id;
  const input = card.querySelector("input[data-draft]");
  const text = input?.value.trim();
  if (!text) return;
  input.value = "";
  try {
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "posts", id, "comments")), {
      uid: user.uid, author: displayName(user), text, createdAt: serverTimestamp(),
    });
    batch.update(doc(db, "posts", id), { commentCount: increment(1) });
    await batch.commit();
  } catch (err) {
    input.value = text;
    toast(errMsg(err));
  }
}

/* ---------- التشغيل ---------- */
if (!configured) showSetup();
else onAuthStateChanged(auth, u => (u ? showApp() : showAuth()));
