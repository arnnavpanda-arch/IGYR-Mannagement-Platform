import json
import urllib.request
import ssl
import hashlib
import secrets
import time
import sqlite3
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from config import TURSO_HTTP_URL, TURSO_AUTH_TOKEN

_DB_CACHE: Optional[Dict[str, Any]] = None
_DB_CACHE_TIME: float = 0.0
_DB_VERSION: int = int(time.time() * 1000)

_USE_LOCAL_SQLITE: bool = False
_LOCAL_CONN: Optional[sqlite3.Connection] = None
_LOCAL_INITIALIZING: bool = False

def _get_local_conn() -> sqlite3.Connection:
    global _LOCAL_CONN
    if _LOCAL_CONN is None:
        db_path = Path(__file__).resolve().parent / "local_db.sqlite"
        _LOCAL_CONN = sqlite3.connect(str(db_path), check_same_thread=False)
        _LOCAL_CONN.row_factory = sqlite3.Row
    return _LOCAL_CONN

def _turso_args_to_py(args: List[Dict[str, Any]]) -> List[Any]:
    py_args = []
    for a in args:
        t = a.get("type")
        v = a.get("value")
        if t == "null" or v is None:
            py_args.append(None)
        elif t == "integer":
            py_args.append(int(v))
        elif t == "float":
            py_args.append(float(v))
        else:
            py_args.append(v)
    return py_args

def _py_row_to_turso(row: Any) -> List[Dict[str, Any]]:
    turso_cells = []
    for val in row:
        if val is None:
            turso_cells.append({"type": "null"})
        elif isinstance(val, bool):
            turso_cells.append({"type": "integer", "value": "1" if val else "0"})
        elif isinstance(val, int):
            turso_cells.append({"type": "integer", "value": str(val)})
        elif isinstance(val, float):
            turso_cells.append({"type": "float", "value": val})
        else:
            turso_cells.append({"type": "text", "value": str(val)})
    return turso_cells

def _execute_sqlite_pipeline(requests: List[Dict[str, Any]]) -> Dict[str, Any]:
    conn = _get_local_conn()
    results = []
    cursor = conn.cursor()
    try:
        for req in requests:
            req_type = req.get("type")
            if req_type == "execute":
                stmt = req.get("stmt", {})
                sql = stmt.get("sql", "").strip()
                args = stmt.get("args", [])
                py_args = _turso_args_to_py(args)
                try:
                    cursor.execute(sql, py_args)
                    cols = []
                    rows = []
                    if cursor.description:
                        cols = [{"name": d[0]} for d in cursor.description]
                        for r in cursor.fetchall():
                            rows.append(_py_row_to_turso(r))
                    results.append({
                        "type": "ok",
                        "response": {
                            "result": {
                                "cols": cols,
                                "rows": rows,
                                "affected_row_count": cursor.rowcount if cursor.rowcount >= 0 else 0,
                                "last_insert_rowid": cursor.lastrowid
                            }
                        }
                    })
                except Exception as e:
                    results.append({"type": "error", "error": str(e)})
            elif req_type == "close":
                conn.commit()
        return {"results": results}
    except Exception as e:
        conn.rollback()
        raise e

def invalidate_db_cache():
    global _DB_CACHE, _DB_CACHE_TIME, _DB_VERSION
    _DB_CACHE = None
    _DB_CACHE_TIME = 0.0
    _DB_VERSION = int(time.time() * 1000)

def hash_password(password: str) -> str:
    """Hash password using PBKDF2-HMAC-SHA256 with 100,000 iterations and random salt."""
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100000)
    return f"pbkdf2:sha256:100000${salt}${key.hex()}"

def verify_password(stored_password_hash: str, provided_password: str) -> bool:
    """Verify password against stored PBKDF2 hash or legacy password."""
    if not stored_password_hash or not provided_password:
        return False
    if not stored_password_hash.startswith("pbkdf2:sha256:"):
        return secrets.compare_digest(stored_password_hash, provided_password)
    try:
        parts = stored_password_hash.split("$")
        if len(parts) != 3:
            return False
        iterations = int(parts[0].split(":")[2])
        salt = parts[1]
        expected_key = parts[2]
        new_key = hashlib.pbkdf2_hmac("sha256", provided_password.encode("utf-8"), salt.encode("utf-8"), iterations)
        return secrets.compare_digest(new_key.hex(), expected_key)
    except Exception:
        return False


def _format_arg(a: Any) -> Dict[str, Any]:
    if a is None:
        return {"type": "null"}
    elif isinstance(a, bool):
        return {"type": "integer", "value": "1" if a else "0"}
    elif isinstance(a, int):
        return {"type": "integer", "value": str(a)}
    elif isinstance(a, float):
        return {"type": "float", "value": a}
    else:
        return {"type": "text", "value": str(a)}

def _parse_row(cols: List[str], row: List[Dict[str, Any]]) -> Dict[str, Any]:
    res = {}
    for col_name, cell in zip(cols, row):
        cell_type = cell.get("type")
        val = cell.get("value")
        if cell_type == "null" or val is None:
            res[col_name] = None
        elif cell_type == "integer":
            res[col_name] = int(val)
        elif cell_type == "float":
            res[col_name] = float(val)
        else:
            res[col_name] = val
    return res

