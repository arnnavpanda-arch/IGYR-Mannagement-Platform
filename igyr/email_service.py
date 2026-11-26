"""
IGYR Smart Platform - Email Delivery Service (Gmail SMTP)
"""

import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from config import SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

def send_email(to_email: str, subject: str, html_body: str, text_body: str = "") -> bool:
    """Send an HTML email via Gmail SMTP with SSL."""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = to_email

    if text_body:
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=20) as server:
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(SMTP_USER, to_email, msg.as_string())
    return True

def send_otp_email(to_email: str, user_name: str, role: str, user_id: str, otp: str) -> bool:
    """Send a stylized OTP email for password reset."""
    subject = f"🔐 {otp} is your IGYR Password Reset Code"
    
    role_titles = {
        "student": "Student",
        "teacher": "Faculty / Teacher",
        "institute": "Institute Administrator"
    }
    role_label = role_titles.get(role.lower(), role.capitalize())

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b; }}
        .card {{ max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }}
        .header {{ background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%); color: #ffffff; padding: 28px 24px; text-align: center; }}
        .header h1 {{ margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.3px; }}
        .header p {{ margin: 6px 0 0; font-size: 13px; color: #bfdbfe; }}
        .content {{ padding: 32px 28px; line-height: 1.6; }}
        .greeting {{ font-size: 16px; font-weight: 600; margin-bottom: 12px; }}
        .otp-box {{ background: #eff6ff; border: 2px dashed #3b82f6; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0; }}
        .otp-code {{ font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #1d4ed8; font-family: monospace; }}
        .otp-hint {{ font-size: 13px; color: #64748b; margin-top: 8px; }}
        .info-table {{ width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14px; background: #f8fafc; border-radius: 8px; overflow: hidden; }}
        .info-table td {{ padding: 10px 14px; border-bottom: 1px solid #e2e8f0; }}
        .info-table td:first-child {{ color: #64748b; width: 35%; font-weight: 500; }}
        .info-table td:last-child {{ font-weight: 600; color: #0f172a; }}
        .footer {{ background: #fafafa; border-top: 1px solid #f1f5f9; padding: 20px; text-align: center; font-size: 12px; color: #94a3b8; line-height: 1.5; }}
        .warning {{ background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 14px; border-radius: 6px; font-size: 13px; color: #92400e; margin: 18px 0; }}
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
        <div class="footer">
          IGYR Smart Management Platform &copy; 2026<br>
          Automated security dispatch from <code>{SMTP_USER}</code>.
        </div>
      </div>
    </body>
    </html>
    """
    return send_email(to_email, subject, html)

def send_password_success_email(to_email: str, user_name: str, user_id: str) -> bool:
    """Send confirmation email after password has been successfully reset."""
    subject = "✅ Your IGYR Password Has Been Changed"
    html = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8">
      <style>
        body {{ font-family: -apple-system, sans-serif; background-color: #f1f5f9; padding: 24px; color: #1e293b; }}
        .card {{ max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 14px; padding: 28px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }}
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="color:#0f766e;margin-top:0;">✅ Password Reset Successful</h2>
        <p>Hello <b>{user_name}</b>,</p>
        <p>The password for your IGYR account (User ID: <code>{user_id}</code>) was successfully updated.</p>
        <p>You can now sign in to the portal using your new password.</p>
        <div style="margin-top:24px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:12px;">
          IGYR Smart Management Platform &bull; Security Notification
        </div>
      </div>
    </body>
    </html>
    """
    return send_email(to_email, subject, html)
