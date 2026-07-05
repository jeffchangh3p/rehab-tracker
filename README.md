# 復健紀錄手冊（線上版）

爸爸每天復健與血壓血糖的紀錄網站，全家與看護共用一份資料，手機打開就能填。
設計參考自紙本《爸爸復健紀錄手冊》，並比照 `tainan.onrender.com` 的架構部署到 Render。

> 「每天一點點，慢慢會更好。今天有做，就是勝利。」

---

## 功能

- **11 個復健動作**（來自《復健動作AB分解圖.pdf》，分肌力訓練 / 進階運動 / 關節舒緩三類）：打勾清單，做了就點一下、次數可留白；每個動作都能看**示範動畫（GIF）＋ 做法 ＋ 好處**。
- **依時段紀錄**：每筆標記 **上午 / 下午 / 晚上**，方便日後分析。
- **課表**：可依星期幾安排每天要做的項目（復健動作 + 自訂項目如散步 / 量血壓 / 吃藥，可寫時間）。開啟後「今日」頁顯示當天課表讓長輩照著做、打勾；可隨時在「設定 → 課表」調整，或整個關閉。
- **留言板**：家人留言給爸爸看（大字好讀、可刪除）。
- **今日**：顯示當天完成度 **X / 14 項**（或課表完成度）與各時段小計，一鍵新增紀錄；可加**照片**與**語音**。
- **血壓血糖**：收縮壓 / 舒張壓 / 脈搏 / 血糖（可註明空腹、飯前、飯後、睡前）。
- **進步圖表**：近 7 天 / 30 天 / 全部，每日各時段完成動作數、血壓與血糖趨勢。
- **備份與匯出**：一鍵下載 JSON 備份、還原；另可匯出給醫師看的 CSV（復健為寬表格，每個動作一欄，方便分析）。
- **選填密碼保護**：醫療資料建議設定密碼。

---

## 技術

- 後端：Python **Flask**；資料庫可用 **SQLite**（本機開發）或 **PostgreSQL**（線上，透過 `DATABASE_URL`）
- 前端：原生 HTML / CSS / JavaScript（圖表用純 SVG 繪製，無外部相依）
- 部署：**Render 免費方案** web 服務 + **Neon 免費 PostgreSQL**（資料永久保存）

---

## 在自己電腦上執行（本機測試）

```bash
cd rehab-tracker
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

打開瀏覽器： <http://127.0.0.1:5001>

資料庫會自動建立在 `rehab-tracker/data/rehab.db`。

---

## 部署到 Render（免費方案 + Neon 免費資料庫）

> 為什麼要 Neon？Render 免費 web 服務的磁碟是**暫時的**，服務休眠 / 重啟就會清空，
> 所以資料庫不能放在上面。把資料放在免費的 **Neon PostgreSQL**（永久保存）即可解決。

### 1. 建立免費 Neon 資料庫

1. 到 [neon.tech](https://neon.tech) 註冊（可用 Google / GitHub 登入）。
2. 建立一個 Project（名稱隨意，例如 `rehab-tracker`；區域選離台灣近的，如 Singapore）。
3. 建好後複製它給的**連線字串（Connection string）**，長得像：
   `postgresql://使用者:密碼@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/dbname?sslmode=require`
   （若有「Pooled connection」選項就選它。）**這串等一下要貼到 Render，請勿放進 GitHub。**

### 2. 在 Render 建立服務

1. 登入 [Render](https://dashboard.render.com/blueprints) → **New Blueprint Instance**。
2. 選 GitHub repo **rehab-tracker**（第一次會請你授權 Render 的 GitHub App）。Render 會自動讀取 `render.yaml`。
3. 系統會請你填 `DATABASE_URL` → 貼上剛剛 Neon 的連線字串。
4. 按 **Apply** / **Deploy**，等幾分鐘就會有一個網址（例如 `https://rehab-tracker.onrender.com`）。

`render.yaml` 已設定好：`plan: free`、`gunicorn` 啟動、自動產生 `SECRET_KEY`、
`DATABASE_URL` 由你在後台填入。

> 免費方案的小提醒：閒置 15 分鐘會休眠，下次開啟需約 1 分鐘喚醒（**資料存在 Neon，不會遺失**）。
> Neon 免費約 0.5GB，主要放文字紀錄很夠用；若照片 / 語音很多可能要留意容量。

### 3.（強烈建議）設定密碼

醫療資料放在公開網址上，建議加一組密碼：

1. Render 後台 → 你的服務 → **Environment** → **Add Environment Variable**
2. Key 填 `APP_PASSWORD`，Value 填你想要的密碼 → 儲存（服務會自動重啟）

之後進網站會先要求輸入密碼。想關掉就把這個變數刪除。

---

## 資料備份（很重要）

- 到 **設定 → ⬇ 下載備份檔（JSON）**，存到手機或電腦。
- 要換機器 / 還原時：**設定 → ⬆ 從備份檔還原**（會覆蓋現有資料，還原前建議先下載一次目前的備份）。
- 給醫師看：**設定 → 匯出 CSV**（復健、血壓血糖各一份，Excel 可直接開）。

**還原的安全機制**（避免不小心把資料弄丟）：

- 還原前若備份檔不完整（例如在通訊軟體傳輸時被截斷、缺少紀錄資料），會直接**拒絕還原**並保留現有資料，不會清空。
- 每次還原前，伺服器會自動把「目前的資料」存成一份 `pre_restore_backup.json`（放在 `DATA_DIR`）。萬一還原到錯的檔案，還能從這份救回。
- 語音每段最長 **2 分鐘**，避免備份檔過大到無法還原。

---

## 環境變數一覽

| 變數 | 說明 | 預設 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 連線字串（Neon）。**有設定就用 PostgreSQL；沒設定就用本機 SQLite** | 未設定（用 SQLite） |
| `DATA_DIR` | SQLite 資料庫與暫存檔位置（用 PostgreSQL 時僅存還原前的安全快照） | `./data` |
| `SECRET_KEY` | 登入 cookie 簽章用；**未設定時每次啟動用隨機值**（登入會在重啟後失效，但不會有安全漏洞）。正式部署請設定固定值 | 隨機 |
| `APP_PASSWORD` | 設定後啟用密碼保護 | 未設定（開放使用） |
| `COOKIE_INSECURE` | 設為 `1` 時關閉 cookie 的 Secure 旗標，**只在本機用 http 測試登入時才需要**（正式 HTTPS 環境請勿設定） | 未設定 |
| `PORT` | 本機執行的埠號 | `5001` |
