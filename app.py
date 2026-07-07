# -*- coding: utf-8 -*-
"""
復健紀錄手冊 — 線上版 (Rehab & vitals tracker)
Flask + SQLite，可部署到 Render，全家共用一份紀錄。

資料表：
  profile   — 病人基本資料與每日目標（單一列 id=1）
  rehab     — 每日復健紀錄（抬腿 / 站立 / 行走 / 備註 / 照片 / 語音）
  vitals    — 血壓血糖紀錄
  audit_log — 操作紀錄（新增 / 修改 / 刪除 / 備份 / 還原）
"""
import os
import json
import math
import sqlite3
from datetime import datetime, timezone
from urllib.parse import quote

from flask import (
    Flask, request, jsonify, g, session,
    render_template, redirect, url_for, Response, abort,
)

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "rehab.db")

# 有 DATABASE_URL（在 Render 填入 Neon 的連線字串）就用 PostgreSQL，資料永久保存；
# 沒有的話本機自動改用 SQLite，方便開發測試。
DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
IS_PG = DATABASE_URL.startswith("postgres")
if IS_PG:
    import psycopg
    from psycopg.rows import dict_row

# 若設定 APP_PASSWORD，整個網站需要輸入密碼才能使用（醫療資料建議開啟）。
APP_PASSWORD = os.environ.get("APP_PASSWORD") or ""

app = Flask(__name__)
# 未設定 SECRET_KEY 時用隨機金鑰（重啟後登入會失效，但絕不能用固定字串，
# 否則任何人都能偽造已登入的 session cookie 繞過密碼保護）。
app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(32)
app.config.update(
    # 上傳上限要 >= 備份檔可能的大小（含照片 / 語音 base64），否則自己的備份無法還原。
    MAX_CONTENT_LENGTH=200 * 1024 * 1024,  # 200MB
    JSON_AS_ASCII=False,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # 正式環境（HTTPS）預設帶 Secure；本機用 http 測試密碼時設 COOKIE_INSECURE=1。
    SESSION_COOKIE_SECURE=(os.environ.get("COOKIE_INSECURE") != "1"),
)


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "檔案太大，超過上傳上限。請減少照片 / 語音數量或分批處理。"}), 413

BACKUP_VERSION = 2

# 復健動作名稱（1–14），須與前端 EXERCISES 的順序一致。CSV 匯出的欄位標題用得到。
EXERCISE_NAMES = [
    "腳踝幫浦運動", "大腿壓毛巾", "直腿抬高", "坐姿抬腿(踢腿)",   # 肌力訓練
    "雙手高舉+原地踏步",                                          # 進階運動
    "繞肩膀", "推天抓空", "腳踝繞圈", "坐姿抬腿(活動膝蓋)",       # 關節舒緩
    "頭部上下運動(點頭仰頭)", "左右轉頭(看肩膀)", "左右側彎(耳朵貼肩膀)",
    "雙手阻力壓頭(前後對抗)", "單手溫和壓頭(側頸拉筋)",           # 頭頸運動
]


# ---------------------------------------------------------------------------
# 資料庫
# ---------------------------------------------------------------------------
def _schema_statements():
    # 自增主鍵語法：SQLite 與 PostgreSQL 不同
    idcol = "id SERIAL PRIMARY KEY" if IS_PG else "id INTEGER PRIMARY KEY AUTOINCREMENT"
    return [
        """CREATE TABLE IF NOT EXISTS profile (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            name       TEXT    DEFAULT '',
            start_date TEXT    DEFAULT '',
            updated_at TEXT    DEFAULT ''
        )""",
        f"""CREATE TABLE IF NOT EXISTS rehab (
            {idcol},
            date       TEXT NOT NULL,
            period     TEXT DEFAULT '',       -- 時段：上午 / 下午 / 晚上
            time       TEXT DEFAULT '',
            items      TEXT DEFAULT '{{}}',   -- JSON：{{"動作編號": 次數或 null}}，有 key 代表當次有做
            notes      TEXT DEFAULT '',
            photo      TEXT,                  -- 舊版單張照片（相容用；新版存在 photos）
            photos     TEXT DEFAULT '[]',     -- JSON 陣列：多張照片（最多 5 張）的 base64
            voice      TEXT,
            created_at TEXT DEFAULT '',
            updated_at TEXT DEFAULT ''
        )""",
        f"""CREATE TABLE IF NOT EXISTS vitals (
            {idcol},
            date          TEXT NOT NULL,
            time          TEXT DEFAULT '',
            systolic      INTEGER,
            diastolic     INTEGER,
            pulse         INTEGER,
            blood_sugar   REAL,
            sugar_context TEXT DEFAULT '',
            notes         TEXT DEFAULT '',
            created_at    TEXT DEFAULT '',
            updated_at    TEXT DEFAULT ''
        )""",
        f"""CREATE TABLE IF NOT EXISTS audit_log (
            {idcol},
            action     TEXT,
            detail     TEXT,
            created_at TEXT DEFAULT ''
        )""",
        f"""CREATE TABLE IF NOT EXISTS messages (
            {idcol},
            author     TEXT DEFAULT '',
            text       TEXT DEFAULT '',
            created_at TEXT DEFAULT ''
        )""",
        # 課表設定（key/value，schedule 存整份 JSON）
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')",
        # 課表每日打勾紀錄（某天完成了哪個課表項目）
        f"""CREATE TABLE IF NOT EXISTS schedule_log (
            {idcol},
            date       TEXT NOT NULL,
            item_id    TEXT NOT NULL,
            created_at TEXT DEFAULT ''
        )""",
        # 針對某筆復健紀錄的留言
        f"""CREATE TABLE IF NOT EXISTS rehab_comments (
            {idcol},
            rehab_id   INTEGER NOT NULL,
            author     TEXT DEFAULT '',
            text       TEXT DEFAULT '',
            created_at TEXT DEFAULT ''
        )""",
        # 針對某筆復健紀錄的按讚（每個名字一次）
        f"""CREATE TABLE IF NOT EXISTS rehab_likes (
            {idcol},
            rehab_id   INTEGER NOT NULL,
            liker      TEXT DEFAULT '',
            created_at TEXT DEFAULT ''
        )""",
        "CREATE INDEX IF NOT EXISTS idx_rehab_date  ON rehab(date)",
        "CREATE INDEX IF NOT EXISTS idx_vitals_date ON vitals(date)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_log_uniq ON schedule_log(date, item_id)",
        "CREATE INDEX IF NOT EXISTS idx_rc_rehab ON rehab_comments(rehab_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_rl_uniq ON rehab_likes(rehab_id, liker)",
    ]


