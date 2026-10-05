# 教學系統入口

中小學素養學習系統的**入口網站**：把五套線上練習系統分門別類整理成一頁，直接點卡片就能進入。

線上網址 → **https://joshua19683721.github.io/menu/**

---

## 收錄的系統

| 分類 | 系統 | 網址 | 一句話 |
|:--|:--|:--|:--|
| 中文｜閱讀理解 | 📖 ReadExpress-CoT 閱讀快線 | [/c1/](https://joshua19683721.github.io/c1/) | 一篇文章十階提問，答錯先給解析卡再往下走 |
| 中文｜寫作思辨 | 🎒 國文會考魔法寫作小幫手 | [/writing_system_framework/](https://joshua19683721.github.io/writing_system_framework/) | 先說後寫三步驟，產出會考架構作文 + K/C 診斷卡 |
| 英文｜互動課本 | 📚 A2 Key 與 108 課綱會考英文・60 課 | [/m1/](https://joshua19683721.github.io/m1/) | 60 篇三段式互動故事，逐句可朗讀、可看文法解析 |
| 英文｜輸入練習 | ⌨️ 場景式英文輸入練習 · A2 Key | [/m2/](https://joshua19683721.github.io/m2/) | 60 場景 5,685 單元，官方詞表覆蓋率 100% |
| 英文｜輸入練習 | 🍎 場景單字輸入練習 · 英語單字口袋書 | [/m3/](https://joshua19683721.github.io/m3/) | 889 條單字 1–6 級，單字 → 詞組 → 整句循序漸進 |

頁面上另有「建議學習路徑」與「共同設計原則」兩節，說明五套系統怎麼串成一條循環，
以及它們共同的底線（純前端、資料留在本機、繁體台灣用字、有測試稽核）。

---

## 這個 repo 本身

純靜態頁面，沒有後端、沒有建置步驟、沒有外部相依。

```
index.html            頁面結構（分類、卡片、功能介紹、學習路徑）
assets/css/app.css    樣式（含深色模式、列印樣式、響應式）
assets/js/app.js      搜尋、分類篩選、/ 快速聚焦
.nojekyll             讓 GitHub Pages 不走 Jekyll
.github/workflows/    自動部署 + 部署前檢查
```

### 本機預覽

```powershell
python -m http.server 8770
# 開 http://127.0.0.1:8770/
```

### 部署

push 到 `main` 之後，`.github/workflows/pages.yml` 會自動：

1. **檢查** —— 必要檔案存在、`index.html` 沒有簡體字、所有相對路徑（`href` / `src`）都指向實際存在的檔案
2. **部署** —— 把 `_site/` 發佈到 GitHub Pages

任何一關不過就不會上線。

---

## 頁面功能

- **搜尋**：比對卡片標題、功能說明與標籤，空白鍵分詞，全部命中才顯示；按 `/` 直接聚焦
- **分類篩選**：中文 / 閱讀 / 寫作 / 英文 / 課本 / 打字，與搜尋條件疊加
- **可分享的篩選狀態**：`menu/#f=打字` 會直接套用該分類

---

## 授權與出處

詞彙資料來源：Cambridge English, *A2 Key / A2 Key for Schools Vocabulary List*（© UCLES）。
五套系統的英文例句、故事、中文解析與教學設計皆為各專案原創。
