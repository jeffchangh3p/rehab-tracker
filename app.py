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

BACKUP_VERSION = 1


# ---------------------------------------------------------------------------
# 資料庫
# ---------------------------------------------------------------------------
def _schema_statements():
    # 自增主鍵語法：SQLite 與 PostgreSQL 不同
    idcol = "id SERIAL PRIMARY KEY" if IS_PG else "id INTEGER PRIMARY KEY AUTOINCREMENT"
    return [
        """CREATE TABLE IF NOT EXISTS profile (
            id                    INTEGER PRIMARY KEY CHECK (id = 1),
            name                  TEXT    DEFAULT '',
            start_date            TEXT    DEFAULT '',
            goal_leg_raise_reps   INTEGER DEFAULT 0,
            goal_leg_raise_times  INTEGER DEFAULT 0,
            goal_standing_reps    INTEGER DEFAULT 0,
            goal_standing_times   INTEGER DEFAULT 0,
            goal_walking_laps     INTEGER DEFAULT 0,
            updated_at            TEXT    DEFAULT ''
        )""",
        f"""CREATE TABLE IF NOT EXISTS rehab (
            {idcol},
            date       TEXT NOT NULL,
            time       TEXT DEFAULT '',
            leg_raise  INTEGER,
            standing   INTEGER,
            walking    REAL,
            notes      TEXT DEFAULT '',
            photo      TEXT,
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
        "CREATE INDEX IF NOT EXISTS idx_rehab_date  ON rehab(date)",
        "CREATE INDEX IF NOT EXISTS idx_vitals_date ON vitals(date)",
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


def init_db():
    db = DB(_raw_connect())
    for stmt in _schema_statements():
        db.execute(stmt)
    # 確保 profile 有一列
    row = db.execute("SELECT COUNT(*) AS c FROM profile").fetchone()
    if (row["c"] if row is not None else 0) == 0:
        db.execute(
            "INSERT INTO profile (id, name, start_date, updated_at) VALUES (1, '', '', ?)",
            (now_iso(),),
        )
    db.commit()
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
        """UPDATE profile SET
             name = ?, start_date = ?,
             goal_leg_raise_reps = ?, goal_leg_raise_times = ?,
             goal_standing_reps = ?, goal_standing_times = ?,
             goal_walking_laps = ?, updated_at = ?
           WHERE id = 1""",
        (
            as_str(d.get("name")),
            as_str(d.get("start_date")),
            as_int(d.get("goal_leg_raise_reps")) or 0,
            as_int(d.get("goal_leg_raise_times")) or 0,
            as_int(d.get("goal_standing_reps")) or 0,
            as_int(d.get("goal_standing_times")) or 0,
            as_int(d.get("goal_walking_laps")) or 0,
            now_iso(),
        ),
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
    return jsonify([row_to_dict(r) for r in rows])


@app.route("/api/rehab", methods=["POST"])
def create_rehab():
    d = request.get_json(force=True, silent=True) or {}
    date = as_str(d.get("date"))
    if not date:
        return jsonify({"error": "date is required"}), 400
    db = get_db()
    new_id = db.insert(
        """INSERT INTO rehab
             (date, time, leg_raise, standing, walking, notes, photo, voice, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            date,
            as_str(d.get("time")),
            as_int(d.get("leg_raise")),
            as_int(d.get("standing")),
            as_float(d.get("walking")),
            as_str(d.get("notes")),
            d.get("photo") or None,
            d.get("voice") or None,
            now_iso(),
            now_iso(),
        ),
    )
    audit("REHAB_CREATE", f"#{new_id} {date}")
    db.commit()
    row = db.execute("SELECT * FROM rehab WHERE id = ?", (new_id,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/api/rehab/<int:rid>", methods=["PUT"])
def update_rehab(rid):
    d = request.get_json(force=True, silent=True) or {}
    db = get_db()
    exists = db.execute("SELECT id FROM rehab WHERE id = ?", (rid,)).fetchone()
    if not exists:
        return jsonify({"error": "not found"}), 404
    db.execute(
        """UPDATE rehab SET
             date = ?, time = ?, leg_raise = ?, standing = ?, walking = ?,
             notes = ?, photo = ?, voice = ?, updated_at = ?
           WHERE id = ?""",
        (
            as_str(d.get("date")),
            as_str(d.get("time")),
            as_int(d.get("leg_raise")),
            as_int(d.get("standing")),
            as_float(d.get("walking")),
            as_str(d.get("notes")),
            d.get("photo") or None,
            d.get("voice") or None,
            now_iso(),
            rid,
        ),
    )
    audit("REHAB_UPDATE", f"#{rid}")
    db.commit()
    row = db.execute("SELECT * FROM rehab WHERE id = ?", (rid,)).fetchone()
    return jsonify(row_to_dict(row))


@app.route("/api/rehab/<int:rid>", methods=["DELETE"])
def delete_rehab(rid):
    db = get_db()
    db.execute("DELETE FROM rehab WHERE id = ?", (rid,))
    audit("REHAB_DELETE", f"#{rid}")
    db.commit()
    return jsonify({"ok": True})


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
# API：今日彙總（目標達成進度）
# ---------------------------------------------------------------------------
@app.route("/api/summary")
def summary():
    date = request.args.get("date")
    if not date:
        return jsonify({"error": "date is required"}), 400
    db = get_db()
    prof = db.execute("SELECT * FROM profile WHERE id = 1").fetchone()
    agg = db.execute(
        """SELECT
             COALESCE(SUM(leg_raise), 0) AS leg_raise,
             COALESCE(SUM(standing), 0)  AS standing,
             COALESCE(SUM(walking), 0)   AS walking,
             COUNT(*)                    AS sessions
           FROM rehab WHERE date = ?""",
        (date,),
    ).fetchone()
    p = row_to_dict(prof) if prof else {}
    goal_leg = (p.get("goal_leg_raise_reps") or 0) * (p.get("goal_leg_raise_times") or 0)
    goal_stand = (p.get("goal_standing_reps") or 0) * (p.get("goal_standing_times") or 0)
    goal_walk = p.get("goal_walking_laps") or 0
    return jsonify(
        {
            "date": date,
            "sessions": agg["sessions"],
            "leg_raise": {"done": agg["leg_raise"], "goal": goal_leg},
            "standing": {"done": agg["standing"], "goal": goal_stand},
            "walking": {"done": agg["walking"], "goal": goal_walk},
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
        "rehab": [row_to_dict(r) for r in db.execute("SELECT * FROM rehab ORDER BY id").fetchall()],
        "vitals": [row_to_dict(r) for r in db.execute("SELECT * FROM vitals ORDER BY id").fetchall()],
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

        prof = d.get("profile") or {}
        db.execute(
            """UPDATE profile SET
                 name = ?, start_date = ?,
                 goal_leg_raise_reps = ?, goal_leg_raise_times = ?,
                 goal_standing_reps = ?, goal_standing_times = ?,
                 goal_walking_laps = ?, updated_at = ?
               WHERE id = 1""",
            (
                as_str(prof.get("name")),
                as_str(prof.get("start_date")),
                as_int(prof.get("goal_leg_raise_reps")) or 0,
                as_int(prof.get("goal_leg_raise_times")) or 0,
                as_int(prof.get("goal_standing_reps")) or 0,
                as_int(prof.get("goal_standing_times")) or 0,
                as_int(prof.get("goal_walking_laps")) or 0,
                now_iso(),
            ),
        )

        for r in d.get("rehab", []):
            db.execute(
                """INSERT INTO rehab
                     (date, time, leg_raise, standing, walking, notes, photo, voice, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    as_str(r.get("date")),
                    as_str(r.get("time")),
                    as_int(r.get("leg_raise")),
                    as_int(r.get("standing")),
                    as_float(r.get("walking")),
                    as_str(r.get("notes")),
                    r.get("photo") or None,
                    r.get("voice") or None,
                    as_str(r.get("created_at")) or now_iso(),
                    as_str(r.get("updated_at")) or now_iso(),
                ),
            )
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
    data = [
        [
            r["date"], r["time"],
            _num(r["leg_raise"]),
            _num(r["standing"]),
            _num(r["walking"]),
            r["notes"] or "",
        ]
        for r in rows
    ]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return _csv_response(
        ["日期", "時間", "抬腿(次)", "站立(次)", "行走(圈)", "備註/今天的感覺"],
        data,
        f"復健紀錄_{stamp}.csv",
        f"rehab_{stamp}.csv",
    )


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
