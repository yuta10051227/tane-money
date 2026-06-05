import { useEffect, useState } from "react";

/**
 * Firebase未設定時のフォールバック。useCloud と同じ {data, loading, update} を返し、
 * この端末の localStorage に保存する（クラウド同期はしない）。
 * 後で .env に Firebase の値を入れれば、App側が自動でクラウドモードに切り替わる。
 *
 * @param {string} key   保存キー
 * @param {object} seed  初回の初期データ
 */
export function useLocal(key, seed) {
  const [data, setData] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch {
      /* 破損時はseedで開始 */
    }
    return seed;
  });

  // 初回はseedを書き込んでおく
  useEffect(() => {
    if (!localStorage.getItem(key)) {
      try {
        localStorage.setItem(key, JSON.stringify(seed));
      } catch {
        /* ignore */
      }
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // 部分更新（マージ）。useCloud と同じくトップレベルkeyをマージする。
  const update = (patch) => {
    setData((prev) => {
      const next = { ...prev, ...patch, updatedAt: Date.now() };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return { data, loading: false, error: null, update };
}