def _raw_connect():
    if IS_PG:
        return psycopg.connect(DATABASE_URL, row_factory=dict_row)
    # timeout：多個 gunicorn worker 同時寫入時，等待鎖釋放而不是直接報錯
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA journal_mode = WAL")  # 讀寫並行，降低 database is locked
    return conn


def _init_connect():
    """建表 / migration 專用連線，用 autocommit：
    每一句 DDL 各自獨立，即使多個 worker 同時開機撞在一起（欄位已存在、主鍵重複），
    被 try/except 吞掉的錯誤也不會污染後面的語句（PostgreSQL 交易一旦出錯會整筆作廢）。"""
    if IS_PG:
        return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


class DB:
    """統一 SQLite / PostgreSQL 差異的薄封裝：
      - 把查詢裡的 ? 佔位符轉成 PostgreSQL 的 %s
      - insert() 取回新資料列的 id（兩種資料庫寫法不同）
      - 兩者的資料列都能用 row["欄位名"] 存取
    """

    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=()):
        if IS_PG:
            sql = sql.replace("?", "%s")
        return self.conn.execute(sql, tuple(params))

    def insert(self, sql, params=()):
        if IS_PG:
            cur = self.conn.execute(sql.replace("?", "%s") + " RETURNING id", tuple(params))
            return cur.fetchone()["id"]
        return self.conn.execute(sql, tuple(params)).lastrowid

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()


def get_db():
    if "db" not in g:
        g.db = DB(_raw_connect())
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _migrate(db):
    """把既有資料庫升到目前 schema（補上缺少的欄位）。可重複執行、可容錯。
    主要用途：舊版 rehab 表沒有 period / items 欄位（例如已上線的 Neon），開機時自動補上。"""
    try:
        if IS_PG:
            rows = db.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'rehab'"
            ).fetchall()
            existing = {r["column_name"] for r in rows}
        else:
            existing = {r["name"] for r in db.execute("PRAGMA table_info(rehab)").fetchall()}
    except Exception:  # noqa: BLE001
        return
    if not existing:
        return  # 資料表尚未建立，交給 CREATE TABLE
    todo = []
    add = "ALTER TABLE rehab ADD COLUMN IF NOT EXISTS " if IS_PG else "ALTER TABLE rehab ADD COLUMN "
    if "period" not in existing:
        todo.append(add + "period TEXT DEFAULT ''")
    if "items" not in existing:
        todo.append(add + "items TEXT DEFAULT '{}'")
    if "photos" not in existing:
        todo.append(add + "photos TEXT DEFAULT '[]'")  # 多張照片；舊的單張 photo 保留、讀取時合併
    for sql in todo:
        try:
            db.execute(sql)
        except Exception:  # noqa: BLE001  併發或已存在都安全略過（autocommit 下不會污染後續語句）
            pass


