"""
IGYR Smart Platform - Email Delivery Service (Gmail SMTP)
"""

import os
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage
from config import SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

ROOT_DIR = os.path.dirname(__file__)
BANNER_CANDIDATES = [
    os.path.join(ROOT_DIR, "assets", "igyr-banner.png"),
    os.path.join(ROOT_DIR, "igyr-banner.png"),
]

def get_banner_path() -> str:
    """Return local path to banner image if available."""
    for p in BANNER_CANDIDATES:
        if os.path.isfile(p):
            return p
    return ""

def send_email(to_email: str, subject: str, html_body: str, text_body: str = "", attach_banner: bool = True) -> bool:
    """Send an HTML email via Gmail SMTP with optional embedded inline banner image."""
    msg = MIMEMultipart("related")
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = to_email

    alt_part = MIMEMultipart("alternative")
    if text_body:
        alt_part.attach(MIMEText(text_body, "plain", "utf-8"))
    alt_part.attach(MIMEText(html_body, "html", "utf-8"))
    msg.attach(alt_part)

    if attach_banner:
        banner_path = get_banner_path()
        if banner_path:
            try:
                with open(banner_path, "rb") as f:
                    img_part = MIMEImage(f.read())
                    img_part.add_header("Content-ID", "<igyr_banner>")
                    img_part.add_header("Content-Disposition", "inline", filename="igyr-banner.png")
                    msg.attach(img_part)
            except Exception as e:
                print(f"[Email Service] Could not attach banner image: {e}")

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=20) as server:
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(SMTP_USER, to_email, msg.as_string())
    return True

