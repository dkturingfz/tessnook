# Tessnook 品牌素材

| 文件 | 用途 |
|---|---|
| `tessnook-mark.svg` | 标志（白底描边）。应用内 logo：登录页、顶栏（部署为 `public/logo.svg`） |
| `tessnook-appicon.svg` | App 图标（带底色与十字结构线）。浏览器标签页图标（部署为 `public/favicon.svg`），以及下列 PNG 的来源 |
| `tessnook-banner.svg` | 横幅。仓库 README 顶部 |
| `social-preview.png` | 1280×640 社交预览图，由横幅生成。需在 GitHub 仓库 Settings → General → Social preview 手动上传 |

由 `tessnook-appicon.svg` 生成的 PNG（在 `public/` 中）：`apple-touch-icon.png`（180）、`icon-192.png`、`icon-512.png`，供 iOS 主屏幕和 PWA 安装使用（见 `public/site.webmanifest`）。

修改 SVG 后，可以用 Playwright/Chromium 按相同尺寸重新导出 PNG。

## 配色

四个方块的位置与画布上四象限的位置一一对应，应用中的象限底色使用同一组颜色（`src/styles.css` 中的 `--q*-solid`）。

| 颜色 | 色值 | 位置 | 象限 |
|---|---|---|---|
| 青绿 | `#7FAEA6` | 左上 | Q2 重要 · 不紧急 |
| 浅蓝 | `#A9C2D9` | 右上 | Q1 重要 · 紧急 |
| 淡紫 | `#C8B9D8` | 左下 | Q3 不重要 · 不紧急 |
| 杏色 | `#E4BE95` | 右下 | Q4 不重要 · 紧急 |
| 墨绿灰 | `#2F3B3A` | 描边 | 文字与轮廓 |
| 背景 | `#F7FAF9` / `#F8FAFA` | — | 横幅与图标底色 |
