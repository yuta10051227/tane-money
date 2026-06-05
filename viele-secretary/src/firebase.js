import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// VIELE secretary の Firebase 設定。
// apiKey 等はWebアプリに公開される前提の値（秘密ではない）。
// セキュリティは Firestore ルール＋承認済みドメインで担保する。
// .env に VITE_FB_* があればそちらを優先し、無ければ下記の既定値を使う。
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY || "AIzaSyCT_uzEDmrYOgoV2eWD76aBHqEsYOGR2yE",
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN || "viele-secretary.firebaseapp.com",
  projectId: import.meta.env.VITE_FB_PROJECT_ID || "viele-secretary",
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET || "viele-secretary.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID || "752964285770",
  appId: import.meta.env.VITE_FB_APP_ID || "1:752964285770:web:2e356c76621bf4918d3db3",
  measurementId: import.meta.env.VITE_FB_MEASUREMENT_ID || "G-REWE9TFWW4",
};

// Firebaseの必須値が揃っているか。揃っていなければローカルモードで動く。
export const firebaseEnabled = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);

let auth = null;
let googleProvider = null;
let db = null;

if (firebaseEnabled) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  googleProvider = new GoogleAuthProvider();
  db = getFirestore(app);
}

export { auth, googleProvider, db };
