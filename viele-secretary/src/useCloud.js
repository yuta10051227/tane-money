import { useEffect, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase";

/**
 * Firestore同期フック（旧 useStored の置き換え）。
 * users/{uid} の1ドキュメントにダッシュボード状態をまるごと保存し、
 * 全端末で onSnapshot により即同期する。
 *
 * @param {string|null} uid  ログイン中ユーザーのUID（未ログインは null）
 * @param {object} seed      ドキュメント未作成時に初回投入する初期データ
 * @returns {{data: object|null, loading: boolean, update: (patch:object)=>void}}
 */
export function useCloud(uid, seed) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ref = doc(db, "users", uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          setData(snap.data());
        } else {
          // 初回ログイン：SEEDを書き込む
          setDoc(ref, seed).catch((e) => console.error("seed write failed", e));
          setData(seed);
        }
        setLoading(false);
      },
      (err) => {
        console.error("snapshot error", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // 部分更新（マージ）。updatedAt を必ず添える。
  const update = (patch) => {
    if (!uid) return;
    const ref = doc(db, "users", uid);
    setDoc(ref, { ...patch, updatedAt: Date.now() }, { merge: true }).catch(
      (e) => console.error("update failed", e)
    );
  };

  return { data, loading, update };
}
