import os
from pathlib import Path

# Load .env manually without external dependency
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

TURSO_DATABASE_URL = os.environ.get(
    "TURSO_DATABASE_URL",
    "libsql://igyr-samrt-paltform-igyr.aws-ap-south-1.turso.io"
)

# Convert libsql:// to https:// for HTTP pipeline API
TURSO_HTTP_URL = TURSO_DATABASE_URL.replace("libsql://", "https://")

TURSO_AUTH_TOKEN = os.environ.get(
    "TURSO_AUTH_TOKEN",
    "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTU2NjM3ODYsImlkIjoiMDFhMjE1ZTQtMjUwMS03ODBiLWEwMGEtNDM5MmZmZGMyNDliIiwia2lkIjoiTWdWa3Uyc25IMG9FZjdYa1NlNkhYVDNpMnhpRU92U0JLc01odXZHQy1KQSIsInJpZCI6ImI2NTQyY2M2LTcwMDItNDBlYS1hZWIyLWMzN2NiNmNjMGYxNiJ9.xLWr0cfU1rPzNyv3n2ITME2gTZtuubrH4UJm4aoZHSq6ZdQxAt_9bgh3MywqqzB7uL8ho_-9NKpOL9ypcE0gAQ"
)

PORT = int(os.environ.get("PORT", "5500"))
HOST = os.environ.get("HOST", "0.0.0.0")

# SMTP Email Configuration
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "igyradmin@gmail.com")
SMTP_PASS = os.environ.get("SMTP_PASS", "riksmsttovykaimb").replace(" ", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "IGYR Smart Platform <igyradmin@gmail.com>")
