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

# Secrets are read from environment variables or local .env file only
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")

PORT = int(os.environ.get("PORT", "5500"))
HOST = os.environ.get("HOST", "0.0.0.0")

# SMTP Email Configuration (loaded strictly from environment variables or .env)
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "").replace(" ", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "IGYR Smart Platform")
