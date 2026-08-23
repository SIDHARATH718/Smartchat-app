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
