import json
import urllib.request
import ssl
import hashlib
import secrets
import time
from typing import List, Dict, Any, Optional, Tuple
from config import TURSO_HTTP_URL, TURSO_AUTH_TOKEN

_DB_CACHE: Optional[Dict[str, Any]] = None
_DB_CACHE_TIME: float = 0.0
_DB_VERSION: int = int(time.time() * 1000)

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
    """Execute raw pipeline requests on Turso via HTTP v2 API."""
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
    with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))

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
            inst TEXT
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
            fee REAL DEFAULT 0
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
            done INTEGER DEFAULT 0
        );""",
        """CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inst TEXT NOT NULL,
            uid TEXT NOT NULL,
            cls TEXT,
            date TEXT NOT NULL,
            p INTEGER DEFAULT 1
        );""",
        """CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY,
            inst TEXT NOT NULL,
            uid TEXT NOT NULL,
            amt REAL NOT NULL,
            date TEXT NOT NULL
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
        # Seed default Super Admin (igyr / cutiee) with encrypted password
        ("""INSERT INTO users (id, pw, role, name, inst) VALUES (?, ?, 'admin', 'Super Admin', NULL)
            ON CONFLICT(id) DO UPDATE SET pw=excluded.pw, role='admin', name='Super Admin', inst=NULL;""",
         ["igyr", hash_password("cutiee")]),
        # Remove legacy admin account if present
        ("DELETE FROM users WHERE id = 'admin';", None)
    ]
    execute_batch(statements)

