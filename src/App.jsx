import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Send, Image as ImageIcon, X, Plus, MessageCircle, Film, Heart, Loader2,
  Search, ArrowLeft, Users as UsersIcon, Camera, Check, Home, User as UserIcon,
  UserPlus, Clock,
} from "lucide-react";
import { auth, db, storage } from "./firebase";
import {
  RecaptchaVerifier, signInWithPhoneNumber, sendSignInLinkToEmail,
  isSignInWithEmailLink, signInWithEmailLink, onAuthStateChanged, signOut,
} from "firebase/auth";
import {
  doc, getDoc, setDoc, collection, query, where, orderBy, onSnapshot,
  addDoc, updateDoc, increment, serverTimestamp, limit,
} from "firebase/firestore";
import { ref, uploadString, getDownloadURL } from "firebase/storage";

const INK = "#1B1F3B";
const CREAM = "#FAF7F2";
const CORAL = "#FF6553";
const MINT = "#2EC4B6";
const SLATE = "#6B7280";
const REEL_MS = 2500;
const EMAIL_KEY = "smartchat_email_for_signin";

function convoId(a, b) {
  return [a, b].sort().join("_");
}
function timeAgo(ts) {
  if (!ts) return "";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "abhi";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
function tsOf(data) {
  // Firestore Timestamp -> ms, fallback to raw number
  if (!data) return 0;
  if (typeof data === "number") return data;
  if (data.toMillis) return data.toMillis();
  return 0;
}

function Avatar({ profile, size = 40 }) {
  const style = { width: size, height: size, borderRadius: "50%", flexShrink: 0 };
  if (profile && profile.avatarURL) {
    return <img src={profile.avatarURL} alt={profile.username} style={{ ...style, objectFit: "cover" }} />;
  }
  const initial = (profile && profile.username ? profile.username[0] : "?").toUpperCase();
  return (
    <div style={{ ...style, background: MINT, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 700 }}>
      <span style={{ fontSize: size * 0.4 }}>{initial}</span>
    </div>
  );
}

async function uploadImage(dataUrl, path) {
  const storageRef = ref(storage, path);
  await uploadString(storageRef, dataUrl, "data_url");
  return await getDownloadURL(storageRef);
}
function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

export default function App() {
  // ---------- auth state ----------
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authStep, setAuthStep] = useState("start"); // start|signup|otp|emailSent|setUsername|confirm|login
  const [authMethod, setAuthMethod] = useState("phone");
  const [contactValue, setContactValue] = useState("");
  const [otpValue, setOtpValue] = useState("");
  const [loginUsername, setLoginUsername] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);

  const confirmationRef = useRef(null);
  const recaptchaRef = useRef(null);

  // ---------- app state ----------
  const [tab, setTab] = useState("home");
  const [profiles, setProfiles] = useState([]);
  const [messages, setMessages] = useState([]);
  const [posts, setPosts] = useState([]);
  const [stories, setStories] = useState([]);
  const [requests, setRequests] = useState([]);
  const [activeUser, setActiveUser] = useState(null); // {uid, username}
  const [msgInput, setMsgInput] = useState("");
  const [peopleSearch, setPeopleSearch] = useState("");
  const [error, setError] = useState("");
  const [viewingStory, setViewingStory] = useState(null);

  const [showComposer, setShowComposer] = useState(false);
  const [composeType, setComposeType] = useState("post");
  const [caption, setCaption] = useState("");
  const [images, setImages] = useState([]);
  const [posting, setPosting] = useState(false);

  const [reelIndex, setReelIndex] = useState(0);
  const [reelFrame, setReelFrame] = useState(0);

  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const storyFileRef = useRef(null);
  const avatarFileRef = useRef(null);

  // ---------- bootstrap: watch auth + finish email-link sign-in ----------
  useEffect(() => {
    (async () => {
      if (isSignInWithEmailLink(auth, window.location.href)) {
        let email = window.localStorage.getItem(EMAIL_KEY);
        if (!email) {
          email = window.prompt("Confirm karne ke liye apna email dobara likhein:");
        }
        try {
          await signInWithEmailLink(auth, email, window.location.href);
          window.localStorage.removeItem(EMAIL_KEY);
          window.history.replaceState({}, document.title, window.location.pathname);
        } catch (e) {
          setAuthError("Email link se login nahi ho paaya: " + (e.message || e));
        }
      }
    })();

    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setProfile(null);
        setLoadingAuth(false);
        return;
      }
      try {
        const snap = await getDoc(doc(db, "profiles", user.uid));
        if (snap.exists()) {
          setProfile({ uid: user.uid, ...snap.data() });
        } else {
          setAuthStep("setUsername");
        }
      } catch (e) {
        setAuthError("Profile load nahi ho paaya: " + (e.message || e));
      } finally {
        setLoadingAuth(false);
      }
    });
    return () => unsub();
  }, []);

  // ---------- Firestore live listeners (only once logged in) ----------
  useEffect(() => {
    if (!profile) return;
    const unsubs = [];

    unsubs.push(onSnapshot(collection(db, "profiles"), (snap) => {
      setProfiles(snap.docs.map((d) => ({ uid: d.id, ...d.data() })));
    }));

    unsubs.push(onSnapshot(query(collection(db, "posts"), orderBy("ts", "desc"), limit(100)), (snap) => {
      setPosts(snap.docs.map((d) => ({ id: d.id, ...d.data(), ts: tsOf(d.data().ts) })));
    }));

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    unsubs.push(onSnapshot(collection(db, "stories"), (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data(), ts: tsOf(d.data().ts) }));
      setStories(all.filter((s) => s.ts >= dayAgo));
    }));

    unsubs.push(onSnapshot(
      query(collection(db, "requests"), where("participants", "array-contains", profile.uid)),
      (snap) => setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data(), ts: tsOf(d.data().ts) })))
    ));

    return () => unsubs.forEach((u) => u());
  }, [profile]);

  // messages listener depends on the open thread
  useEffect(() => {
    if (!profile || !activeUser) return;
    const cid = convoId(profile.uid, activeUser.uid);
    const q = query(collection(db, "messages"), where("convoId", "==", cid), orderBy("ts", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data(), ts: tsOf(d.data().ts) })));
    });
    return () => unsub();
  }, [profile, activeUser]);

  useEffect(() => {
    if (tab === "thread" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, tab]);

  const reels = posts.filter((p) => p.type === "reel");
  useEffect(() => {
    if (tab !== "reels" || reels.length === 0) return;
    const current = reels[reelIndex];
    if (!current || !current.images || current.images.length < 2) return;
    const t = setInterval(() => setReelFrame((f) => (f + 1) % current.images.length), REEL_MS);
    return () => clearInterval(t);
  }, [tab, reelIndex, reels.length]);

  // ================= AUTH ACTIONS =================
  function ensureRecaptcha() {
    if (!recaptchaRef.current) {
      recaptchaRef.current = new RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" });
    }
    return recaptchaRef.current;
  }

  function goSignup() {
    setAuthError(""); setContactValue(""); setAuthStep("signup");
  }
  function goLogin() {
    setAuthError(""); setLoginUsername(""); setAuthStep("login");
  }

  async function submitSignupContact() {
    setAuthError("");
    const value = contactValue.trim();
    if (!value) {
      setAuthError(authMethod === "phone" ? "Phone number likhein (jaise +911234567890)" : "Email likhein");
      return;
    }
    setBusy(true);
    try {
      if (authMethod === "phone") {
        const verifier = ensureRecaptcha();
        const result = await signInWithPhoneNumber(auth, value, verifier);
        confirmationRef.current = result;
        setOtpValue("");
        setAuthStep("otp");
      } else {
        const actionCodeSettings = { url: window.location.href, handleCodeInApp: true };
        await sendSignInLinkToEmail(auth, value, actionCodeSettings);
        window.localStorage.setItem(EMAIL_KEY, value);
        setAuthStep("emailSent");
      }
    } catch (e) {
      setAuthError(e.message || "Kuch galat ho gaya");
    } finally {
      setBusy(false);
    }
  }

  async function submitOtp() {
    if (!confirmationRef.current) return;
    setAuthError(""); setBusy(true);
    try {
      await confirmationRef.current.confirm(otpValue.trim());
      // onAuthStateChanged handles the rest (profile lookup / setUsername step)
    } catch (e) {
      setAuthError("OTP galat hai ya expire ho gaya");
    } finally {
      setBusy(false);
    }
  }

  async function submitLoginUsername() {
    setAuthError("");
    const uname = loginUsername.trim();
    if (!uname) { setAuthError("Username likhein"); return; }
    setBusy(true);
    try {
      const q = query(collection(db, "profiles"), where("username", "==", uname), limit(1));
      const snap = await new Promise((resolve, reject) => {
        onSnapshot(q, (s) => resolve(s), reject);
      });
      if (snap.empty) {
        setAuthError("Yeh username nahi mila. Pehle Sign Up karein.");
        setBusy(false);
        return;
      }
      const found = snap.docs[0].data();
      setAuthMethod(found.contactMethod);
      setContactValue(found.contact);
      if (found.contactMethod === "phone") {
        const verifier = ensureRecaptcha();
        const result = await signInWithPhoneNumber(auth, found.contact, verifier);
        confirmationRef.current = result;
        setOtpValue("");
        setAuthStep("otp");
      } else {
        const actionCodeSettings = { url: window.location.href, handleCodeInApp: true };
        await sendSignInLinkToEmail(auth, found.contact, actionCodeSettings);
        window.localStorage.setItem(EMAIL_KEY, found.contact);
        setAuthStep("emailSent");
      }
    } catch (e) {
      setAuthError(e.message || "Kuch galat ho gaya");
    } finally {
      setBusy(false);
    }
  }

  async function submitUsername() {
    setAuthError("");
    const uname = usernameInput.trim();
    if (!uname) { setAuthError("Username likhein"); return; }
    setBusy(true);
    try {
      const q = query(collection(db, "profiles"), where("username", "==", uname), limit(1));
      const snap = await new Promise((resolve, reject) => onSnapshot(q, resolve, reject));
      if (!snap.empty) {
        setAuthError("Yeh username pehle se liya gaya hai");
        setBusy(false);
        return;
      }
      setAuthStep("confirm");
    } catch (e) {
      setAuthError(e.message || "Kuch galat ho gaya");
    } finally {
      setBusy(false);
    }
  }

  async function confirmNo() {
    setUsernameInput("");
    setAuthStep("setUsername");
  }

  async function confirmYes() {
    if (!firebaseUser) return;
    setBusy(true);
    try {
      const newProfile = {
        username: usernameInput.trim(),
        usernameLower: usernameInput.trim().toLowerCase(),
        contact: firebaseUser.phoneNumber || firebaseUser.email || contactValue,
        contactMethod: firebaseUser.phoneNumber ? "phone" : "email",
        avatarURL: null,
        createdAt: serverTimestamp(),
      };
      await setDoc(doc(db, "profiles", firebaseUser.uid), newProfile);
      setProfile({ uid: firebaseUser.uid, ...newProfile });
    } catch (e) {
      setAuthError("Save nahi ho paaya: " + (e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function logOut() {
    await signOut(auth);
    setAuthStep("start");
  }

  // ================= APP ACTIONS =================
  async function sendMessage() {
    const text = msgInput.trim();
    if (!text || !activeUser) return;
    setMsgInput("");
    try {
      await addDoc(collection(db, "messages"), {
        from: profile.uid, to: activeUser.uid,
        fromUsername: profile.username, toUsername: activeUser.username,
        convoId: convoId(profile.uid, activeUser.uid),
        text, ts: serverTimestamp(),
      });
    } catch (e) {
      setError("Message bhej nahi paaye.");
    }
  }

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const limited = composeType === "reel" ? files.slice(0, 6) : files.slice(0, 1);
    Promise.all(limited.map(fileToDataUrl)).then(setImages);
  }

  async function submitPost() {
    if (images.length === 0 && !caption.trim()) return;
    setPosting(true);
    try {
      const postId = crypto.randomUUID();
      const urls = await Promise.all(
        images.map((img, i) => uploadImage(img, `posts/${profile.uid}/${postId}_${i}.jpg`))
      );
      await addDoc(collection(db, "posts"), {
        uid: profile.uid, username: profile.username,
        caption: caption.trim(), images: urls, type: composeType,
        ts: serverTimestamp(), likes: 0,
      });
      closeComposer();
    } catch (e) {
      setError("Share nahi ho paaya: " + (e.message || e));
    } finally {
      setPosting(false);
    }
  }

  function closeComposer() {
    setShowComposer(false); setImages([]); setCaption(""); setComposeType("post");
  }

  async function toggleLike(post) {
    try {
      await updateDoc(doc(db, "posts", post.id), { likes: increment(1) });
    } catch (e) {}
  }

  function openThread(u) {
    setActiveUser(u);
    setTab("thread");
  }

  function profileFor(uid) {
    return profiles.find((p) => p.uid === uid) || { username: "?" };
  }

  function requestBetween(otherUid) {
    return requests.find(
      (r) => (r.from === profile.uid && r.to === otherUid) || (r.from === otherUid && r.to === profile.uid)
    );
  }

  async function sendRequest(target) {
    try {
      await addDoc(collection(db, "requests"), {
        from: profile.uid, to: target.uid,
        fromUsername: profile.username, toUsername: target.username,
        participants: [profile.uid, target.uid],
        status: "pending", ts: serverTimestamp(),
      });
    } catch (e) {
      setError("Request bhej nahi paaye.");
    }
  }

  async function respondRequest(req, accept) {
    try {
      if (accept) await updateDoc(doc(db, "requests", req.id), { status: "accepted" });
      else await updateDoc(doc(db, "requests", req.id), { status: "declined" });
    } catch (e) {
      setError("Kuch galat ho gaya.");
    }
  }

  function handleStoryFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    fileToDataUrl(file).then(async (dataUrl) => {
      try {
        const storyId = crypto.randomUUID();
        const url = await uploadImage(dataUrl, `stories/${profile.uid}/${storyId}.jpg`);
        await addDoc(collection(db, "stories"), {
          uid: profile.uid, username: profile.username, imageURL: url, ts: serverTimestamp(),
        });
      } catch (err) {
        setError("Story lag nahi payi.");
      }
    });
  }

  function handleAvatarFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    fileToDataUrl(file).then(async (dataUrl) => {
      try {
        const url = await uploadImage(dataUrl, `avatars/${profile.uid}.jpg`);
        await updateDoc(doc(db, "profiles", profile.uid), { avatarURL: url });
        setProfile((p) => ({ ...p, avatarURL: url }));
      } catch (err) {
        setError("Profile pic save nahi hui.");
      }
    });
  }

  // ================= RENDER =================
  if (loadingAuth) {
    return (
      <div style={{ background: INK, width: "100%", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2 className="spin" color="white" size={28} />
        <div id="recaptcha-container" />
      </div>
    );
  }

  if (!profile) {
    const wrap = { background: INK, width: "100%", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 };
    const box = { width: "100%", maxWidth: 380 };
    const input = { width: "100%", borderRadius: 16, padding: "12px 16px", marginBottom: 12, outline: "none", background: "#2A2F52", color: "white", border: "none", fontSize: 15 };
    const primaryBtn = { width: "100%", borderRadius: 16, padding: "14px 0", background: CORAL, color: "white", fontWeight: 700, border: "none", fontSize: 15, cursor: "pointer" };
    const secondaryBtn = { ...primaryBtn, background: "#2A2F52" };
    const backLink = { width: "100%", textAlign: "center", color: "#B8BCD9", background: "none", border: "none", marginTop: 12, fontSize: 14, cursor: "pointer" };
    const errStyle = { color: CORAL, fontSize: 13, marginBottom: 8 };

    if (authStep === "start") {
      return (
        <div style={wrap}>
          <div style={box}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 32 }}>
              <div style={{ background: CORAL, width: 40, height: 40, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <MessageCircle size={20} color="white" />
              </div>
              <h1 style={{ color: "white", fontSize: 24, fontWeight: 800 }}>Smart Chat</h1>
            </div>
            <button style={primaryBtn} onClick={goSignup}>Phone ya Email se Naya Account Banayein</button>
            <div style={{ height: 12 }} />
            <button style={secondaryBtn} onClick={goLogin}>Username se Login Karein</button>
          </div>
          <div id="recaptcha-container" />
        </div>
      );
    }

    if (authStep === "signup") {
      return (
        <div style={wrap}>
          <div style={box}>
            <h2 style={{ color: "white", fontSize: 20, fontWeight: 800, textAlign: "center", marginBottom: 20 }}>Naya Account</h2>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button style={{ ...secondaryBtn, flex: 1, padding: "8px 0", background: authMethod === "phone" ? CORAL : "#2A2F52" }} onClick={() => setAuthMethod("phone")}>Phone No.</button>
              <button style={{ ...secondaryBtn, flex: 1, padding: "8px 0", background: authMethod === "email" ? CORAL : "#2A2F52" }} onClick={() => setAuthMethod("email")}>Email</button>
            </div>
            <input
              style={input} value={contactValue} onChange={(e) => setContactValue(e.target.value)}
              placeholder={authMethod === "phone" ? "+91XXXXXXXXXX" : "Email address"}
            />
            {authMethod === "phone" && <p style={{ color: "#7A7FA6", fontSize: 12, marginTop: -6, marginBottom: 10 }}>Country code ke saath likhein, jaise +91</p>}
            {authError && <p style={errStyle}>{authError}</p>}
            <button style={primaryBtn} onClick={submitSignupContact} disabled={busy}>
              {busy ? "..." : "Next"}
            </button>
            <button style={backLink} onClick={() => setAuthStep("start")}>Back</button>
          </div>
          <div id="recaptcha-container" />
        </div>
      );
    }

    if (authStep === "otp") {
      return (
        <div style={wrap}>
          <div style={box}>
            <h2 style={{ color: "white", fontSize: 20, fontWeight: 800, textAlign: "center", marginBottom: 8 }}>OTP Verify Karein</h2>
            <p style={{ color: "#B8BCD9", fontSize: 14, textAlign: "center", marginBottom: 20 }}>{contactValue} par SMS bheja gaya hai</p>
            <input
              style={{ ...input, textAlign: "center", letterSpacing: 6 }} value={otpValue}
              onChange={(e) => setOtpValue(e.target.value)} placeholder="OTP" inputMode="numeric" maxLength={6}
            />
            {authError && <p style={errStyle}>{authError}</p>}
            <button style={primaryBtn} onClick={submitOtp} disabled={busy}>{busy ? "..." : "Next"}</button>
            <button style={backLink} onClick={() => setAuthStep("signup")}>Back</button>
          </div>
        </div>
      );
    }

    if (authStep === "emailSent") {
      return (
        <div style={wrap}>
          <div style={box}>
            <h2 style={{ color: "white", fontSize: 20, fontWeight: 800, textAlign: "center", marginBottom: 8 }}>Email Check Karein</h2>
            <p style={{ color: "#B8BCD9", fontSize: 14, textAlign: "center", marginBottom: 20 }}>
              {contactValue} par login link bheja gaya hai. Apne email mein jaakar us link par click karein — is device par yeh page apne aap khul jaayega.
            </p>
            {authError && <p style={errStyle}>{authError}</p>}
            <button style={backLink} onClick={() => setAuthStep("start")}>Back</button>
          </div>
        </div>
      );
    }

    if (authStep === "login") {
      return (
        <div style={wrap}>
          <div style={box}>
            <h2 style={{ color: "white", fontSize: 20, fontWeight: 800, textAlign: "center", marginBottom: 20 }}>Login</h2>
            <input style={input} value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} placeholder="Apna username likhein" />
            {authError && <p style={errStyle}>{authError}</p>}
            <button style={primaryBtn} onClick={submitLoginUsername} disabled={busy}>{busy ? "..." : "Login Karein"}</button>
            <button style={backLink} onClick={() => setAuthStep("start")}>Back</button>
          </div>
          <div id="recaptcha-container" />
        </div>
      );
    }

    if (authStep === "setUsername") {
      return (
        <div style={wrap}>
          <div style={box}>
            <h2 style={{ color: "white", fontSize: 20, fontWeight: 800, textAlign: "center", marginBottom: 8 }}>Username Chunein</h2>
            <p style={{ color: "#B8BCD9", fontSize: 14, textAlign: "center", marginBottom: 20 }}>Verify ho gaya! Ab apna username set karein.</p>
            <input style={input} value={usernameInput} onChange={(e) => setUsernameInput(e.target.value)} placeholder="Username" />
            {authError && <p style={errStyle}>{authError}</p>}
            <button style={primaryBtn} onClick={submitUsername} disabled={busy}>{busy ? "..." : "Next"}</button>
          </div>
        </div>
      );
    }

    if (authStep === "confirm") {
      return (
        <div style={{ ...wrap, position: "relative", flexDirection: "column" }}>
          <Avatar profile={{ username: usernameInput }} size={96} />
          <h2 style={{ color: "white", fontSize: 20, fontWeight: 800, marginTop: 16 }}>{usernameInput}</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <Check size={14} color={MINT} />
            <p style={{ color: MINT, fontSize: 14 }}>Username saved</p>
          </div>
          {authError && <p style={{ ...errStyle, marginTop: 12 }}>{authError}</p>}
          <button onClick={confirmNo} disabled={busy} style={{ position: "absolute", bottom: 32, left: 24, padding: "12px 20px", borderRadius: 16, background: "#2A2F52", color: "white", fontWeight: 700, border: "none" }}>No</button>
          <button onClick={confirmYes} disabled={busy} style={{ position: "absolute", bottom: 32, right: 24, padding: "12px 20px", borderRadius: 16, background: CORAL, color: "white", fontWeight: 700, border: "none" }}>
            {busy ? "..." : "Yes"}
          </button>
        </div>
      );
    }
  }

  // ---------------- MAIN APP ----------------
  const name = profile.username;
  const feedPosts = posts.filter((p) => p.type !== "reel");
  const myPosts = posts.filter((p) => p.uid === profile.uid);
  const currentReel = reels[reelIndex];

  const storyByUser = {};
  stories.forEach((s) => { if (!storyByUser[s.uid] || storyByUser[s.uid].ts < s.ts) storyByUser[s.uid] = s; });
  const myStory = storyByUser[profile.uid];
  const otherStoryUsers = Object.values(storyByUser).filter((s) => s.uid !== profile.uid).sort((a, b) => b.ts - a.ts);

  const searchQuery = peopleSearch.trim().toLowerCase();
  const searchResults = searchQuery
    ? profiles.filter((p) => p.uid !== profile.uid && (p.usernameLower || p.username.toLowerCase()).includes(searchQuery))
    : [];
  const incomingRequests = requests.filter((r) => r.to === profile.uid && r.status === "pending");
  const acceptedChats = requests
    .filter((r) => r.status === "accepted" && (r.from === profile.uid || r.to === profile.uid))
    .map((r) => (r.from === profile.uid ? { uid: r.to, username: r.toUsername } : { uid: r.from, username: r.fromUsername }));

  const page = { width: "100%", height: "100vh", display: "flex", flexDirection: "column", background: CREAM };
  const header = { background: INK, padding: "16px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" };
  const navBtn = (active) => ({ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "10px 0", background: "none", border: "none", color: active ? CORAL : SLATE, cursor: "pointer" });

  return (
    <div style={page}>
      <div style={header}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {tab === "thread" ? (
            <button onClick={() => setTab("search")} style={{ background: "none", border: "none" }}><ArrowLeft size={20} color="white" /></button>
          ) : (
            <div style={{ background: CORAL, width: 32, height: 32, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <MessageCircle size={16} color="white" />
            </div>
          )}
          <h1 style={{ color: "white", fontSize: 18, fontWeight: 800 }}>{tab === "thread" ? activeUser.username : "Smart Chat"}</h1>
        </div>
        {tab !== "thread" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar profile={profile} size={30} />
            <button onClick={logOut} style={{ background: "none", border: "none", color: "#B8BCD9", fontSize: 12 }}>Logout</button>
          </div>
        )}
      </div>

      {error && <div style={{ background: "#FDE8E6", color: CORAL, textAlign: "center", fontSize: 12, padding: "6px 0" }}>{error}</div>}

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {tab === "home" ? (
          <div style={{ flex: 1, overflowY: "auto" }}>
            <div style={{ display: "flex", gap: 12, padding: 12, overflowX: "auto", background: "white" }}>
              <button onClick={() => storyFileRef.current?.click()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", flexShrink: 0 }}>
                <div style={{ borderRadius: "50%", padding: 2, border: myStory ? `2px solid ${MINT}` : `2px dashed ${SLATE}` }}>
                  <Avatar profile={myStory ? { ...profile, avatarURL: myStory.imageURL } : profile} size={54} />
                </div>
                <span style={{ fontSize: 11, color: SLATE }}>Aapki Story</span>
              </button>
              <input ref={storyFileRef} type="file" accept="image/*" onChange={handleStoryFile} style={{ display: "none" }} />
              {otherStoryUsers.map((s) => (
                <button key={s.uid} onClick={() => setViewingStory(s)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", flexShrink: 0 }}>
                  <div style={{ borderRadius: "50%", padding: 2, border: `2px solid ${CORAL}` }}>
                    <Avatar profile={{ ...profileFor(s.uid), avatarURL: s.imageURL }} size={54} />
                  </div>
                  <span style={{ fontSize: 11, color: SLATE, maxWidth: 56, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.username}</span>
                </button>
              ))}
            </div>

            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 16 }}>
              <p style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: SLATE }}>Suggestions</p>
              {feedPosts.length === 0 && <p style={{ textAlign: "center", color: SLATE, fontSize: 14, marginTop: 24 }}>Koi post nahi mili.</p>}
              {feedPosts.map((p) => (
                <div key={p.id} style={{ background: "white", borderRadius: 16, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
                    <Avatar profile={profileFor(p.uid)} size={28} />
                    <div style={{ fontWeight: 700, fontSize: 14, color: INK }}>{p.username}</div>
                    <div style={{ marginLeft: "auto", fontSize: 12, color: SLATE }}>{timeAgo(p.ts)}</div>
                  </div>
                  {p.images?.[0] && <img src={p.images[0]} alt="post" style={{ width: "100%", maxHeight: 384, objectFit: "cover" }} />}
                  <div style={{ padding: "10px 12px", display: "flex", gap: 8 }}>
                    <button onClick={() => toggleLike(p)} style={{ background: "none", border: "none" }}><Heart size={18} color={CORAL} /></button>
                    <div style={{ fontSize: 14, color: INK }}>
                      {p.caption}
                      <div style={{ fontSize: 12, color: SLATE, marginTop: 4 }}>{p.likes || 0} pasand</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : tab === "thread" ? (
          <>
            <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              {messages.map((m) => {
                const mine = m.from === profile.uid;
                return (
                  <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
                    <div style={{ maxWidth: "75%", borderRadius: 16, padding: "8px 14px", background: mine ? CORAL : "white", color: mine ? "white" : INK }}>
                      <div style={{ fontSize: 14 }}>{m.text}</div>
                      <div style={{ fontSize: 10, marginTop: 4, textAlign: "right", color: mine ? "rgba(255,255,255,0.75)" : SLATE }}>{timeAgo(m.ts)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: 12, display: "flex", gap: 8, borderTop: "1px solid #E8E4DC", background: "white" }}>
              <input
                value={msgInput} onChange={(e) => setMsgInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                placeholder="Message likhein..." style={{ flex: 1, borderRadius: 999, padding: "10px 16px", border: "none", background: CREAM, outline: "none", fontSize: 14 }}
              />
              <button onClick={sendMessage} style={{ width: 40, height: 40, borderRadius: "50%", background: CORAL, border: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Send size={16} color="white" />
              </button>
            </div>
          </>
        ) : tab === "search" ? (
          <>
            <div style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, borderRadius: 999, padding: "8px 14px", background: "white" }}>
                <Search size={15} color={SLATE} />
                <input value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} placeholder="Username dhoondhein..." style={{ flex: 1, border: "none", outline: "none", background: "none", fontSize: 14 }} />
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px" }}>
              {searchQuery ? (
                searchResults.map((u) => {
                  const req = requestBetween(u.uid);
                  return (
                    <div key={u.uid} style={{ display: "flex", alignItems: "center", gap: 10, background: "white", borderRadius: 16, padding: "10px 12px", marginBottom: 6 }}>
                      <Avatar profile={u} size={40} />
                      <div style={{ flex: 1, fontWeight: 700, fontSize: 14, color: INK }}>{u.username}</div>
                      {!req && (
                        <button onClick={() => sendRequest(u)} style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: 999, padding: "6px 12px", background: CORAL, border: "none", color: "white", fontSize: 12, fontWeight: 700 }}>
                          <UserPlus size={13} /> Request
                        </button>
                      )}
                      {req?.status === "pending" && req.from === profile.uid && <span style={{ display: "flex", alignItems: "center", gap: 4, color: SLATE, fontSize: 12 }}><Clock size={13} /> Requested</span>}
                      {req?.status === "pending" && req.to === profile.uid && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => respondRequest(req, true)} style={{ width: 32, height: 32, borderRadius: "50%", background: MINT, border: "none" }}><Check size={15} color="white" /></button>
                          <button onClick={() => respondRequest(req, false)} style={{ width: 32, height: 32, borderRadius: "50%", background: "#E8E4DC", border: "none" }}><X size={15} color={SLATE} /></button>
                        </div>
                      )}
                      {req?.status === "accepted" && (
                        <button onClick={() => openThread(u)} style={{ borderRadius: 999, padding: "6px 12px", background: MINT, border: "none", color: "white", fontSize: 12, fontWeight: 700 }}>Chat</button>
                      )}
                    </div>
                  );
                })
              ) : (
                <>
                  {incomingRequests.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <p style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: SLATE, marginBottom: 8 }}>Requests</p>
                      {incomingRequests.map((r) => (
                        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "white", borderRadius: 16, padding: "10px 12px", marginBottom: 6 }}>
                          <Avatar profile={profileFor(r.from)} size={40} />
                          <div style={{ flex: 1, fontWeight: 700, fontSize: 14, color: INK }}>{r.fromUsername}</div>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => respondRequest(r, true)} style={{ width: 32, height: 32, borderRadius: "50%", background: MINT, border: "none" }}><Check size={15} color="white" /></button>
                            <button onClick={() => respondRequest(r, false)} style={{ width: 32, height: 32, borderRadius: "50%", background: "#E8E4DC", border: "none" }}><X size={15} color={SLATE} /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <p style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: SLATE, marginBottom: 8 }}>Chats</p>
                  {acceptedChats.length === 0 && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginTop: 24 }}>
                      <UsersIcon size={22} color={SLATE} />
                      <p style={{ color: SLATE, fontSize: 14, textAlign: "center" }}>Username search karke chat request bhejein.</p>
                    </div>
                  )}
                  {acceptedChats.map((u) => (
                    <button key={u.uid} onClick={() => openThread(u)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, background: "white", borderRadius: 16, padding: "10px 12px", marginBottom: 6, border: "none", textAlign: "left" }}>
                      <Avatar profile={profileFor(u.uid)} size={40} />
                      <div style={{ fontWeight: 700, fontSize: 14, color: INK }}>{u.username}</div>
                    </button>
                  ))}
                </>
              )}
            </div>
          </>
        ) : tab === "profile" ? (
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 16px" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <button onClick={() => avatarFileRef.current?.click()} style={{ position: "relative", background: "none", border: "none" }}>
                <Avatar profile={profile} size={88} />
                <div style={{ position: "absolute", bottom: 0, right: 0, width: 28, height: 28, borderRadius: "50%", background: CORAL, border: `2px solid ${CREAM}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Camera size={13} color="white" />
                </div>
              </button>
              <input ref={avatarFileRef} type="file" accept="image/*" onChange={handleAvatarFile} style={{ display: "none" }} />
              <h2 style={{ fontSize: 18, fontWeight: 800, color: INK, marginTop: 12 }}>{name}</h2>
              <p style={{ fontSize: 12, color: SLATE, marginTop: 4 }}>{myPosts.length} posts</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, marginTop: 24 }}>
              {myPosts.map((p) => (
                <div key={p.id} style={{ aspectRatio: "1", borderRadius: 6, overflow: "hidden", background: "#E8E4DC" }}>
                  {p.images?.[0] && <img src={p.images[0]} alt="post" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", background: INK }}>
            {reels.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <Film size={24} color="#7A7FA6" />
                <p style={{ color: "#B8BCD9", fontSize: 14 }}>Koi reel nahi hai abhi.</p>
              </div>
            ) : (
              <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <img src={currentReel.images[reelFrame % currentReel.images.length]} alt="reel" style={{ maxHeight: "100%", maxWidth: "100%", objectFit: "contain" }} />
                <div style={{ position: "absolute", bottom: 16, left: 16, right: 64, color: "white" }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{currentReel.username}</div>
                  {currentReel.caption && <div style={{ fontSize: 14 }}>{currentReel.caption}</div>}
                </div>
                <button onClick={() => toggleLike(currentReel)} style={{ position: "absolute", bottom: 24, right: 16, background: "none", border: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <Heart size={26} color={CORAL} />
                  <span style={{ color: "white", fontSize: 12 }}>{currentReel.likes || 0}</span>
                </button>
                <button onClick={() => { setReelIndex((i) => (i - 1 + reels.length) % reels.length); setReelFrame(0); }} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "33%", background: "none", border: "none" }} />
                <button onClick={() => { setReelIndex((i) => (i + 1) % reels.length); setReelFrame(0); }} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "33%", background: "none", border: "none" }} />
              </div>
            )}
          </div>
        )}
      </div>

      {tab !== "thread" && (
        <div style={{ display: "flex", alignItems: "center", borderTop: "1px solid #E8E4DC", background: "white", position: "relative" }}>
          <button onClick={() => setTab("home")} style={navBtn(tab === "home")}><Home size={20} /><span style={{ fontSize: 11 }}>Home</span></button>
          <button onClick={() => { setTab("reels"); setReelIndex(0); setReelFrame(0); }} style={navBtn(tab === "reels")}><Film size={20} /><span style={{ fontSize: 11 }}>Reels</span></button>
          <button onClick={() => setShowComposer(true)} style={{ width: 48, height: 48, borderRadius: "50%", background: CORAL, border: "none", display: "flex", alignItems: "center", justifyContent: "center", marginTop: -24, boxShadow: "0 4px 10px rgba(0,0,0,0.2)" }}>
            <Plus size={22} color="white" />
          </button>
          <button onClick={() => setTab("search")} style={navBtn(tab === "search")}><Search size={20} /><span style={{ fontSize: 11 }}>Search</span></button>
          <button onClick={() => setTab("profile")} style={navBtn(tab === "profile")}><UserIcon size={20} /><span style={{ fontSize: 11 }}>Profile</span></button>
        </div>
      )}

      {viewingStory && (
        <div onClick={() => setViewingStory(null)} style={{ position: "fixed", inset: 0, zIndex: 50, background: "black", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "absolute", top: 16, left: 16, right: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <Avatar profile={{ ...profileFor(viewingStory.uid), avatarURL: viewingStory.imageURL }} size={30} />
            <span style={{ color: "white", fontWeight: 700, fontSize: 14 }}>{viewingStory.username}</span>
            <button onClick={() => setViewingStory(null)} style={{ marginLeft: "auto", background: "none", border: "none" }}><X size={20} color="white" /></button>
          </div>
          <img src={viewingStory.imageURL} alt="story" style={{ maxHeight: "100%", maxWidth: "100%", objectFit: "contain" }} />
        </div>
      )}

      {showComposer && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(27,31,59,0.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 420, borderRadius: "24px 24px 0 0", padding: 16, background: "white" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, color: INK }}>Nayi Share</h2>
              <button onClick={closeComposer} style={{ background: "none", border: "none" }}><X size={20} color={SLATE} /></button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button onClick={() => { setComposeType("post"); setImages([]); }} style={{ flex: 1, borderRadius: 12, padding: "8px 0", fontWeight: 700, fontSize: 14, border: "none", background: composeType === "post" ? CORAL : CREAM, color: composeType === "post" ? "white" : INK }}>Photo Post</button>
              <button onClick={() => { setComposeType("reel"); setImages([]); }} style={{ flex: 1, borderRadius: 12, padding: "8px 0", fontWeight: 700, fontSize: 14, border: "none", background: composeType === "reel" ? CORAL : CREAM, color: composeType === "reel" ? "white" : INK }}>Reel (slideshow)</button>
            </div>
            {images.length > 0 ? (
              <div style={{ display: "flex", gap: 8, overflowX: "auto", marginBottom: 12 }}>
                {images.map((img, i) => <img key={i} src={img} alt="preview" style={{ height: 112, width: 112, objectFit: "cover", borderRadius: 12 }} />)}
              </div>
            ) : (
              <button onClick={() => fileInputRef.current?.click()} style={{ width: "100%", borderRadius: 16, padding: "32px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginBottom: 12, background: CREAM, border: `1.5px dashed ${SLATE}` }}>
                <ImageIcon size={24} color={SLATE} />
                <span style={{ color: SLATE, fontSize: 14 }}>{composeType === "reel" ? "2-6 photos chunein" : "Photo chunein"}</span>
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" multiple={composeType === "reel"} onChange={handleFiles} style={{ display: "none" }} />
            <textarea value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption likhein..." rows={2} style={{ width: "100%", borderRadius: 16, padding: 12, marginBottom: 12, border: "none", background: CREAM, outline: "none", resize: "none", fontSize: 14 }} />
            <button onClick={submitPost} disabled={posting || (images.length === 0 && !caption.trim())} style={{ width: "100%", borderRadius: 16, padding: "12px 0", background: CORAL, color: "white", fontWeight: 700, border: "none", opacity: posting ? 0.7 : 1 }}>
              {posting ? "Uploading..." : "Share Karein"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