def init_db():
    # 用 autocommit 連線，並逐句容錯，避免多個 worker 同時開機時 DDL 撞車導致啟動失敗。
    db = DB(_init_connect())
    try:
        for stmt in _schema_statements():
            try:
                db.execute(stmt)
            except Exception:  # noqa: BLE001  併發建表可能撞車
                pass
        _migrate(db)
        # 確保 profile 有一列（多 worker 併發插入同一主鍵時忽略重複）
        row = db.execute("SELECT COUNT(*) AS c FROM profile").fetchone()
        if (row["c"] if row is not None else 0) == 0:
            try:
                db.execute(
                    "INSERT INTO profile (id, name, start_date, updated_at) VALUES (1, '', '', ?)",
                    (now_iso(),),
                )
            except Exception:  # noqa: BLE001  併發插入撞主鍵
                pass
        # 預建 schedule 設定列，避免第一次存課表時併發 INSERT 撞主鍵
        try:
            if not db.execute("SELECT 1 FROM settings WHERE key = 'schedule'").fetchone():
                db.execute("INSERT INTO settings (key, value) VALUES ('schedule', '')")
        except Exception:  # noqa: BLE001
            pass
    finally:
        db.close()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def audit(action, detail):
    get_db().execute(
        "INSERT INTO audit_log (action, detail, created_at) VALUES (?, ?, ?)",
        (action, detail, now_iso()),
    )


# ---------------------------------------------------------------------------
# 選填密碼保護
# ---------------------------------------------------------------------------
@app.before_request
def check_auth():
    if not APP_PASSWORD:
        return  # 未設定密碼 → 開放使用
    p = request.path
    if p == "/healthz" or p.startswith("/static/"):
        return
    if p in ("/login",) or session.get("authed"):
        return
    if p.startswith("/api/"):
        return jsonify({"error": "unauthorized"}), 401
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if not APP_PASSWORD:
        return redirect(url_for("index"))
    error = ""
    if request.method == "POST":
        if request.form.get("password", "") == APP_PASSWORD:
            session["authed"] = True
            session.permanent = True
            return redirect(url_for("index"))
        error = "密碼錯誤，請再試一次。"
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login") if APP_PASSWORD else url_for("index"))


# ---------------------------------------------------------------------------
# 頁面
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html", auth_enabled=bool(APP_PASSWORD))


@app.route("/healthz")
def healthz():
    return "ok", 200


# ---------------------------------------------------------------------------
# 工具：把 row 轉 dict、安全解析數字
# ---------------------------------------------------------------------------
def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


def as_int(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):  # 擋掉 inf / nan（int(inf) 會 OverflowError）
        return None
    return int(f)