def get_full_db(force_refresh: bool = False) -> Dict[str, Any]:
    """Retrieve full database in the exact structure expected by the frontend."""
    # 1. System Config (Logo)
    config_rows = query("SELECT key, value FROM system_config;")
    config_dict = {r["key"]: r["value"] for r in config_rows}
    logo = config_dict.get("logo", "")

    # 2. Users
    users_rows = query("SELECT id, pw, role, name, inst, email FROM users;")
    users = [
        {"id": u["id"], "pw": u["pw"], "role": u["role"], "name": u["name"] or u["id"], "inst": u["inst"], "email": u.get("email") or ""}
        for u in users_rows
    ]

    # 3. Institutes
    insts_rows = query("SELECT id, name, loc, det, email, logo FROM institutes;")
    insts = [
        {"id": i["id"], "name": i["name"], "loc": i["loc"] or "", "det": i["det"] or "", "email": i.get("email") or "", "logo": i.get("logo") or ""}
        for i in insts_rows
    ]

    # 4. Classes
    classes_rows = query("SELECT inst, name FROM classes;")
    classes = [{"inst": c["inst"], "name": c["name"]} for c in classes_rows]

    # 5. Subjects
    subs_rows = query("SELECT inst, name, cls, teacher, fee FROM subjects;")
    subjects = [
        {"inst": s["inst"], "name": s["name"], "cls": s["cls"] or "", "teacher": s["teacher"] or "", "fee": s["fee"] or 0}
        for s in subs_rows
    ]

    # 6. Students
    stus_rows = query("SELECT uid, inst, name, cls, feeType, fee, joinDate, email, phone, addr, photo, done, last_pw_reset FROM students;")
    students = [
        {
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
            "last_pw_reset": st.get("last_pw_reset") or ""
        }
        for st in stus_rows
    ]

    # 7. Attendance
    att_rows = query("SELECT inst, uid, cls, date, p FROM attendance;")
    att = [
        {"inst": a["inst"], "uid": a["uid"], "cls": a["cls"] or "", "date": a["date"], "p": bool(a["p"])}
        for a in att_rows
    ]

    # 8. Payments
    pays_rows = query("SELECT id, inst, uid, amt, date FROM payments;")
    pays = [
        {"id": p["id"], "inst": p["inst"], "uid": p["uid"], "amt": p["amt"], "date": p["date"]}
        for p in pays_rows
    ]

    # 9. Timetables
    tt_rows = query("SELECT inst, cls, day, time, sub FROM timetables;")
    tt = [
        {"inst": t["inst"], "cls": t["cls"], "day": t["day"], "time": t["time"], "sub": t["sub"]}
        for t in tt_rows
    ]

    # 10. Materials
    mats_rows = query("SELECT inst, cls, title, name, data FROM materials;")
    mats = [
        {"inst": m["inst"], "cls": m["cls"], "title": m["title"], "name": m["name"] or "", "data": m["data"] or ""}
        for m in mats_rows
    ]

    # 11. Announcements
    ann_rows = query("SELECT id, inst, text, date FROM announcements ORDER BY id ASC;")
    ann = [
        {"id": an["id"], "inst": an["inst"], "text": an["text"], "date": an["date"]}
        for an in ann_rows
    ]

    # 12. Exams
    exams_rows = query("SELECT id, inst, cls, title, qs, open FROM exams;")
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
    res_rows = query("SELECT inst, exam, uid, score, total FROM results;")
    res = [
        {"inst": r["inst"], "exam": r["exam"], "uid": r["uid"], "score": r["score"], "total": r["total"]}
        for r in res_rows
    ]

    full_db = {
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
        "res": res
    }
    _DB_CACHE = full_db
    _DB_CACHE_TIME = time.time()
    return full_db

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

    # 4. Classes (Scoped per institute, do not delete other institutes' classes)
    classes_list = data.get("classes", [])
    if classes_list:
        insts_in_payload = {c.get("inst") for c in classes_list if c.get("inst")}
        for inst_id in insts_in_payload:
            batch.append(("DELETE FROM classes WHERE inst = ?;", [inst_id]))
        for c in classes_list:
            if c.get("inst") and c.get("name"):
                batch.append((
                    "INSERT INTO classes (inst, name) VALUES (?, ?);",
                    [c.get("inst"), c.get("name")]
                ))

    # 5. Subjects (Scoped per institute)
    subjects_list = data.get("subjects", [])
    if subjects_list:
        insts_in_payload = {s.get("inst") for s in subjects_list if s.get("inst")}
        for inst_id in insts_in_payload:
            batch.append(("DELETE FROM subjects WHERE inst = ?;", [inst_id]))
        for s in subjects_list:
            if s.get("inst") and s.get("name"):
                batch.append((
                    "INSERT INTO subjects (inst, name, cls, teacher, fee) VALUES (?, ?, ?, ?, ?);",
                    [s.get("inst"), s.get("name"), s.get("cls"), s.get("teacher"), s.get("fee", 0)]
                ))

    # 6. Students
    for st in data.get("students", []):
        if not st.get("uid") or not st.get("inst"):
            continue
        batch.append((
            """INSERT INTO students (uid, inst, name, cls, feeType, fee, joinDate, email, phone, addr, photo, done)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(uid) DO UPDATE SET
               inst=excluded.inst, name=excluded.name, cls=excluded.cls, feeType=excluded.feeType,
               fee=excluded.fee, joinDate=excluded.joinDate, email=excluded.email, phone=excluded.phone,
               addr=excluded.addr, photo=excluded.photo, done=excluded.done;""",
            [
                st.get("uid"), st.get("inst"), st.get("name"), st.get("cls"),
                st.get("feeType", "one"), st.get("fee", 0), st.get("join"),
                st.get("email"), st.get("phone"), st.get("addr"), st.get("photo"),
                1 if st.get("done") else 0
            ]
        ))
        # Ensure student class also exists in classes table
        if st.get("cls") and st.get("inst"):
            batch.append((
                "INSERT INTO classes (inst, name) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM classes WHERE inst = ? AND name = ?);",
                [st.get("inst"), st.get("cls"), st.get("inst"), st.get("cls")]
            ))

    # 7. Attendance
    att_list = data.get("att", [])
    if att_list:
        insts_in_payload = {a.get("inst") for a in att_list if a.get("inst")}
        for inst_id in insts_in_payload:
            batch.append(("DELETE FROM attendance WHERE inst = ?;", [inst_id]))
        for a in att_list:
            batch.append((
                "INSERT INTO attendance (inst, uid, cls, date, p) VALUES (?, ?, ?, ?, ?);",
                [a.get("inst"), a.get("uid"), a.get("cls"), a.get("date"), 1 if a.get("p") else 0]
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
    tt_list = data.get("tt", [])
    if tt_list:
        insts_in_payload = {t.get("inst") for t in tt_list if t.get("inst")}
        for inst_id in insts_in_payload:
            batch.append(("DELETE FROM timetables WHERE inst = ?;", [inst_id]))
        for t in tt_list:
            batch.append((
                "INSERT INTO timetables (inst, cls, day, time, sub) VALUES (?, ?, ?, ?, ?);",
                [t.get("inst"), t.get("cls"), t.get("day"), t.get("time"), t.get("sub")]
            ))

    # 10. Materials
    mats_list = data.get("mats", [])
    if mats_list:
        insts_in_payload = {m.get("inst") for m in mats_list if m.get("inst")}
        for inst_id in insts_in_payload:
            batch.append(("DELETE FROM materials WHERE inst = ?;", [inst_id]))
        for m in mats_list:
            batch.append((
                "INSERT INTO materials (inst, cls, title, name, data) VALUES (?, ?, ?, ?, ?);",
                [m.get("inst"), m.get("cls"), m.get("title"), m.get("name"), m.get("data")]
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

    if batch:
        execute_batch(batch)
    invalidate_db_cache()
    try:
        get_full_db(force_refresh=True)
    except Exception:
        pass

def authenticate_user(raw_id: str, pw: str) -> Optional[Dict[str, Any]]:
    """Authenticate user with ID and encrypted password verification.
    STRICT RULE: For admin role, ONLY user ID 'igyr' and password 'cutiee' is allowed."""
    clean_id = raw_id.strip().lower().replace(" ", "")
    if clean_id == "admin":
        return None

    rows = query(
        "SELECT id, pw, role, name, inst FROM users WHERE (id = ? OR LOWER(REPLACE(id, ' ', '')) = ?);",
        [raw_id.strip(), clean_id]
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

