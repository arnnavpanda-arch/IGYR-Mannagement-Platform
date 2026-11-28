# IGYR Smart Management Platform - Python & Turso Cloud Backend

A modern, high-performance web platform for Educational Institutes, Teachers, and Students, powered by a **Python backend** connected to a **Turso (libSQL) cloud database**.

---

## 🏛️ Architecture Overview

- **Backend:** Python 3 (Native zero-dependency server using `http.server`, `urllib`, `ssl`, and `json`).
- **Database:** [Turso Cloud Database](https://turso.tech/) (Distributed SQLite over HTTP v2 pipeline).
- **Frontend:** Vanilla HTML5 / CSS3 / ES6+ JavaScript.
- **Persistence:** Real-time multi-device cloud synchronization with offline-ready local cache fallback.

---

## ⚙️ Configuration & Turso Database

The project is configured via `.env` and `config.py` with your Turso credentials:

```ini
TURSO_DATABASE_URL=libsql://your-database-name.aws-ap-south-1.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token_here
PORT=5500
HOST=0.0.0.0
```

---

## 🚀 How to Run the Python Backend

From the project directory:

```bash
python3 server.py
```
or
```bash
python3 app.py
```

Then open your browser at:
```
http://localhost:5500
```

---

## 🔐 Default Credentials

| Role | Username / ID | Password | Access / Scope |
|---|---|---|---|
| **Super Admin** | `igyr` | `cutiee` (PBKDF2 encrypted) | Create institutes, manage public logo, view all stats |
| **Institute Admin** | Auto-generated from name | Auto-generated 6-char | Full institute dashboard (teachers, students, fees, timetable, exams) |
| **Teacher** | Auto-generated 6-char | Auto-generated 6-char | Teacher portal (assigned subjects, attendance register, materials) |
| **Student** | Student Name | Auto-generated 6-char | Student portal (profile, dues/receipts, attendance, timetable, online exams) |

---

## 🗄️ Database Tables in Turso

The database tables are automatically created on server start:

- `system_config`: App settings and circular brand logo.
- `users`: User authentication (`id`, `pw`, `role`, `name`, `inst`).
- `institutes`: Registered institutes (`id`, `name`, `loc`, `det`).
- `classes`: Institute academic classes.
- `subjects`: Assigned courses, subject-specific fees, and teachers.
- `students`: Student profiles, contact details, fee structures, and profile photos.
- `attendance`: Daily student attendance records.
- `payments`: Fee transaction ledger with receipts.
- `timetables`: Weekly class schedules and timetable slots.
- `materials`: Course syllabus, notes, and PDF download links.
- `announcements`: Broadcast notice board messages.
- `exams`: Online quizzes and multiple-choice examination questions.
- `results`: Exam scores and student test submissions.

---

## 🌐 REST API Endpoints

- `GET  /api/health` — Verifies server health and tests live connection to Turso cloud.
- `POST /api/auth/login` — Authenticates credentials against the Turso database.
- `GET  /api/db` — Retrieves full synchronized database state from Turso.
- `POST /api/db/save` — Synchronizes and saves changes into the Turso cloud database.
- `POST /api/institutes` — Creates new institute and admin user.
- `DELETE /api/institutes?id=<id>` — Removes institute and associated data.
- `PUT  /api/students` — Updates student profile and enrolled class.
- `DELETE /api/students?uid=<uid>` — Deletes student record.
