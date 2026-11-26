#!/usr/bin/env python3
"""
IGYR Smart Platform - Python Backend Server with Turso Cloud Database
"""

import json
import os
import sys
import time
import secrets
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from pathlib import Path

from config import HOST, PORT, TURSO_DATABASE_URL
import turso_db
import email_service

BASE_DIR = Path(__file__).resolve().parent

# In-memory OTP storage for password reset: { email_lower: { otp, user_id, role, name, expires_at, verified } }
OTP_STORE = {}

def mask_email(email: str) -> str:
    """Mask email for privacy e.g. a***b@gmail.com"""
    if not email or "@" not in email:
        return email
    parts = email.split("@", 1)
    name, domain = parts[0], parts[1]
    if len(name) <= 2:
        masked_name = name[0] + "*"
    else:
        masked_name = name[0] + "*" * (len(name) - 2) + name[-1]
    return f"{masked_name}@{domain}"

class IgyrRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def _send_json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                raw_data = self.rfile.read(content_length).decode("utf-8")
                return json.loads(raw_data)
        except Exception:
            pass
        return {}

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        query_params = parse_qs(parsed.query)

        # Health & Turso Status
        if path == "/api/health":
            try:
                # ping Turso
                res = turso_db.query("SELECT 1 as ping;")
                self._send_json({
                    "status": "online",
                    "database": "Turso (libsql)",
                    "url": TURSO_DATABASE_URL,
                    "ping": res[0].get("ping") if res else 1
                })
            except Exception as e:
                self._send_json({"status": "error", "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Full Database State Sync
        if path == "/api/db":
            try:
                db_data = turso_db.get_full_db()
                self._send_json({"ok": True, "data": db_data})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Default static file routing
        if self.path == "/" or self.path == "":
            self.path = "/index.html"

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        body = self._read_json_body()

        # Auth: Login
        if path == "/api/auth/login":
            uid = body.get("uid", "").strip()
            pw = body.get("pw", "").strip()
            if not uid or not pw:
                self._send_json({"ok": False, "error": "Username and password required."}, status=HTTPStatus.BAD_REQUEST)
                return
            try:
                user = turso_db.authenticate_user(uid, pw)
                if user:
                    self._send_json({"ok": True, "user": user})
                else:
                    self._send_json({"ok": False, "error": "Invalid ID or password."}, status=HTTPStatus.UNAUTHORIZED)
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Forgot Password: 1. Send OTP
        if path == "/api/auth/forgot-password/send-otp":
            email_or_id = body.get("email", "").strip()
            if not email_or_id:
                self._send_json({"ok": False, "error": "Registered Email Address or User ID is required."}, status=HTTPStatus.BAD_REQUEST)
                return
            try:
                user = turso_db.find_user_by_email(email_or_id)
                if not user:
                    self._send_json({"ok": False, "error": f"No registered account found with email/ID '{email_or_id}'. Please check spelling or contact your administrator."}, status=HTTPStatus.NOT_FOUND)
                    return

                target_email = user.get("email")
                if not target_email or "@" not in target_email:
                    self._send_json({"ok": False, "error": f"Account '{user['name']}' has no valid registered email address. Please contact your administrator."}, status=HTTPStatus.BAD_REQUEST)
                    return

                # Student monthly limit check
                if user.get("role") == "student":
                    allowed, reason = turso_db.check_student_monthly_reset_limit(user.get("last_pw_reset"))
                    if not allowed:
                        self._send_json({"ok": False, "error": reason}, status=HTTPStatus.FORBIDDEN)
                        return

                # Generate 6-digit OTP
                otp = f"{secrets.randbelow(900000) + 100000}"
                key = target_email.lower().strip()
                OTP_STORE[key] = {
                    "otp": otp,
                    "user_id": user["uid"],
                    "role": user["role"],
                    "name": user["name"],
                    "email": target_email,
                    "expires_at": time.time() + 600,  # 10 minutes
                    "verified": False
                }
                print(f"[AUTH] Generated 6-digit OTP for {target_email}: {otp}")

                # Send email via Gmail SMTP
                try:
                    email_service.send_otp_email(
                        to_email=target_email,
                        user_name=user["name"],
                        role=user["role"],
                        user_id=user["uid"],
                        otp=otp
                    )
                except Exception as mail_err:
                    print(f"[SMTP Error] Failed to send OTP to {target_email}: {mail_err}")
                    self._send_json({"ok": False, "error": f"Failed to send email: {mail_err}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
                    return

                self._send_json({
                    "ok": True,
                    "message": f"Verification code sent to {mask_email(target_email)}",
                    "email": target_email,
                    "masked_email": mask_email(target_email),
                    "role": user["role"],
                    "name": user["name"],
                    "uid": user["uid"]
                })
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Forgot Password: 2. Verify OTP
        if path == "/api/auth/forgot-password/verify-otp":
            email = body.get("email", "").strip().lower()
            otp = body.get("otp", "").strip()
            if not email or not otp:
                self._send_json({"ok": False, "error": "Email and 6-digit OTP code are required."}, status=HTTPStatus.BAD_REQUEST)
                return

            entry = OTP_STORE.get(email)
            if not entry:
                self._send_json({"ok": False, "error": "No OTP request found for this email, or code expired. Please request a new code."}, status=HTTPStatus.BAD_REQUEST)
                return

            if time.time() > entry["expires_at"]:
                del OTP_STORE[email]
                self._send_json({"ok": False, "error": "Verification code has expired. Please request a new code."}, status=HTTPStatus.BAD_REQUEST)
                return

            if entry["otp"] != otp:
                self._send_json({"ok": False, "error": "Incorrect OTP code. Please check the 6-digit code sent to your email."}, status=HTTPStatus.BAD_REQUEST)
                return

            entry["verified"] = True
            self._send_json({
                "ok": True,
                "message": "OTP verified successfully. Please enter your new password.",
                "uid": entry["user_id"],
                "name": entry["name"],
                "role": entry["role"]
            })
            return

        # Forgot Password: 3. Reset Password
        if path == "/api/auth/forgot-password/reset":
            email = body.get("email", "").strip().lower()
            otp = body.get("otp", "").strip()
            new_pw = body.get("new_pw", "").strip()
            if not email or not otp or not new_pw:
                self._send_json({"ok": False, "error": "Email, OTP, and new password are required."}, status=HTTPStatus.BAD_REQUEST)
                return

            if len(new_pw) < 4:
                self._send_json({"ok": False, "error": "Password must be at least 4 characters long."}, status=HTTPStatus.BAD_REQUEST)
                return

            entry = OTP_STORE.get(email)
            if not entry or not entry.get("verified") or entry.get("otp") != otp:
                self._send_json({"ok": False, "error": "Unauthorized reset. Please verify OTP first."}, status=HTTPStatus.UNAUTHORIZED)
                return

            if time.time() > entry["expires_at"]:
                del OTP_STORE[email]
                self._send_json({"ok": False, "error": "Session expired. Please request a new code."}, status=HTTPStatus.BAD_REQUEST)
                return

            try:
                user_id = entry["user_id"]
                is_student = (entry["role"] == "student")

                if is_student:
                    stu_rows = turso_db.query("SELECT last_pw_reset FROM students WHERE uid = ?;", [user_id])
                    if stu_rows:
                        allowed, reason = turso_db.check_student_monthly_reset_limit(stu_rows[0].get("last_pw_reset"))
                        if not allowed:
                            self._send_json({"ok": False, "error": reason}, status=HTTPStatus.FORBIDDEN)
                            return

                turso_db.update_user_password_and_record_reset(user_id, new_pw, is_student=is_student)

                try:
                    email_service.send_password_success_email(entry["email"], entry["name"], user_id)
                except Exception as e:
                    print(f"[SMTP Warning] Confirmation email error: {e}")

                del OTP_STORE[email]
                self._send_json({
                    "ok": True,
                    "message": "Password changed successfully! You can now log in with your new password.",
                    "uid": user_id
                })
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Save Full Database
        if path == "/api/db/save":
            try:
                turso_db.save_full_db(body)
                self._send_json({"ok": True, "message": "Saved to Turso cloud successfully."})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Update Institute Logo directly
        if path == "/api/institutes/logo":
            inst_id = body.get("id", "").strip()
            logo_data = body.get("logo", "")
            if not inst_id:
                self._send_json({"ok": False, "error": "Institute ID is required."}, status=HTTPStatus.BAD_REQUEST)
                return
            try:
                turso_db.execute(
                    "UPDATE institutes SET logo = ? WHERE id = ? OR LOWER(id) = ?;",
                    [logo_data, inst_id, inst_id.lower()]
                )
                self._send_json({"ok": True, "message": "Institute logo updated successfully in Turso."})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Create Institute
        if path == "/api/institutes":
            try:
                name = body.get("name", "").strip()
                inst_id = body.get("id", "").strip()
                pw = body.get("pw", "").strip()
                loc = body.get("loc", "").strip()
                det = body.get("det", "").strip()
                if not name or not inst_id or not pw:
                    self._send_json({"ok": False, "error": "Missing institute name, id or password"}, status=HTTPStatus.BAD_REQUEST)
                    return
                turso_db.execute(
                    "INSERT INTO institutes (id, name, loc, det) VALUES (?, ?, ?, ?);",
                    [inst_id, name, loc, det]
                )
                turso_db.execute(
                    "INSERT INTO users (id, pw, role, name, inst) VALUES (?, ?, 'institute', ?, ?);",
                    [inst_id, pw, name, inst_id]
                )
                self._send_json({"ok": True, "id": inst_id, "name": name})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Create Announcement
        if path == "/api/announcements":
            inst = body.get("inst", "").strip()
            text = body.get("text", "").strip()
            date_str = body.get("date", "").strip()
            if not inst or not text:
                self._send_json({"ok": False, "error": "inst and text are required"}, status=HTTPStatus.BAD_REQUEST)
                return
            try:
                ann_id = turso_db.add_announcement(inst, text, date_str or datetime.now().strftime("%Y-%m-%d"))
                self._send_json({"ok": True, "id": ann_id, "message": "Announcement created successfully."})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Delete Announcement
        if path == "/api/announcements/delete":
            ann_id = body.get("id")
            inst = body.get("inst")
            text = body.get("text")
            try:
                turso_db.delete_announcement(ann_id=ann_id, inst=inst, text=text)
                self._send_json({"ok": True, "message": "Announcement deleted successfully from database."})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Fallback 404 for unknown POST endpoints
        self._send_json({"ok": False, "error": f"Endpoint {path} not found."}, status=HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        body = self._read_json_body()

        # Update Student Details
        if path == "/api/students":
            try:
                uid = body.get("uid")
                if not uid:
                    self._send_json({"ok": False, "error": "uid required"}, status=HTTPStatus.BAD_REQUEST)
                    return
                # Update editable fields
                fields = []
                params = []
                for k in ["name", "cls", "feeType", "fee", "email", "phone", "addr", "photo", "done"]:
                    if k in body:
                        fields.append(f"{k} = ?")
                        val = 1 if (k == "done" and body[k]) else (0 if (k == "done" and not body[k]) else body[k])
                        params.append(val)
                if fields:
                    params.append(uid)
                    turso_db.execute(f"UPDATE students SET {', '.join(fields)} WHERE uid = ?;", params)
                self._send_json({"ok": True, "message": "Student updated"})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        # Reset / Update User Password (for Super Admin resetting Institute, or Institute resetting Student)
        if path == "/api/users/password":
            try:
                user_id = body.get("id")
                new_pw = body.get("pw", "").strip()
                if not user_id or not new_pw:
                    self._send_json({"ok": False, "error": "User ID and new password are required."}, status=HTTPStatus.BAD_REQUEST)
                    return
                if user_id.lower() == "igyr":
                    hashed_pw = turso_db.hash_password(new_pw)
                    turso_db.execute("UPDATE users SET pw = ? WHERE id = 'igyr';", [hashed_pw])
                else:
                    res = turso_db.execute("UPDATE users SET pw = ? WHERE id = ? OR LOWER(id) = ?;", [new_pw, user_id, user_id.lower()])
                    if res.get("affected_row_count", 0) == 0:
                        turso_db.execute("INSERT INTO users (id, pw, role, name, inst) VALUES (?, ?, 'user', ?, ?);", [user_id, new_pw, user_id, user_id])
                self._send_json({"ok": True, "message": f"Password for {user_id} updated successfully."})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self._send_json({"ok": False, "error": "Method not allowed"}, status=HTTPStatus.METHOD_NOT_ALLOWED)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        params = parse_qs(parsed.query)

        # Delete Student
        if path == "/api/students":
            uid = params.get("uid", [None])[0]
            if uid:
                try:
                    turso_db.execute("DELETE FROM students WHERE uid = ?;", [uid])
                    turso_db.execute("DELETE FROM users WHERE id = ?;", [uid])
                    self._send_json({"ok": True, "message": f"Student {uid} deleted"})
                    return
                except Exception as e:
                    self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
                    return

        # Delete Institute
        if path == "/api/institutes":
            inst_id = params.get("id", [None])[0]
            if inst_id:
                try:
                    turso_db.execute("DELETE FROM institutes WHERE id = ?;", [inst_id])
                    turso_db.execute("DELETE FROM users WHERE inst = ? OR id = ?;", [inst_id, inst_id])
                    turso_db.execute("DELETE FROM students WHERE inst = ?;", [inst_id])
                    turso_db.execute("DELETE FROM classes WHERE inst = ?;", [inst_id])
                    turso_db.execute("DELETE FROM subjects WHERE inst = ?;", [inst_id])
                    self._send_json({"ok": True, "message": f"Institute {inst_id} deleted"})
                    return
                except Exception as e:
                    self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
                    return

        # Delete Announcement
        if path == "/api/announcements":
            ann_id = params.get("id", [None])[0]
            inst = params.get("inst", [None])[0]
            text = params.get("text", [None])[0]
            try:
                turso_db.delete_announcement(ann_id=ann_id, inst=inst, text=text)
                self._send_json({"ok": True, "message": "Announcement deleted successfully."})
                return
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
                return

        self._send_json({"ok": False, "error": "Not found"}, status=HTTPStatus.NOT_FOUND)

def run():
    # Ensure database schema is initialized on startup
    print("Connecting to Turso Database...")
    print(f"Turso URL: {TURSO_DATABASE_URL}")
    try:
        turso_db.init_db()
        print("✓ Connected to Turso cloud successfully & verified database tables!")
    except Exception as e:
        print(f"Warning: Turso initialization error: {e}")

    server_address = (HOST, PORT)
    httpd = ThreadingHTTPServer(server_address, IgyrRequestHandler)
    print(f"============================================================")
    print(f"🚀 IGYR Python Backend Server running at http://localhost:{PORT}")
    print(f"🔗 Connected to Turso cloud: {TURSO_DATABASE_URL}")
    print(f"============================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        PORT = int(sys.argv[1])
    run()
