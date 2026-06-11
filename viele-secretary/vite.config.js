import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PWA: デスクトップ・ホーム画面に設置可能にする
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-512.png"],
      manifest: {
        name: "ひとり秘書",
        short_name: "ひとり秘書",
        description: "一人社長のための、お母さんみたいなAI秘書。ぜんぶ見て、考えて、確認します。",
        theme_color: "#0F1115",
        background_color: "#0F1115",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg}"],
        // /api/* への画面遷移(OAuth等)はSWのSPAフォールバックで横取りせず、サーバーへ通す
        navigateFallbackDenylist: [/^\/api\//],
        // プッシュ受信ロジックを外部スクリプトとして読み込む
        // public/push-sw.js は vite build で dist/ にコピーされる
        importScripts: ["push-sw.js"],
      },
    }),
  ],
});