def execute_pipeline(requests: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Execute raw pipeline requests on Turso via HTTP v2 API or fallback to local SQLite."""
    global _USE_LOCAL_SQLITE, _LOCAL_INITIALIZING

    url = f"{TURSO_HTTP_URL}/v2/pipeline"
    payload = {"requests": requests}
    data = json.dumps(payload).encode("utf-8")
    
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {TURSO_AUTH_TOKEN}",
            "Content-Type": "application/json"
        },
        method="POST"
    )
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=6) as resp:
            _USE_LOCAL_SQLITE = False
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        err_msg = str(e)
        if any(keyword in err_msg for keyword in [
            "Errno 8", "nodename nor servname", "timed out", "Connection refused",
            "Name or service not known", "Temporary failure in name resolution",
            "Network is unreachable", "Operation not permitted"
        ]):
            if not _USE_LOCAL_SQLITE:
                print(f"[Turso Notice] Cloud database endpoint unreachable ({err_msg}). Switching to local fallback.")
            _USE_LOCAL_SQLITE = True
            if not _LOCAL_INITIALIZING:
                _LOCAL_INITIALIZING = True
                try:
                    init_db()
                finally:
                    _LOCAL_INITIALIZING = False
            return _execute_sqlite_pipeline(requests)
        raise e

def query(sql: str, params: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
    """Execute a SELECT query and return list of dicts."""
    stmt: Dict[str, Any] = {"sql": sql}
    if params:
        stmt["args"] = [_format_arg(p) for p in params]
    
    requests = [
        {"type": "execute", "stmt": stmt},
        {"type": "close"}
    ]
    resp = execute_pipeline(requests)
    results = resp.get("results", [])
    if not results or results[0].get("type") != "ok":
        error = results[0].get("error") if results else "Unknown error"
        raise Exception(f"Turso query error: {error}")
    
    exec_res = results[0].get("response", {}).get("result", {})
    cols = [c["name"] for c in exec_res.get("cols", [])]
    raw_rows = exec_res.get("rows", [])
    return [_parse_row(cols, r) for r in raw_rows]

def execute(sql: str, params: Optional[List[Any]] = None) -> Dict[str, Any]:
    """Execute INSERT/UPDATE/DELETE statement."""
    stmt: Dict[str, Any] = {"sql": sql}
    if params:
        stmt["args"] = [_format_arg(p) for p in params]
    
    requests = [
        {"type": "execute", "stmt": stmt},
        {"type": "close"}
    ]
    resp = execute_pipeline(requests)
    results = resp.get("results", [])
    if not results or results[0].get("type") != "ok":
        error = results[0].get("error") if results else "Unknown error"
        raise Exception(f"Turso execute error: {error}")
    
    return results[0].get("response", {}).get("result", {})

def execute_batch(statements: List[Tuple[str, Optional[List[Any]]]]) -> None:
    """Execute a batch of statements in a single round-trip."""
    if not statements:
        return
    requests = []
    for item in statements:
        if isinstance(item, str):
            sql = item
            params = None
        else:
            sql, params = item
        stmt: Dict[str, Any] = {"sql": sql}
        if params:
            stmt["args"] = [_format_arg(p) for p in params]
        requests.append({"type": "execute", "stmt": stmt})
    requests.append({"type": "close"})
    
    resp = execute_pipeline(requests)
    for res in resp.get("results", []):
        if res.get("type") == "error":
            raise Exception(f"Turso batch execution error: {res.get('error')}")

def init_db():
    """Ensure all required tables and default admin account exist in Turso."""
    statements = [
        """CREATE TABLE IF NOT EXISTS system_config (
            key TEXT PRIMARY KEY,
            value TEXT
        );""",
        """CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            pw TEXT NOT NULL,
            role TEXT NOT NULL,
            name TEXT,
            inst TEXT,
            email TEXT
        );""",
        """CREATE TABLE IF NOT EXISTS institutes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            loc TEXT,
            det TEXT,
            email TEXT,
            logo TEXT
        );""",
        """CREATE TABLE IF NOT EXISTS classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inst TEXT NOT NULL,
            name TEXT NOT NULL
        );""",
        """CREATE TABLE IF NOT EXISTS subjects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inst TEXT NOT NULL,
            name TEXT NOT NULL,
            cls TEXT,
            teacher TEXT,
            fee REAL DEFAULT 0,
            type TEXT DEFAULT 'compulsory'
        );""",
        """CREATE TABLE IF NOT EXISTS students (
            uid TEXT PRIMARY KEY,
            inst TEXT NOT NULL,
            name TEXT NOT NULL,
            cls TEXT,
            feeType TEXT DEFAULT 'one',
            fee REAL DEFAULT 0,
            joinDate TEXT,
            email TEXT,
            phone TEXT,
            addr TEXT,
            photo TEXT,
            done INTEGER DEFAULT 0,
            optSubs TEXT
        );""",
        """CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inst TEXT NOT NULL,
            uid TEXT NOT NULL,
            cls TEXT,
            date TEXT NOT NULL,
            p INTEGER DEFAULT 1,
            sub TEXT
        );""",
        """CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY,
            inst TEXT NOT NULL,
            uid TEXT NOT NULL,
            amt REAL NOT NULL,
            date TEXT NOT NULL
        );""",
        """CREATE TABLE IF NOT EXISTS fee_bills (
            id TEXT PRIMARY KEY,
            inst TEXT NOT NULL,
            uid TEXT NOT NULL,
            date TEXT NOT NULL,
            month TEXT NOT NULL,
            year TEXT NOT NULL,
            debit REAL NOT NULL,
            credit REAL DEFAULT 0,
            due REAL NOT NULL
        );""",
        """CREATE TABLE IF NOT EXISTS timetables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inst TEXT NOT NULL,
            cls TEXT NOT NULL,
            day TEXT NOT NULL,
            time TEXT NOT NULL,
            sub TEXT NOT NULL
        );""",
        """CREATE TABLE IF NOT EXISTS materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inst TEXT NOT NULL,
            cls TEXT NOT NULL,
            title TEXT NOT NULL,
            name TEXT,
            data TEXT
        );""",
        """CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inst TEXT NOT NULL,
            text TEXT NOT NULL,
            date TEXT NOT NULL
        );""",
        """CREATE TABLE IF NOT EXISTS exams (
            id TEXT PRIMARY KEY,
            inst TEXT NOT NULL,
            cls TEXT NOT NULL,
            title TEXT NOT NULL,
            qs TEXT NOT NULL,
            open INTEGER DEFAULT 1
        );""",
        """CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inst TEXT NOT NULL,
            exam TEXT NOT NULL,
            uid TEXT NOT NULL,
            score INTEGER NOT NULL,
            total INTEGER NOT NULL
        );""",
        """CREATE TABLE IF NOT EXISTS teacher_attendance (
            id TEXT PRIMARY KEY,
            inst TEXT NOT NULL,
            teacher TEXT NOT NULL,
            sub TEXT NOT NULL,
            cls TEXT NOT NULL,
            day TEXT NOT NULL,
            time TEXT,
            date TEXT NOT NULL,
            status TEXT NOT NULL,
            monitor TEXT
        );""",
        # Seed default Super Admin (igyr / cutiee) with encrypted password
        ("""INSERT INTO users (id, pw, role, name, inst) VALUES (?, ?, 'admin', 'Super Admin', NULL)
            ON CONFLICT(id) DO UPDATE SET pw=excluded.pw, role='admin', name='Super Admin', inst=NULL;""",
         ["igyr", hash_password("cutiee")]),
        # Remove legacy admin account if present
        ("DELETE FROM users WHERE id = 'admin';", None)
    ]
    execute_batch(statements)

    # Safe migrations for existing deployments
    for mig in [
        "ALTER TABLE users ADD COLUMN email TEXT;",
        "ALTER TABLE attendance ADD COLUMN sub TEXT;",
        "ALTER TABLE subjects ADD COLUMN type TEXT DEFAULT 'compulsory';",
        "ALTER TABLE subjects ADD COLUMN perClassRate REAL DEFAULT 0;",
        "ALTER TABLE students ADD COLUMN optSubs TEXT;",
        "ALTER TABLE students ADD COLUMN isMonitor INTEGER DEFAULT 0;",
        "ALTER TABLE teacher_attendance ADD COLUMN time TEXT;"
    ]:
        try:
            execute(mig)
        except Exception:
            pass

def get_full_db(force_refresh: bool = False) -> Dict[str, Any]:
    """Retrieve full database in a SINGLE fast round-trip pipeline to Turso."""
    sql_list = [
        "SELECT key, value FROM system_config;",
        "SELECT id, pw, role, name, inst, email FROM users;",
        "SELECT id, name, loc, det, email, logo FROM institutes;",
        "SELECT inst, name FROM classes;",
        "SELECT inst, name, cls, teacher, fee, COALESCE(type, 'compulsory') as type, COALESCE(perClassRate, 0) as perClassRate FROM subjects;",
        "SELECT uid, inst, name, cls, feeType, fee, joinDate, email, phone, addr, photo, done, last_pw_reset, COALESCE(optSubs, '') as optSubs, COALESCE(isMonitor, 0) as isMonitor FROM students;",
        "SELECT inst, uid, cls, date, p, COALESCE(sub, '') as sub FROM attendance;",
        "SELECT id, inst, uid, amt, date FROM payments;",
        "SELECT inst, cls, day, time, sub FROM timetables;",
        "SELECT inst, cls, title, name, data FROM materials;",
        "SELECT id, inst, text, date FROM announcements ORDER BY id ASC;",
        "SELECT id, inst, cls, title, qs, open FROM exams;",
        "SELECT inst, exam, uid, score, total FROM results;",
        "SELECT id, inst, uid, date, month, year, debit, credit, due FROM fee_bills;",
        "SELECT id, inst, teacher, sub, cls, day, COALESCE(time, '') as time, date, status, COALESCE(monitor, '') as monitor FROM teacher_attendance;"
    ]
    requests = [{"type": "execute", "stmt": {"sql": s}} for s in sql_list]
    requests.append({"type": "close"})

    resp = execute_pipeline(requests)
    results = resp.get("results", [])

    def _extract_rows(idx: int) -> List[Dict[str, Any]]:
        if idx < len(results) and results[idx].get("type") == "ok":
            exec_res = results[idx].get("response", {}).get("result", {})
            cols = [c["name"] for c in exec_res.get("cols", [])]
            raw_rows = exec_res.get("rows", [])
            return [_parse_row(cols, r) for r in raw_rows]
        return []

    # 1. System Config (Logo)
    config_rows = _extract_rows(0)
    config_dict = {r["key"]: r["value"] for r in config_rows}
    logo = config_dict.get("logo", "")

    # 2. Users
    users_rows = _extract_rows(1)
    users = [
        {"id": u["id"], "pw": u["pw"], "role": u["role"], "name": u["name"] or u["id"], "inst": u["inst"], "email": u.get("email") or ""}
        for u in users_rows
    ]

    # 3. Institutes
    insts_rows = _extract_rows(2)
    insts = [
        {"id": i["id"], "name": i["name"], "loc": i["loc"] or "", "det": i["det"] or "", "email": i.get("email") or "", "logo": i.get("logo") or ""}
        for i in insts_rows
    ]

    # 4. Classes
    classes_rows = _extract_rows(3)
    classes = [{"inst": c["inst"], "name": c["name"]} for c in classes_rows]

    # 5. Subjects
    subs_rows = _extract_rows(4)
    subjects = [
        {
            "inst": s["inst"],
            "name": s["name"],
            "cls": s["cls"] or "",
            "teacher": s["teacher"] or "",
            "fee": s["fee"] or 0,
            "type": s.get("type") or "compulsory",
            "rate": float(s.get("perClassRate") or 0),
            "perClassRate": float(s.get("perClassRate") or 0)
        }
        for s in subs_rows
    ]

    # 6. Students
    stus_rows = _extract_rows(5)
    students = []
    for st in stus_rows:
        opt_subs = []
        raw_opts = st.get("optSubs") or ""
        if raw_opts:
            try:
                if raw_opts.startswith("["):
                    opt_subs = json.loads(raw_opts)
                else:
                    opt_subs = [x.strip() for x in raw_opts.split(",") if x.strip()]
            except Exception:
                opt_subs = []
        students.append({
            "uid": st["uid"],
            "inst": st["inst"],
            "name": st["name"],
            "cls": st["cls"] or "",
            "feeType": st["feeType"] or "one",
            "fee": st["fee"] or 0,
            "join": st["joinDate"] or "",
            "email": st["email"] or "",
            "phone": st["phone"] or "",
            "addr": st["addr"] or "",
            "photo": st["photo"] or "",
            "done": bool(st["done"]),
            "last_pw_reset": st.get("last_pw_reset") or "",
            "optSubs": opt_subs,
            "isMonitor": bool(st.get("isMonitor"))
        })

    # 7. Attendance
    att_rows = _extract_rows(6)
    att = [
        {"inst": a["inst"], "uid": a["uid"], "cls": a["cls"] or "", "date": a["date"], "p": bool(a["p"]), "sub": a.get("sub") or ""}
        for a in att_rows
    ]

    # 8. Payments
    pays_rows = _extract_rows(7)
    pays = [
        {"id": p["id"], "inst": p["inst"], "uid": p["uid"], "amt": p["amt"], "date": p["date"]}
        for p in pays_rows
    ]

    # 9. Timetables
    tt_rows = _extract_rows(8)
    tt = [
        {"inst": t["inst"], "cls": t["cls"], "day": t["day"], "time": t["time"], "sub": t["sub"]}
        for t in tt_rows
    ]

    # 10. Materials
    mats_rows = _extract_rows(9)
    mats = [
        {"inst": m["inst"], "cls": m["cls"], "title": m["title"], "name": m["name"] or "", "data": m["data"] or ""}
        for m in mats_rows
    ]

    # 11. Announcements
    ann_rows = _extract_rows(10)
    ann = [
        {"id": an["id"], "inst": an["inst"], "text": an["text"], "date": an["date"]}
        for an in ann_rows
    ]

    # 12. Exams
    exams_rows = _extract_rows(11)
    exams = []
    for e in exams_rows:
        try:
            qs_parsed = json.loads(e["qs"]) if e["qs"] else []
        except Exception:
            qs_parsed = []
        exams.append({
            "id": e["id"],
            "inst": e["inst"],
            "cls": e["cls"],
            "title": e["title"],
            "qs": qs_parsed,
            "open": bool(e["open"])
        })

    # 13. Results
    res_rows = _extract_rows(12)
    res = [
        {"inst": r["inst"], "exam": r["exam"], "uid": r["uid"], "score": r["score"], "total": r["total"]}
        for r in res_rows
    ]

    # 14. Fee Bills
    bills_rows = _extract_rows(13)
    bills = [
        {
            "id": b["id"],
            "inst": b["inst"],
            "uid": b["uid"],
            "date": b["date"],
            "month": b["month"],
            "year": str(b["year"]),
            "debit": float(b.get("debit") or 0),
            "credit": float(b.get("credit") or 0),
            "due": float(b.get("due") or 0)
        }
        for b in bills_rows
    ]

    # 15. Teacher Attendance
    tatt_rows = _extract_rows(14)
    teacher_att = [
        {
            "id": ta["id"],
            "inst": ta["inst"],
            "teacher": ta["teacher"],
            "sub": ta["sub"],
            "cls": ta["cls"],
            "day": ta["day"],
            "time": ta.get("time") or "",
            "date": ta["date"],
            "status": ta["status"],
            "monitor": ta.get("monitor") or ""
        }
        for ta in tatt_rows
    ]

    return {
        "logo": logo,
        "users": users,
        "insts": insts,
        "classes": classes,
        "subjects": subjects,
        "students": students,
        "att": att,
        "pays": pays,
        "tt": tt,
        "mats": mats,
        "ann": ann,
        "exams": exams,
        "res": res,
        "bills": bills,
        "teacherAtt": teacher_att
    }

def save_full_db(data: Dict[str, Any]) -> None:
    """Synchronize complete front-end state into Turso safely."""
    if not data or not isinstance(data, dict):
        return

    incoming_users = data.get("users", [])
    incoming_insts = data.get("insts", [])

    # SAFETY GUARD: Never wipe the database if the payload is from an uninitialized client!
    if len(incoming_users) <= 1 and len(incoming_insts) == 0:
        print("[Turso DB] Rejected save: client state is uninitialized.")
        return

    batch = []

    # 1. Logo
    logo = data.get("logo", "")
    if logo:
        batch.append((
            "INSERT INTO system_config (key, value) VALUES ('logo', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            [logo]
        ))

    # 2. Users
    for u in incoming_users:
        uid = u.get("id")
        pw = u.get("pw", "")
        if not uid or uid == "admin":
            continue
        if uid == "igyr":
            if not pw or pw == "***":
                continue
            if not pw.startswith("pbkdf2:sha256:"):
                pw = hash_password(pw)
        user_email = u.get("email")
        batch.append((
            """INSERT INTO users (id, pw, role, name, inst, email) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET pw=excluded.pw, role=excluded.role, name=excluded.name, inst=excluded.inst,
               email=CASE WHEN excluded.email IS NOT NULL AND excluded.email != '' THEN excluded.email ELSE users.email END;""",
            [uid, pw, u.get("role"), u.get("name"), u.get("inst"), user_email]
        ))

    # Prune deleted teachers per institute so removals permanently sync across all devices
    inst_ids_in_users = {u.get("inst") for u in incoming_users if u.get("inst") and u.get("role") == "institute"}
    inst_ids_in_insts = {ins.get("id") for ins in incoming_insts if ins.get("id")}
    for inst_id in (inst_ids_in_users | inst_ids_in_insts):
        active_tids = [u.get("id") for u in incoming_users if u.get("role") == "teacher" and u.get("inst") == inst_id and u.get("id")]
        if active_tids:
            placeholders = ",".join("?" for _ in active_tids)
            batch.append((
                f"DELETE FROM users WHERE role = 'teacher' AND inst = ? AND id NOT IN ({placeholders});",
                [inst_id] + active_tids
            ))
        else:
            # If full institute was sent but has 0 teachers, remove any remaining teachers
            if any(u.get("role") == "institute" and (u.get("id") == inst_id or u.get("inst") == inst_id) for u in incoming_users):
                batch.append(("DELETE FROM users WHERE role = 'teacher' AND inst = ?;", [inst_id]))

    # 3. Institutes
    for ins in incoming_insts:
        ins_id = ins.get("id")
        if not ins_id:
            continue
        ins_email = ins.get("email")
        ins_logo = ins.get("logo") or ""
        batch.append((
            """INSERT INTO institutes (id, name, loc, det, email, logo) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, loc=excluded.loc, det=excluded.det,
               email=CASE WHEN excluded.email IS NOT NULL AND excluded.email != '' THEN excluded.email ELSE institutes.email END,
               logo=CASE WHEN excluded.logo IS NOT NULL AND excluded.logo != '' THEN excluded.logo ELSE institutes.logo END;""",
            [ins_id, ins.get("name"), ins.get("loc"), ins.get("det"), ins_email, ins_logo]
        ))

    # Collect all known institute IDs in this payload
    all_inst_ids = set()
    for ins in incoming_insts:
        if ins.get("id"):
            all_inst_ids.add(str(ins.get("id")).strip())
    for u in incoming_users:
        if u.get("inst"):
            all_inst_ids.add(str(u.get("inst")).strip())
    for c in data.get("classes", []):
        if c.get("inst"):
            all_inst_ids.add(str(c.get("inst")).strip())
    for s in data.get("subjects", []):
        if s.get("inst"):
            all_inst_ids.add(str(s.get("inst")).strip())
    for st in data.get("students", []):
        if st.get("inst"):
            all_inst_ids.add(str(st.get("inst")).strip())

    # 4. Classes (Scoped per institute)
    for inst_id in all_inst_ids:
        batch.append(("DELETE FROM classes WHERE inst = ? OR LOWER(inst) = LOWER(?);", [inst_id, inst_id]))
    for c in data.get("classes", []):
        if c.get("inst") and c.get("name"):
            batch.append((
                "INSERT INTO classes (inst, name) VALUES (?, ?);",
                [str(c.get("inst")).strip(), str(c.get("name")).strip()]
            ))

    # 5. Subjects (Scoped per institute)
    for inst_id in all_inst_ids:
        batch.append(("DELETE FROM subjects WHERE inst = ? OR LOWER(inst) = LOWER(?);", [inst_id, inst_id]))
    for s in data.get("subjects", []):
        if s.get("inst") and s.get("name"):
            batch.append((
                "INSERT INTO subjects (inst, name, cls, teacher, fee, type, perClassRate) VALUES (?, ?, ?, ?, ?, ?, ?);",
                [
                    str(s.get("inst")).strip(),
                    str(s.get("name")).strip(),
                    str(s.get("cls") or "").strip(),
                    str(s.get("teacher") or "").strip(),
                    s.get("fee", 0),
                    s.get("type", "compulsory"),
                    float(s.get("perClassRate") or s.get("rate") or 0)
                ]
            ))

    # 6. Students (Upsert active students & prune deleted students per institute)
    for inst_id in all_inst_ids:
        active_uids = [
            str(st.get("uid")).strip()
            for st in data.get("students", [])
            if st.get("inst") and str(st.get("inst")).lower().strip() == inst_id.lower().strip() and st.get("uid")
        ]
        if active_uids:
            placeholders = ",".join("?" for _ in active_uids)
            batch.append((
                f"DELETE FROM students WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND uid NOT IN ({placeholders});",
                [inst_id, inst_id] + active_uids
            ))
            batch.append((
                f"DELETE FROM users WHERE role = 'student' AND (inst = ? OR LOWER(inst) = LOWER(?)) AND id NOT IN ({placeholders});",
                [inst_id, inst_id] + active_uids
            ))
        elif any(u.get("role") == "institute" and (u.get("id") == inst_id or u.get("inst") == inst_id) for u in incoming_users):
            batch.append(("DELETE FROM students WHERE inst = ? OR LOWER(inst) = LOWER(?);", [inst_id, inst_id]))
            batch.append(("DELETE FROM users WHERE role = 'student' AND (inst = ? OR LOWER(inst) = LOWER(?));", [inst_id, inst_id]))

    for st in data.get("students", []):
        if not st.get("uid") or not st.get("inst"):
            continue
        opt_subs_val = json.dumps(st.get("optSubs", [])) if isinstance(st.get("optSubs"), (list, dict)) else (st.get("optSubs") or "")
        batch.append((
            """INSERT INTO students (uid, inst, name, cls, feeType, fee, joinDate, email, phone, addr, photo, done, optSubs, isMonitor)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(uid) DO UPDATE SET
               inst=excluded.inst, name=excluded.name, cls=excluded.cls, feeType=excluded.feeType,
               fee=excluded.fee, joinDate=excluded.joinDate, email=excluded.email, phone=excluded.phone,
               addr=excluded.addr, photo=excluded.photo, done=excluded.done, optSubs=excluded.optSubs,
               isMonitor=excluded.isMonitor;""",
            [
                st.get("uid"), st.get("inst"), st.get("name"), st.get("cls"),
                st.get("feeType", "one"), st.get("fee", 0), st.get("join"),
                st.get("email"), st.get("phone"), st.get("addr"), st.get("photo"),
                1 if st.get("done") else 0,
                opt_subs_val,
                1 if st.get("isMonitor") else 0
            ]
        ))

    # 7. Attendance
    for inst_id in all_inst_ids:
        batch.append(("DELETE FROM attendance WHERE inst = ? OR LOWER(inst) = LOWER(?);", [inst_id, inst_id]))
    for a in data.get("att", []):
        if a.get("inst") and a.get("uid"):
            batch.append((
                "INSERT INTO attendance (inst, uid, cls, date, p, sub) VALUES (?, ?, ?, ?, ?, ?);",
                [str(a.get("inst")).strip(), a.get("uid"), a.get("cls"), a.get("date"), 1 if a.get("p") else 0, a.get("sub", "")]
            ))

    # 8. Payments
    for p in data.get("pays", []):
        if not p.get("id"):
            continue
        batch.append((
            """INSERT INTO payments (id, inst, uid, amt, date) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET inst=excluded.inst, uid=excluded.uid, amt=excluded.amt, date=excluded.date;""",
            [p.get("id"), p.get("inst"), p.get("uid"), p.get("amt"), p.get("date")]
        ))

    # 9. Timetables
    for inst_id in all_inst_ids:
        batch.append(("DELETE FROM timetables WHERE inst = ? OR LOWER(inst) = LOWER(?);", [inst_id, inst_id]))
    for t in data.get("tt", []):
        if t.get("inst") and t.get("cls") and t.get("sub"):
            batch.append((
                "INSERT INTO timetables (inst, cls, day, time, sub) VALUES (?, ?, ?, ?, ?);",
                [str(t.get("inst")).strip(), str(t.get("cls")).strip(), t.get("day"), t.get("time"), str(t.get("sub")).strip()]
            ))

    # 10. Materials
    for inst_id in all_inst_ids:
        batch.append(("DELETE FROM materials WHERE inst = ? OR LOWER(inst) = LOWER(?);", [inst_id, inst_id]))
    for m in data.get("mats", []):
        if m.get("inst"):
            batch.append((
                "INSERT INTO materials (inst, cls, title, name, data) VALUES (?, ?, ?, ?, ?);",
                [str(m.get("inst")).strip(), m.get("cls"), m.get("title"), m.get("name"), m.get("data")]
            ))

    # 11. Announcements
    ann_list = data.get("ann", [])
    if ann_list:
        for an in ann_list:
            an_id = an.get("id")
            if an_id is not None and str(an_id).isdigit():
                batch.append((
                    "INSERT INTO announcements (id, inst, text, date) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, date=excluded.date;",
                    [int(an_id), an.get("inst"), an.get("text"), an.get("date")]
                ))
            else:
                batch.append((
                    "INSERT INTO announcements (inst, text, date) VALUES (?, ?, ?);",
                    [an.get("inst"), an.get("text"), an.get("date")]
                ))

    # 12. Exams
    for e in data.get("exams", []):
        if not e.get("id"):
            continue
        qs_str = json.dumps(e.get("qs", []))
        batch.append((
            """INSERT INTO exams (id, inst, cls, title, qs, open) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET inst=excluded.inst, cls=excluded.cls, title=excluded.title, qs=excluded.qs, open=excluded.open;""",
            [e.get("id"), e.get("inst"), e.get("cls"), e.get("title"), qs_str, 1 if e.get("open") else 0]
        ))

    # 13. Results
    for r in data.get("res", []):
        if not r.get("inst") or not r.get("exam") or not r.get("uid"):
            continue
        batch.append((
            "INSERT INTO results (inst, exam, uid, score, total) VALUES (?, ?, ?, ?, ?);",
            [r.get("inst"), r.get("exam"), r.get("uid"), r.get("score"), r.get("total")]
        ))

    # 14. Fee Bills (Month-by-Month billing schedule)
    bills_list = data.get("bills", [])
    if bills_list:
        for b in bills_list:
            if not b.get("id") or not b.get("inst") or not b.get("uid"):
                continue
            batch.append((
                """INSERT INTO fee_bills (id, inst, uid, date, month, year, debit, credit, due)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                   inst=excluded.inst, uid=excluded.uid, date=excluded.date, month=excluded.month,
                   year=excluded.year, debit=excluded.debit, credit=excluded.credit, due=excluded.due;""",
                [
                    b.get("id"), b.get("inst"), b.get("uid"), b.get("date"),
                    b.get("month"), str(b.get("year")), float(b.get("debit") or 0),
                    float(b.get("credit") or 0), float(b.get("due") or 0)
                ]
            ))

    # 15. Teacher Attendance
    teacher_att_list = data.get("teacherAtt", [])
    if teacher_att_list:
        for ta in teacher_att_list:
            if not ta.get("id") or not ta.get("inst"):
                continue
            batch.append((
                """INSERT INTO teacher_attendance (id, inst, teacher, sub, cls, day, time, date, status, monitor)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                   inst=excluded.inst, teacher=excluded.teacher, sub=excluded.sub, cls=excluded.cls,
                   day=excluded.day, time=excluded.time, date=excluded.date, status=excluded.status, monitor=excluded.monitor;""",
                [
                    ta.get("id"), ta.get("inst"), ta.get("teacher"), ta.get("sub"),
                    ta.get("cls"), ta.get("day"), ta.get("time", ""), ta.get("date"),
                    ta.get("status", "P"), ta.get("monitor", "")
                ]
            ))

    if batch:
        execute_batch(batch)
    invalidate_db_cache()
    try:
        get_full_db(force_refresh=True)
    except Exception:
        pass

def delete_institute_completely(inst_id: str) -> None:
    """Permanently delete an institute and completely wipe all of its records from all tables."""
    clean_id = str(inst_id).strip()
    clean_lower = clean_id.lower()
    stmts = [
        ("DELETE FROM institutes WHERE id = ? OR LOWER(id) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM users WHERE inst = ? OR LOWER(inst) = ? OR id = ? OR LOWER(id) = ?;", [clean_id, clean_lower, clean_id, clean_lower]),
        ("DELETE FROM students WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM classes WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM subjects WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM attendance WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM payments WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM timetables WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM materials WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM announcements WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM exams WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM results WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM fee_bills WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
        ("DELETE FROM teacher_attendance WHERE inst = ? OR LOWER(inst) = ?;", [clean_id, clean_lower]),
    ]
    execute_batch(stmts)
    invalidate_db_cache()

def delete_subject(inst: str, name: str, cls: str = None) -> None:
    """Permanently delete a subject and associated timetables."""
    clean_inst = str(inst or '').strip()
    clean_name = str(name or '').strip()
    clean_cls = str(cls or '').strip()
    if not clean_inst or not clean_name:
        return
    stmts = []
    if clean_cls:
        stmts.append((
            "DELETE FROM subjects WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(name)) = LOWER(TRIM(?)) AND LOWER(TRIM(cls)) = LOWER(TRIM(?));",
            [clean_inst, clean_inst, clean_name, clean_cls]
        ))
        stmts.append((
            "DELETE FROM timetables WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(sub)) = LOWER(TRIM(?)) AND LOWER(TRIM(cls)) = LOWER(TRIM(?));",
            [clean_inst, clean_inst, clean_name, clean_cls]
        ))
    else:
        stmts.append((
            "DELETE FROM subjects WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(name)) = LOWER(TRIM(?));",
            [clean_inst, clean_inst, clean_name]
        ))
        stmts.append((
            "DELETE FROM timetables WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(sub)) = LOWER(TRIM(?));",
            [clean_inst, clean_inst, clean_name]
        ))
    execute_batch(stmts)
    invalidate_db_cache()

def delete_class(inst: str, name: str) -> None:
    """Permanently delete a class, its subjects, timetable, and materials, and unassign enrolled students."""
    clean_inst = str(inst or '').strip()
    clean_name = str(name or '').strip()
    if not clean_inst or not clean_name:
        return
    stmts = [
        ("DELETE FROM classes WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(name)) = LOWER(TRIM(?));", [clean_inst, clean_inst, clean_name]),
        ("DELETE FROM subjects WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(cls)) = LOWER(TRIM(?));", [clean_inst, clean_inst, clean_name]),
        ("DELETE FROM timetables WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(cls)) = LOWER(TRIM(?));", [clean_inst, clean_inst, clean_name]),
        ("DELETE FROM materials WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(cls)) = LOWER(TRIM(?));", [clean_inst, clean_inst, clean_name]),
        ("UPDATE students SET cls = '' WHERE (inst = ? OR LOWER(inst) = LOWER(?)) AND LOWER(TRIM(cls)) = LOWER(TRIM(?));", [clean_inst, clean_inst, clean_name]),
    ]
    execute_batch(stmts)
    invalidate_db_cache()

def authenticate_user(raw_id: str, pw: str) -> Optional[Dict[str, Any]]:
    """Authenticate user with ID and encrypted password verification.
    STRICT RULE: For admin role, ONLY user ID 'igyr' and password 'cutiee' is allowed."""
    clean_id = raw_id.strip().lower().replace(" ", "")
    if clean_id == "admin":
        return None

    rows = query(
        "SELECT id, pw, role, name, inst FROM users WHERE (id = ? OR LOWER(REPLACE(id, ' ', '')) = ? OR LOWER(TRIM(name)) = ? OR LOWER(REPLACE(name, ' ', '')) = ?);",
        [raw_id.strip(), clean_id, raw_id.strip().lower(), clean_id]
    )
    for u in rows:
        # Guarantee no other user can authenticate as admin except igyr
        if u.get("role") == "admin" and u.get("id").lower() != "igyr":
            continue

        stored_pw = u.get("pw", "")
        if verify_password(stored_pw, pw):
            inst_val = u.get("inst")
            role = u.get("role")
            if not inst_val:
                if role == "institute":
                    inst_val = u["id"]
                elif role == "student":
                    st_rows = query("SELECT inst FROM students WHERE uid = ? OR LOWER(uid) = ?;", [u["id"], u["id"].lower()])
                    if st_rows and st_rows[0].get("inst"):
                        inst_val = st_rows[0]["inst"]
                elif role == "teacher":
                    sub_rows = query("SELECT inst FROM subjects WHERE teacher = ? OR LOWER(teacher) = ?;", [u["id"], u["id"].lower()])
                    if sub_rows and sub_rows[0].get("inst"):
                        inst_val = sub_rows[0]["inst"]

            return {
                "id": u["id"],
                "role": role,
                "name": u["name"] or u["id"],
                "inst": inst_val
            }
    return None

def find_user_by_email(email_or_id: str) -> Optional[Dict[str, Any]]:
    """Look up user across students, users, and institutes by email or user ID."""
    term = (email_or_id or "").strip().lower()
    if not term:
        return None

    # 1. Search in students
    stus = query(
        "SELECT uid, inst, name, cls, email, last_pw_reset FROM students WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(uid)) = ?;",
        [term, term]
    )
    if stus:
        st = stus[0]
        u_rows = query("SELECT id, pw, role FROM users WHERE id = ? OR LOWER(id) = ?;", [st["uid"], st["uid"].lower()])
        user_pw = u_rows[0]["pw"] if u_rows else ""
        return {
            "type": "student",
            "role": "student",
            "uid": st["uid"],
            "name": st["name"],
            "email": st["email"] or term,
            "inst": st["inst"],
            "cls": st.get("cls", "General"),
            "last_pw_reset": st.get("last_pw_reset"),
            "current_pw": user_pw
        }

    # 2. Search in users (teachers or institute accounts)
    u_rows = query(
        "SELECT id, pw, role, name, inst, email FROM users WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(id)) = ?;",
        [term, term]
    )
    for u in u_rows:
        if u["role"] == "admin":
            continue
        return {
            "type": u["role"],
            "role": u["role"],
            "uid": u["id"],
            "name": u["name"] or u["id"],
            "email": u.get("email") or term,
            "inst": u["inst"],
            "last_pw_reset": None,
            "current_pw": u["pw"]
        }

    # 3. Search in institutes
    ins_rows = query(
        "SELECT id, name, email FROM institutes WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(id)) = ?;",
        [term, term]
    )
    if ins_rows:
        ins = ins_rows[0]
        u_rows = query("SELECT id, pw, role FROM users WHERE id = ? OR LOWER(id) = ?;", [ins["id"], ins["id"].lower()])
        user_pw = u_rows[0]["pw"] if u_rows else ""
        return {
            "type": "institute",
            "role": "institute",
            "uid": ins["id"],
            "name": ins["name"],
            "email": ins.get("email") or term,
            "inst": ins["id"],
            "last_pw_reset": None,
            "current_pw": user_pw
        }

    return None

def check_student_monthly_reset_limit(last_pw_reset: Optional[str]) -> Tuple[bool, str]:
    """Verify if a student is within the 30-day limit for password reset."""
    if not last_pw_reset:
        return True, ""
    try:
        from datetime import datetime
        last_dt = datetime.fromisoformat(last_pw_reset)
        now = datetime.now()
        days_passed = (now - last_dt).days
        if days_passed < 30:
            remaining_days = max(1, 30 - days_passed)
            return False, f"Monthly limit reached: Students can only reset their password once in a month. Please try again after {remaining_days} day(s), or contact your institute administrator."
    except Exception:
        pass
    return True, ""

def update_user_password_and_record_reset(user_id: str, new_pw: str, is_student: bool = False) -> None:
    """Update password in users table and update student reset timestamp."""
    execute("UPDATE users SET pw = ? WHERE id = ? OR LOWER(id) = ?;", [new_pw, user_id, user_id.lower()])
    if is_student:
        from datetime import datetime
        now_str = datetime.now().isoformat()
        execute("UPDATE students SET last_pw_reset = ? WHERE uid = ? OR LOWER(uid) = ?;", [now_str, user_id, user_id.lower()])

def add_announcement(inst: str, text: str, date_str: str) -> Optional[int]:
    """Insert a new announcement into Turso cloud DB and return its generated ID."""
    execute("INSERT INTO announcements (inst, text, date) VALUES (?, ?, ?);", [inst.strip(), text.strip(), date_str.strip()])
    rows = query("SELECT id FROM announcements WHERE inst = ? AND text = ? ORDER BY id DESC LIMIT 1;", [inst.strip(), text.strip()])
    if rows:
        return rows[0].get("id")
    return None

def delete_announcement(ann_id: Optional[Any] = None, inst: Optional[str] = None, text: Optional[str] = None) -> bool:
    """Delete an announcement from Turso cloud DB by ID or by (inst, text)."""
    if ann_id is not None and str(ann_id).strip():
        val = str(ann_id).strip()
        if val.isdigit():
            execute("DELETE FROM announcements WHERE id = ?;", [int(val)])
            return True
    if inst and text:
        execute("DELETE FROM announcements WHERE inst = ? AND text = ?;", [inst.strip(), text.strip()])
        return True
    return False

