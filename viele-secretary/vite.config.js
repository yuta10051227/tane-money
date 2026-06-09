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
        name: "VIELE secretary",
        short_name: "VIELE",
        description: "一人社長のための秘書ダッシュボード",
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
      },
    }),
  ],
});