def as_float(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # inf / nan 存進 SQLite 後會讓 JSON 變成不合法的 Infinity/NaN，直接擋掉。
    return f if math.isfinite(f) else None


def as_str(v):
    return "" if v is None else str(v).strip()


def as_num(v):
    """整數回傳 int（20 而非 20.0），小數回傳 float，空/無效回傳 None。"""
    f = as_float(v)
    if f is None:
        return None
    return int(f) if float(f).is_integer() else f


NUM_EXERCISES = len(EXERCISE_NAMES)  # 11


def clean_items(raw):
    """整理復健動作勾選 → {"1": 次數或 None, ...}；只保留 1..11、且有勾選的動作。"""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            raw = {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        try:
            kk = int(k)
        except (TypeError, ValueError):
            continue
        if 1 <= kk <= NUM_EXERCISES:
            out[str(kk)] = as_num(v)
    return out


MAX_PHOTOS = 5


def clean_photos(raw):
    """整理照片陣列 → 最多 5 張非空字串（base64 data URI）。"""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            raw = []
    if not isinstance(raw, list):
        return []
    return [x for x in raw if isinstance(x, str) and x][:MAX_PHOTOS]


def photo_list(d):
    """合併舊的單張 photo 與新的 photos 陣列，給前端顯示用。"""
    out = []
    if d.get("photo"):
        out.append(d["photo"])
    out.extend(clean_photos(d.get("photos")))
    return out[:MAX_PHOTOS]


def photos_json_from_req(d):
    """從請求取出照片陣列（相容舊的單張 photo），回傳要存進 photos 欄位的 JSON 字串。"""
    photos = d.get("photos")
    if photos is None and d.get("photo"):
        photos = [d.get("photo")]
    return json.dumps(clean_photos(photos), ensure_ascii=False)


def rehab_row_raw(row):
    """原始欄位（photo / photos 保持原樣，供備份完整來回）+ items 還原成物件。"""
    d = row_to_dict(row)
    d["items"] = clean_items(d.get("items"))
    return d


def rehab_out(row):
    """給前端：raw 欄位 + items 物件 + photo_list（合併後的照片陣列，最多 5 張）。"""
    d = rehab_row_raw(row)
    d["photo_list"] = photo_list(d)
    return d


# ---------------------------------------------------------------------------
# API：Profile / 目標
# ---------------------------------------------------------------------------
@app.route("/api/profile", methods=["GET"])
def get_profile():
    row = get_db().execute("SELECT * FROM profile WHERE id = 1").fetchone()
    return jsonify(row_to_dict(row) if row else {})


@app.route("/api/profile", methods=["PUT"])
def update_profile():
    d = request.get_json(force=True, silent=True) or {}
    db = get_db()
    db.execute(
        "UPDATE profile SET name = ?, start_date = ?, updated_at = ? WHERE id = 1",
        (as_str(d.get("name")), as_str(d.get("start_date")), now_iso()),
    )
    audit("PROFILE_UPDATE", as_str(d.get("name")))
    db.commit()
    row = db.execute("SELECT * FROM profile WHERE id = 1").fetchone()
    return jsonify(row_to_dict(row))


# ---------------------------------------------------------------------------
# API：復健紀錄
# ---------------------------------------------------------------------------
@app.route("/api/rehab", methods=["GET"])
def list_rehab():
    date = request.args.get("date")
    db = get_db()
    if date:
        rows = db.execute(
            "SELECT * FROM rehab WHERE date = ? ORDER BY time DESC, id DESC", (date,)
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM rehab ORDER BY date DESC, time DESC, id DESC"
        ).fetchall()
    out = [rehab_out(r) for r in rows]
    _attach_social(db, out)
    return jsonify(out)


def _attach_social(db, rows):
    """把每筆復健紀錄的留言與按讚一起帶出來（資料量小，一次抓完在 Python 分組）。"""
    if not rows:
        return rows
    cmap, lmap = {}, {}
    for c in db.execute("SELECT * FROM rehab_comments ORDER BY id").fetchall():
        cmap.setdefault(c["rehab_id"], []).append(
            {"id": c["id"], "author": c["author"] or "", "text": c["text"] or "", "created_at": c["created_at"] or ""})
    for lk in db.execute("SELECT rehab_id, liker FROM rehab_likes").fetchall():
        lmap.setdefault(lk["rehab_id"], []).append(lk["liker"] or "")
    for r in rows:
        r["comments"] = cmap.get(r["id"], [])
        r["likers"] = lmap.get(r["id"], [])
    return rows


@app.route("/api/rehab", methods=["POST"])
def create_rehab():
    d = request.get_json(force=True, silent=True) or {}
    date = as_str(d.get("date"))
    if not date:
        return jsonify({"error": "date is required"}), 400
    db = get_db()
    new_id = db.insert(
        """INSERT INTO rehab
             (date, period, time, items, notes, photo, photos, voice, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            date,
            as_str(d.get("period")),
            as_str(d.get("time")),
            json.dumps(clean_items(d.get("items")), ensure_ascii=False),
            as_str(d.get("notes")),
            None,  # 新版不用單張 photo，統一存 photos
            photos_json_from_req(d),
            d.get("voice") or None,
            now_iso(),
            now_iso(),
        ),
    )
    audit("REHAB_CREATE", f"#{new_id} {date} {as_str(d.get('period'))}")
    db.commit()
    row = db.execute("SELECT * FROM rehab WHERE id = ?", (new_id,)).fetchone()
    return jsonify(rehab_out(row)), 201


@app.route("/api/rehab/<int:rid>", methods=["PUT"])
def update_rehab(rid):
    d = request.get_json(force=True, silent=True) or {}
    db = get_db()
    exists = db.execute("SELECT id FROM rehab WHERE id = ?", (rid,)).fetchone()
    if not exists:
        return jsonify({"error": "not found"}), 404
    db.execute(
        """UPDATE rehab SET
             date = ?, period = ?, time = ?, items = ?,
             notes = ?, photo = ?, photos = ?, voice = ?, updated_at = ?
           WHERE id = ?""",
        (
            as_str(d.get("date")),
            as_str(d.get("period")),
            as_str(d.get("time")),
            json.dumps(clean_items(d.get("items")), ensure_ascii=False),
            as_str(d.get("notes")),
            None,  # 統一改存 photos，清掉舊的單張 photo（原本的照片已在前端載入、會一起送回 photos）
            photos_json_from_req(d),
            d.get("voice") or None,
            now_iso(),
            rid,
        ),
    )
    audit("REHAB_UPDATE", f"#{rid}")
    db.commit()
    row = db.execute("SELECT * FROM rehab WHERE id = ?", (rid,)).fetchone()
    return jsonify(rehab_out(row))


@app.route("/api/rehab/<int:rid>", methods=["DELETE"])
def delete_rehab(rid):
    db = get_db()
    db.execute("DELETE FROM rehab WHERE id = ?", (rid,))
    db.execute("DELETE FROM rehab_comments WHERE rehab_id = ?", (rid,))
    db.execute("DELETE FROM rehab_likes WHERE rehab_id = ?", (rid,))
    audit("REHAB_DELETE", f"#{rid}")
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API：復健紀錄的留言與按讚
# ---------------------------------------------------------------------------
@app.route("/api/rehab/<int:rid>/comments", methods=["POST"])
def add_rehab_comment(rid):
    d = request.get_json(force=True, silent=True) or {}
    text = as_str(d.get("text"))
    if not text:
        return jsonify({"error": "留言內容不可空白"}), 400
    db = get_db()
    if not db.execute("SELECT id FROM rehab WHERE id = ?", (rid,)).fetchone():
        return jsonify({"error": "not found"}), 404
    author = (as_str(d.get("author")) or "家人")[:40]
    new_id = db.insert(
        "INSERT INTO rehab_comments (rehab_id, author, text, created_at) VALUES (?, ?, ?, ?)",
        (rid, author, text[:1000], now_iso()),
    )
    audit("REHAB_COMMENT", f"#{rid}")
    db.commit()
    return jsonify({"id": new_id, "author": author, "text": text[:1000], "created_at": now_iso()}), 201


@app.route("/api/rehab/comments/<int:cid>", methods=["DELETE"])
def delete_rehab_comment(cid):
    db = get_db()
    db.execute("DELETE FROM rehab_comments WHERE id = ?", (cid,))
    audit("REHAB_COMMENT_DEL", f"#{cid}")
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/rehab/<int:rid>/like", methods=["POST"])
def toggle_rehab_like(rid):
    d = request.get_json(force=True, silent=True) or {}
    liker = (as_str(d.get("liker")) or "家人")[:40]
    db = get_db()
    if not db.execute("SELECT id FROM rehab WHERE id = ?", (rid,)).fetchone():
        return jsonify({"error": "not found"}), 404
    if bool(d.get("like")):
        _rehab_like_insert(db, rid, liker, now_iso())
    else:
        db.execute("DELETE FROM rehab_likes WHERE rehab_id = ? AND liker = ?", (rid, liker))
    db.commit()
    likers = [r["liker"] for r in db.execute("SELECT liker FROM rehab_likes WHERE rehab_id = ?", (rid,)).fetchall()]
    return jsonify({"likers": likers})


# ---------------------------------------------------------------------------
# API：血壓血糖
# ---------------------------------------------------------------------------
@app.route("/api/vitals", methods=["GET"])
def list_vitals():
    date = request.args.get("date")
    db = get_db()
    if date:
        rows = db.execute(
            "SELECT * FROM vitals WHERE date = ? ORDER BY time DESC, id DESC", (date,)
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM vitals ORDER BY date DESC, time DESC, id DESC"
        ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.route("/api/vitals", methods=["POST"])
def create_vitals():
    d = request.get_json(force=True, silent=True) or {}
    date = as_str(d.get("date"))
    if not date:
        return jsonify({"error": "date is required"}), 400
    db = get_db()
    new_id = db.insert(
        """INSERT INTO vitals
             (date, time, systolic, diastolic, pulse, blood_sugar, sugar_context, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            date,
            as_str(d.get("time")),
            as_int(d.get("systolic")),
            as_int(d.get("diastolic")),
            as_int(d.get("pulse")),
            as_float(d.get("blood_sugar")),
            as_str(d.get("sugar_context")),
            as_str(d.get("notes")),
            now_iso(),
            now_iso(),
        ),
    )
    audit("VITALS_CREATE", f"#{new_id} {date}")
    db.commit()
    row = db.execute("SELECT * FROM vitals WHERE id = ?", (new_id,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/api/vitals/<int:vid>", methods=["PUT"])
def update_vitals(vid):
    d = request.get_json(force=True, silent=True) or {}
    db = get_db()
    exists = db.execute("SELECT id FROM vitals WHERE id = ?", (vid,)).fetchone()
    if not exists:
        return jsonify({"error": "not found"}), 404
    db.execute(
        """UPDATE vitals SET
             date = ?, time = ?, systolic = ?, diastolic = ?, pulse = ?,
             blood_sugar = ?, sugar_context = ?, notes = ?, updated_at = ?
           WHERE id = ?""",
        (
            as_str(d.get("date")),
            as_str(d.get("time")),
            as_int(d.get("systolic")),
            as_int(d.get("diastolic")),
            as_int(d.get("pulse")),
            as_float(d.get("blood_sugar")),
            as_str(d.get("sugar_context")),
            as_str(d.get("notes")),
            now_iso(),
            vid,
        ),
    )
    audit("VITALS_UPDATE", f"#{vid}")
    db.commit()
    row = db.execute("SELECT * FROM vitals WHERE id = ?", (vid,)).fetchone()
    return jsonify(row_to_dict(row))


@app.route("/api/vitals/<int:vid>", methods=["DELETE"])
def delete_vitals(vid):
    db = get_db()
    db.execute("DELETE FROM vitals WHERE id = ?", (vid,))
    audit("VITALS_DELETE", f"#{vid}")
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API：留言板（給爸爸看的家人留言）
# ---------------------------------------------------------------------------
@app.route("/api/messages", methods=["GET"])
def list_messages():
    rows = get_db().execute("SELECT * FROM messages ORDER BY id DESC").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.route("/api/messages", methods=["POST"])
def create_message():
    d = request.get_json(force=True, silent=True) or {}
    text = as_str(d.get("text"))
    if not text:
        return jsonify({"error": "留言內容不可空白"}), 400
    db = get_db()
    new_id = db.insert(
        "INSERT INTO messages (author, text, created_at) VALUES (?, ?, ?)",
        (as_str(d.get("author"))[:40], text[:2000], now_iso()),
    )
    audit("MESSAGE_CREATE", f"#{new_id}")
    db.commit()
    row = db.execute("SELECT * FROM messages WHERE id = ?", (new_id,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/api/messages/<int:mid>", methods=["DELETE"])
def delete_message(mid):
    db = get_db()
    db.execute("DELETE FROM messages WHERE id = ?", (mid,))
    audit("MESSAGE_DELETE", f"#{mid}")
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API：課表（每天的復健 / 自訂項目安排）
# ---------------------------------------------------------------------------
def _get_setting(key):
    row = get_db().execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else ""


def _set_setting(key, value):
    db = get_db()
    # 先 UPDATE，沒有該列才 INSERT（schedule 列在 init_db 已預建，正常都走 UPDATE）
    cur = db.execute("UPDATE settings SET value = ? WHERE key = ?", (value, key))
    if getattr(cur, "rowcount", 0) == 0:
        db.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (key, value))


def _sched_log_insert(db, date, item_id, created_at):
    """寫入課表打勾，重複 (date,item_id) 直接忽略（配合 UNIQUE 索引，避免重複列）。"""
    if IS_PG:
        db.execute("INSERT INTO schedule_log (date, item_id, created_at) VALUES (?, ?, ?) "
                   "ON CONFLICT (date, item_id) DO NOTHING", (date, item_id, created_at))
    else:
        db.execute("INSERT OR IGNORE INTO schedule_log (date, item_id, created_at) VALUES (?, ?, ?)",
                   (date, item_id, created_at))


def _rehab_like_insert(db, rid, liker, created_at):
    """按讚，重複 (rehab_id,liker) 直接忽略。"""
    if IS_PG:
        db.execute("INSERT INTO rehab_likes (rehab_id, liker, created_at) VALUES (?, ?, ?) "
                   "ON CONFLICT (rehab_id, liker) DO NOTHING", (rid, liker, created_at))
    else:
        db.execute("INSERT OR IGNORE INTO rehab_likes (rehab_id, liker, created_at) VALUES (?, ?, ?)",
                   (rid, liker, created_at))


@app.route("/api/schedule", methods=["GET"])
def get_schedule():
    raw = _get_setting("schedule")
    try:
        data = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    return jsonify({"enabled": bool(data.get("enabled")),
                    "plan": data.get("plan") if isinstance(data.get("plan"), dict) else {}})


@app.route("/api/schedule", methods=["PUT"])
def put_schedule():
    d = request.get_json(force=True, silent=True) or {}
    enabled = bool(d.get("enabled"))
    plan = d.get("plan") if isinstance(d.get("plan"), dict) else {}
    _set_setting("schedule", json.dumps({"enabled": enabled, "plan": plan}, ensure_ascii=False))
    audit("SCHEDULE_UPDATE", "on" if enabled else "off")
    get_db().commit()
    return jsonify({"enabled": enabled, "plan": plan})


@app.route("/api/schedule/log")
def get_schedule_log():
    date = request.args.get("date")
    if not date:
        return jsonify({"error": "date is required"}), 400
    rows = get_db().execute("SELECT item_id FROM schedule_log WHERE date = ?", (date,)).fetchall()
    return jsonify([r["item_id"] for r in rows])


@app.route("/api/schedule/check", methods=["POST"])
def check_schedule():
    d = request.get_json(force=True, silent=True) or {}
    date = as_str(d.get("date"))
    item_id = as_str(d.get("item_id"))
    if not date or not item_id:
        return jsonify({"error": "date and item_id required"}), 400
    db = get_db()
    if bool(d.get("done")):
        _sched_log_insert(db, date, item_id, now_iso())
    else:
        db.execute("DELETE FROM schedule_log WHERE date = ? AND item_id = ?", (date, item_id))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API：今日彙總（目標達成進度）
# ---------------------------------------------------------------------------
@app.route("/api/summary")
def summary():
    date = request.args.get("date")
    if not date:
        return jsonify({"error": "date is required"}), 400
    db = get_db()
    rows = db.execute("SELECT period, items FROM rehab WHERE date = ?", (date,)).fetchall()
    done_all = set()
    by_period = {}
    for r in rows:
        keys = set(clean_items(r["items"]).keys())
        done_all |= keys
        per = as_str(r["period"]) or "其他"
        by_period[per] = by_period.get(per, set()) | keys
    return jsonify(
        {
            "date": date,
            "sessions": len(rows),
            "total": NUM_EXERCISES,
            "done": len(done_all),
            "by_period": {k: len(v) for k, v in by_period.items()},
        }
    )


# ---------------------------------------------------------------------------
# API：備份 / 還原
# ---------------------------------------------------------------------------
def _backup_payload(db):
    return {
        "app": "rehab-tracker",
        "version": BACKUP_VERSION,
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "profile": row_to_dict(db.execute("SELECT * FROM profile WHERE id = 1").fetchone()),
        # 用 raw 欄位（photo + photos），不含合併後的 photo_list，避免照片 base64 在備份裡重複、檔案變兩倍
        "rehab": [rehab_row_raw(r) for r in db.execute("SELECT * FROM rehab ORDER BY id").fetchall()],
        "vitals": [row_to_dict(r) for r in db.execute("SELECT * FROM vitals ORDER BY id").fetchall()],
        "messages": [row_to_dict(r) for r in db.execute("SELECT * FROM messages ORDER BY id").fetchall()],
        "settings": [row_to_dict(r) for r in db.execute("SELECT * FROM settings ORDER BY key").fetchall()],
        "schedule_log": [row_to_dict(r) for r in db.execute("SELECT * FROM schedule_log ORDER BY id").fetchall()],
        "rehab_comments": [row_to_dict(r) for r in db.execute("SELECT * FROM rehab_comments ORDER BY id").fetchall()],
        "rehab_likes": [row_to_dict(r) for r in db.execute("SELECT * FROM rehab_likes ORDER BY id").fetchall()],
        "audit_log": [row_to_dict(r) for r in db.execute("SELECT * FROM audit_log ORDER BY id").fetchall()],
    }


@app.route("/api/backup")
def backup():
    db = get_db()
    payload = _backup_payload(db)
    audit("BACKUP_EXPORT", f"{len(payload['rehab'])} rehab, {len(payload['vitals'])} vitals")
    db.commit()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return Response(
        body,
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="rehab_backup_{stamp}.json"'},
    )


@app.route("/api/restore", methods=["POST"])
def restore():
    d = request.get_json(force=True, silent=True) or {}
    if d.get("app") != "rehab-tracker":
        return jsonify({"error": "檔案格式不符，這不是復健紀錄的備份檔。"}), 400
    # 還原會清空現有資料，所以還原前先確認備份檔真的帶有紀錄陣列，
    # 避免因為檔案被截斷 / 手動編輯而把資料全部刪光卻回報成功。
    if not isinstance(d.get("rehab"), list) or not isinstance(d.get("vitals"), list):
        return jsonify({"error": "備份檔不完整（缺少紀錄資料），為了安全已取消還原。"}), 400
    db = get_db()

    # 還原前先在伺服器留一份安全快照，萬一還原到不對的檔案還能救回。
    try:
        snapshot = json.dumps(_backup_payload(db), ensure_ascii=False)
        with open(os.path.join(DATA_DIR, "pre_restore_backup.json"), "w", encoding="utf-8") as fh:
            fh.write(snapshot)
    except Exception:  # noqa: BLE001  安全快照失敗不應阻擋還原本身
        pass

    try:
        db.execute("DELETE FROM rehab")
        db.execute("DELETE FROM vitals")
        db.execute("DELETE FROM audit_log")
        # 留言/按讚是綁在 rehab 上的，rehab 每次都會整個重建，所以一律清空再依對應表重灌
        db.execute("DELETE FROM rehab_comments")
        db.execute("DELETE FROM rehab_likes")
        # 較新的資料表只在備份檔真的含有該區塊時才清空，
        # 這樣還原「舊版備份」不會把留言 / 課表一起清掉。
        if "messages" in d:
            db.execute("DELETE FROM messages")
        if "settings" in d:
            db.execute("DELETE FROM settings")
        if "schedule_log" in d:
            db.execute("DELETE FROM schedule_log")

        prof = d.get("profile") or {}
        db.execute(
            "UPDATE profile SET name = ?, start_date = ?, updated_at = ? WHERE id = 1",
            (as_str(prof.get("name")), as_str(prof.get("start_date")), now_iso()),
        )

        rehab_id_map = {}  # 備份的舊 id -> 還原後的新 id（留言/按讚要重新對應）
        for r in d.get("rehab", []):
            items = clean_items(r.get("items"))
            notes = as_str(r.get("notes"))
            # 相容舊版（v1）備份：舊格式用 leg_raise/standing/walking、沒有 items。
            # 為避免靜默遺失，把舊數字保留到備註，而不是變成空白紀錄。
            if not items and any(r.get(k) is not None for k in ("leg_raise", "standing", "walking")):
                legacy = []
                if r.get("leg_raise") is not None:
                    legacy.append(f"抬腿 {_num(r.get('leg_raise'))}")
                if r.get("standing") is not None:
                    legacy.append(f"站立 {_num(r.get('standing'))}")
                if r.get("walking") is not None:
                    legacy.append(f"行走 {_num(r.get('walking'))} 圈")
                if legacy:
                    tag = "（舊版紀錄）" + "、".join(legacy)
                    notes = (notes + "　" + tag).strip() if notes else tag
            new_id = db.insert(
                """INSERT INTO rehab
                     (date, period, time, items, notes, photo, photos, voice, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    as_str(r.get("date")),
                    as_str(r.get("period")),
                    as_str(r.get("time")),
                    json.dumps(items, ensure_ascii=False),
                    notes,
                    r.get("photo") or None,
                    json.dumps(clean_photos(r.get("photos")), ensure_ascii=False),
                    r.get("voice") or None,
                    as_str(r.get("created_at")) or now_iso(),
                    as_str(r.get("updated_at")) or now_iso(),
                ),
            )
            if r.get("id") is not None:
                rehab_id_map[r.get("id")] = new_id
        for v in d.get("vitals", []):
            db.execute(
                """INSERT INTO vitals
                     (date, time, systolic, diastolic, pulse, blood_sugar, sugar_context, notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    as_str(v.get("date")),
                    as_str(v.get("time")),
                    as_int(v.get("systolic")),
                    as_int(v.get("diastolic")),
                    as_int(v.get("pulse")),
                    as_float(v.get("blood_sugar")),
                    as_str(v.get("sugar_context")),
                    as_str(v.get("notes")),
                    as_str(v.get("created_at")) or now_iso(),
                    as_str(v.get("updated_at")) or now_iso(),
                ),
            )
        for m in d.get("messages", []) or []:
            db.execute(
                "INSERT INTO messages (author, text, created_at) VALUES (?, ?, ?)",
                (as_str(m.get("author")), as_str(m.get("text")), as_str(m.get("created_at")) or now_iso()),
            )
        for s in d.get("settings", []) or []:
            if as_str(s.get("key")):
                db.execute("INSERT INTO settings (key, value) VALUES (?, ?)",
                           (as_str(s.get("key")), as_str(s.get("value"))))
        for sl in d.get("schedule_log", []) or []:
            if as_str(sl.get("date")) and as_str(sl.get("item_id")):
                _sched_log_insert(db, as_str(sl.get("date")), as_str(sl.get("item_id")),
                                  as_str(sl.get("created_at")) or now_iso())
        for c in d.get("rehab_comments", []) or []:
            nid = rehab_id_map.get(c.get("rehab_id"))
            if nid is not None and as_str(c.get("text")):
                db.execute("INSERT INTO rehab_comments (rehab_id, author, text, created_at) VALUES (?, ?, ?, ?)",
                           (nid, as_str(c.get("author")), as_str(c.get("text")), as_str(c.get("created_at")) or now_iso()))
        for lk in d.get("rehab_likes", []) or []:
            nid = rehab_id_map.get(lk.get("rehab_id"))
            if nid is not None and as_str(lk.get("liker")):
                _rehab_like_insert(db, nid, as_str(lk.get("liker")), as_str(lk.get("created_at")) or now_iso())
        # 還原操作紀錄，讓備份是完整的來回（backup 有匯出 audit_log 就該還原）。
        for a in d.get("audit_log", []) or []:
            db.execute(
                "INSERT INTO audit_log (action, detail, created_at) VALUES (?, ?, ?)",
                (as_str(a.get("action")), as_str(a.get("detail")), as_str(a.get("created_at")) or now_iso()),
            )
        audit("BACKUP_RESTORE", f"{len(d.get('rehab', []))} rehab, {len(d.get('vitals', []))} vitals")
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        return jsonify({"error": f"還原失敗：{e}"}), 500
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API：CSV 匯出（給醫師看）
# ---------------------------------------------------------------------------
def _num(v):
    """整數不顯示 .0（例：2.0 -> 2、110.0 -> 110）。"""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return v


def _csv_response(header, rows, filename, ascii_name):
    import csv
    import io

    buf = io.StringIO()
    buf.write("﻿")  # BOM，讓 Excel 正確顯示中文
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    # HTTP header 只能是 latin-1，中文檔名要用 RFC 5987 的 filename* 編碼，
    # 並附上 ASCII 的 filename 當備援，否則會丟 UnicodeEncodeError。
    disp = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
    return Response(
        buf.getvalue(),
        content_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": disp},
    )


@app.route("/api/export/rehab.csv")
def export_rehab_csv():
    db = get_db()
    rows = db.execute("SELECT * FROM rehab ORDER BY date, time, id").fetchall()
    data = []
    for r in rows:
        items = clean_items(r["items"])
        cells = []
        for i in range(1, NUM_EXERCISES + 1):
            k = str(i)
            if k not in items:
                cells.append("")            # 當次沒做
            elif items[k] is None:
                cells.append("✓")           # 有做、沒填次數
            else:
                cells.append(_num(items[k]))  # 有做、有填次數/圈數
        data.append([r["date"], r["period"] or "", r["time"] or "", *cells, r["notes"] or ""])
    header = ["日期", "時段", "時間"] + [f"{i+1}.{EXERCISE_NAMES[i]}" for i in range(NUM_EXERCISES)] + ["備註/今天的感覺"]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return _csv_response(header, data, f"復健紀錄_{stamp}.csv", f"rehab_{stamp}.csv")


@app.route("/api/export/vitals.csv")
def export_vitals_csv():
    db = get_db()
    rows = db.execute("SELECT * FROM vitals ORDER BY date, time, id").fetchall()
    data = [
        [
            r["date"], r["time"],
            _num(r["systolic"]),
            _num(r["diastolic"]),
            _num(r["pulse"]),
            _num(r["blood_sugar"]),
            r["sugar_context"] or "",
            r["notes"] or "",
        ]
        for r in rows
    ]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return _csv_response(
        ["日期", "時間", "收縮壓", "舒張壓", "脈搏", "血糖(mg/dL)", "時機", "備註"],
        data,
        f"血壓血糖_{stamp}.csv",
        f"vitals_{stamp}.csv",
    )


# ---------------------------------------------------------------------------
init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=True)
