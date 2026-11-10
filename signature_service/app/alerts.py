"""Pipeline alerts: e-mail (SMTP) and Slack/Discord (incoming webhook). The dashboard toggles choose which fire.

  email  -> a run finished (deployed / rejected), failed or was stopped
  slack  -> a model was deployed, or a run failed / was stopped
  stuck  -> the Kaggle notebook sent no heartbeat for PIPELINE_STUCK_MINUTES (to every configured channel)
"""
from __future__ import annotations

import json
import logging
import smtplib
import urllib.request
from email.message import EmailMessage

log = logging.getLogger("signature.alerts")
EMAIL_KINDS = {"deployed", "rejected", "approved", "failed", "stopped"}
SLACK_KINDS = {"deployed", "failed", "stopped"}


class Notifier:
    def __init__(self, cfg, store, smtp_factory=smtplib.SMTP, http_post=None):
        self.cfg = cfg
        self.store = store
        self.smtp_factory = smtp_factory
        self.http_post = http_post or self._post

    def channels(self) -> dict:
        c = self.cfg
        return {"email": bool(c.smtp_host and c.alert_email_to), "slack": bool(c.alert_webhook_url)}

    def prefs(self) -> dict:
        saved = self.store.get_json("alerts") or {}
        ch = self.channels()
        return {"email": saved.get("email", ch["email"]), "slack": saved.get("slack", ch["slack"]),
                "stuck": saved.get("stuck", True)}

    def send(self, kind: str, subject: str, text: str) -> list[str]:
        prefs, ch, sent = self.prefs(), self.channels(), []
        want_email = ch["email"] and ((prefs["email"] and kind in EMAIL_KINDS) or (prefs["stuck"] and kind == "stuck"))
        want_slack = ch["slack"] and ((prefs["slack"] and kind in SLACK_KINDS) or (prefs["stuck"] and kind == "stuck"))
        if want_email:
            try:
                self._email(subject, text)
                sent.append("email")
            except Exception as exc:  # an alert must never break the pipeline
                log.warning("email alert failed: %s", exc)
        if want_slack:
            try:
                self.http_post(self.cfg.alert_webhook_url, {"text": f"*{subject}*\n{text}", "content": f"**{subject}**\n{text}"})
                sent.append("slack")
            except Exception as exc:
                log.warning("webhook alert failed: %s", exc)
        return sent

    def _email(self, subject: str, text: str) -> None:
        c = self.cfg
        msg = EmailMessage()
        msg["Subject"] = f"[SignatureAI] {subject}"
        msg["From"] = c.alert_email_from or c.smtp_user or c.alert_email_to
        msg["To"] = c.alert_email_to
        msg.set_content(text)
        with self.smtp_factory(c.smtp_host, c.smtp_port, timeout=15) as smtp:
            if c.smtp_port != 25:
                smtp.starttls()
            if c.smtp_user:
                smtp.login(c.smtp_user, c.smtp_password or "")
            smtp.send_message(msg)

    @staticmethod
    def _post(url: str, body: dict) -> None:
        request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "User-Agent": "signatureai-pipeline"})
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