def send_otp_email(to_email: str, user_name: str, role: str, user_id: str, otp: str) -> bool:
    """Send a stylized OTP email with embedded official signature banner for password reset."""
    subject = f"🔐 {otp} is your IGYR Password Reset Code"
    
    role_titles = {
        "student": "Student",
        "teacher": "Faculty / Teacher",
        "institute": "Institute Administrator"
    }
    role_label = role_titles.get(role.lower(), role.capitalize())

    text_body = f"""Hello {user_name},

We received a request to reset your password on the IGYR Smart Management Platform.
Your 6-Digit OTP Verification Code is: {otp}
Valid for 10 minutes.

Account Name: {user_name}
Role: {role_label}
User ID: {user_id}

If you did not request this, please disregard this email.

--
IGYR Smart Platform - Founder: Arnnav Panda
Email: pandaarnav3@gmail.com
India Get Your Result | https://igyrmannagementplatform.vercel.app/
"""

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b; }}
        .card {{ max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }}
        .header {{ background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%); color: #ffffff; padding: 28px 24px; text-align: center; }}
        .header h1 {{ margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.3px; }}
        .header p {{ margin: 6px 0 0; font-size: 13px; color: #bfdbfe; }}
        .content {{ padding: 30px 26px 20px; line-height: 1.6; }}
        .greeting {{ font-size: 16px; font-weight: 600; margin-bottom: 12px; }}
        .otp-box {{ background: #eff6ff; border: 2px dashed #3b82f6; border-radius: 12px; padding: 20px; text-align: center; margin: 22px 0; }}
        .otp-code {{ font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #1d4ed8; font-family: monospace; }}
        .otp-hint {{ font-size: 13px; color: #64748b; margin-top: 8px; }}
        .info-table {{ width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14px; background: #f8fafc; border-radius: 8px; overflow: hidden; }}
        .info-table td {{ padding: 10px 14px; border-bottom: 1px solid #e2e8f0; }}
        .info-table td:first-child {{ color: #64748b; width: 35%; font-weight: 500; }}
        .info-table td:last-child {{ font-weight: 600; color: #0f172a; }}
        .warning {{ background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 14px; border-radius: 6px; font-size: 13px; color: #92400e; margin: 18px 0; }}
        .banner-container {{ padding: 0 20px 20px; text-align: center; background: #ffffff; }}
        .banner-img {{ width: 100%; max-width: 520px; height: auto; display: block; margin: 0 auto; border-radius: 12px; border: 1px solid #bfdbfe; box-shadow: 0 4px 14px rgba(37,99,235,0.08); }}
        .footer {{ background: #fafafa; border-top: 1px solid #f1f5f9; padding: 18px; text-align: center; font-size: 12px; color: #94a3b8; line-height: 1.5; }}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1>🏛️ IGYR Smart Platform</h1>
          <p>Password Reset Verification</p>
        </div>
        <div class="content">
          <div class="greeting">Hello {user_name},</div>
          <p style="margin:0 0 16px; font-size:14px; color:#475569;">
            We received a request to reset the password for your account on the <b>IGYR Smart Management Platform</b>. Use the one-time verification code below to set your new password:
          </p>

          <table class="info-table">
            <tr><td>Account Name:</td><td>{user_name}</td></tr>
            <tr><td>Role:</td><td><span style="background:#dbeafe;color:#1e40af;padding:3px 8px;border-radius:6px;font-size:12px;">{role_label}</span></td></tr>
            <tr><td>User ID:</td><td><code>{user_id}</code></td></tr>
          </table>

          <div class="otp-box">
            <div style="font-size:12px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Your 6-Digit OTP</div>
            <div class="otp-code">{otp}</div>
            <div class="otp-hint">⏱️ Valid for 10 minutes. Do not share this code with anyone.</div>
          </div>

          <div class="warning">
            ⚠️ <b>Note:</b> If you did not make this request, your account is still secure. You can safely disregard this email or notify your institute administration.
          </div>
        </div>

        <!-- Official Signature Banner uploaded by Founder -->
        <div class="banner-container">
          <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">
            Official Platform Signature
          </div>
          <a href="https://igyrmannagementplatform.vercel.app/" target="_blank" style="text-decoration:none;display:block;">
            <img class="banner-img" src="cid:igyr_banner" alt="Meet IGYR Smart Platform - Founder Arnnav Panda" />
          </a>
        </div>

        <div class="footer">
          IGYR Smart Management Platform &copy; 2026<br>
          Automated security dispatch from <code>{SMTP_USER}</code>.
        </div>
      </div>
    </body>
    </html>
    """
    return send_email(to_email, subject, html, text_body=text_body, attach_banner=True)

def send_password_success_email(to_email: str, user_name: str, user_id: str) -> bool:
    """Send confirmation email after password has been successfully reset."""
    subject = "✅ Your IGYR Password Has Been Changed"
    text_body = f"""Hello {user_name},

The password for your IGYR account (User ID: {user_id}) was successfully updated.
You can now sign in to the portal using your new password:
https://igyrmannagementplatform.vercel.app/

--
IGYR Smart Platform - Founder: Arnnav Panda
Email: pandaarnav3@gmail.com
"""

    html = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8">
      <style>
        body {{ font-family: -apple-system, sans-serif; background-color: #f1f5f9; padding: 24px; color: #1e293b; }}
        .card {{ max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 14px; padding: 28px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }}
        .banner-img {{ width: 100%; max-width: 500px; height: auto; display: block; margin: 20px auto 0; border-radius: 12px; border: 1px solid #bfdbfe; box-shadow: 0 4px 12px rgba(37,99,235,0.08); }}
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="color:#0f766e;margin-top:0;">✅ Password Reset Successful</h2>
        <p>Hello <b>{user_name}</b>,</p>
        <p>The password for your IGYR account (User ID: <code>{user_id}</code>) was successfully updated.</p>
        <p>You can now sign in to the portal using your new password.</p>
        
        <a href="https://igyrmannagementplatform.vercel.app/" target="_blank" style="text-decoration:none;display:block;">
          <img class="banner-img" src="cid:igyr_banner" alt="Meet IGYR Smart Platform - Founder Arnnav Panda" />
        </a>

        <div style="margin-top:24px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:12px;text-align:center;">
          IGYR Smart Management Platform &bull; Security Notification
        </div>
      </div>
    </body>
    </html>
    """
    return send_email(to_email, subject, html, text_body=text_body, attach_banner=True)
