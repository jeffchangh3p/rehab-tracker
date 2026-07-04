# 復健紀錄手冊（線上版）

爸爸每天復健與血壓血糖的紀錄網站，全家與看護共用一份資料，手機打開就能填。
設計參考自紙本《爸爸復健紀錄手冊》，並比照 `tainan.onrender.com` 的架構部署到 Render。

> 「每天一點點，慢慢會更好。今天有做，就是勝利。」

---

## 功能

- **今日**：看今天的目標達成進度（抬腿 / 站立 / 行走），一鍵新增紀錄。
- **復健紀錄**：日期、時間、抬腿（次）、站立（次）、行走（圈）、備註 / 今天的感覺；可加**照片**與**語音**。
- **血壓血糖**：收縮壓 / 舒張壓 / 脈搏 / 血糖（可註明空腹、飯前、飯後、睡前）。
- **每日目標**：由醫師或家人設定（抬腿每次幾下、一天幾次；站立同理；行走一天幾圈）。
- **進步圖表**：近 7 天 / 30 天 / 全部的趨勢圖，看得到進步。
- **備份與匯出**：一鍵下載 JSON 備份、還原；另可匯出給醫師看的 CSV。
- **選填密碼保護**：醫療資料建議設定密碼。

---

## 技術

- 後端：Python **Flask** + **SQLite**
- 前端：原生 HTML / CSS / JavaScript（圖表用純 SVG 繪製，無外部相依）
- 部署：**Render**（gunicorn），資料放在 Render 的 persistent disk

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

## 部署到 Render（和 tainan 一樣的流程）

### 1. 放上 GitHub

```bash
cd rehab-tracker
git init
git add .
git commit -m "復健紀錄手冊 初版"
# 到 GitHub 建一個新的 repo，然後：
git remote add origin https://github.com/<你的帳號>/<repo 名稱>.git
git branch -M main
git push -u origin main
```

### 2. 在 Render 建立服務

1. 登入 [Render](https://dashboard.render.com/) → **New +** → **Blueprint**。
2. 選剛剛的 GitHub repo。Render 會自動讀取 `render.yaml`。
3. 按 **Apply** 開始部署，等幾分鐘就會有一個網址（例如 `https://rehab-tracker.onrender.com`）。

`render.yaml` 已經設定好：
- 用 `gunicorn` 啟動
- 掛載一顆 1GB 的 persistent disk 到 `/var/data`，**資料庫與照片語音都存在這裡，重啟不會不見**
- 自動產生 `SECRET_KEY`

> ⚠️ **關於資料保存**：persistent disk 需要付費方案（Render Starter，約 US$7/月）。
> 若想用**免費方案**：把 `render.yaml` 裡的 `disk:` 整段刪掉、`plan` 改成 `free`。
> 但免費方案的磁碟是**暫時的**，服務重啟後資料會消失，請務必**常常到「設定 → 下載備份」** 保存。

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
| `DATA_DIR` | 資料庫與上傳檔案存放位置 | `./data` |
| `SECRET_KEY` | 登入 cookie 簽章用；**未設定時每次啟動用隨機值**（登入會在重啟後失效，但不會有安全漏洞）。正式部署請設定固定值 | 隨機 |
| `APP_PASSWORD` | 設定後啟用密碼保護 | 未設定（開放使用） |
| `COOKIE_INSECURE` | 設為 `1` 時關閉 cookie 的 Secure 旗標，**只在本機用 http 測試登入時才需要**（正式 HTTPS 環境請勿設定） | 未設定 |
| `PORT` | 本機執行的埠號 | `5001` |
