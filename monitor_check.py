#!/usr/bin/env python3
"""
monitor_check.py - ONE.GY external alert check
===============================================

Reads the app's /metrics page and posts to a chat webhook when the set of open
critical/warning issues changes (new or resolved), plus a daily reminder while
anything stays open. The issue rules live in the app (src/app/355_monitoring.py,
exported as `onegy_issue` lines); this script only adds the one thing the app
cannot report about itself: that its metrics cannot be read (unreachable,
timeout, TLS failure, rejected token or an HTTP error, each reported as such).

Run it from cron OUTSIDE the app's service (so it still fires when the app is
down), every 5 minutes:

    */5 * * * * cd /path/to/app && venv/bin/python monitor_check.py

Configuration (read from .env next to this file, then the environment):
    METRICS_TOKEN          required; the same token the app serves /metrics with
    MONITOR_WEBHOOK_URL    Discord/Slack-compatible webhook; empty = print only
    MONITOR_METRICS_URL    default https://127.0.0.1:<WEB_PORT>/metrics

Exit status: 0 nothing critical open, 1 a critical issue is open, 2 misconfigured,
3 an alert was due but the webhook post failed.
State is kept in instance/monitor_check_state.json.
"""
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(APP_DIR, 'instance', 'monitor_check_state.json')
REMIND_AFTER_SECONDS = 24 * 3600
FETCH_TIMEOUT_SECONDS = 30
_ISSUE_RE = re.compile(r'^onegy_issue\{(.*)\}\s+1\s*$')
_LABEL_RE = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')


def _load_env():
    try:
        from dotenv import load_dotenv
        load_dotenv(os.path.join(APP_DIR, '.env'))
    except ImportError:
        pass


def _unescape(value):
    return value.replace('\\n', '\n').replace('\\"', '"').replace('\\\\', '\\')


def parse_issues(text):
    """Map 'code:subject' -> issue dict for every critical/warning onegy_issue line."""
    issues = {}
    for line in text.splitlines():
        m = _ISSUE_RE.match(line)
        if not m:
            continue
        labels = {k: _unescape(v) for k, v in _LABEL_RE.findall(m.group(1))}
        if labels.get('severity') not in ('critical', 'warning'):
            continue
        issues[f"{labels.get('code', '')}:{labels.get('subject', '')}"] = {
            'severity': labels['severity'], 'summary': labels.get('summary', ''),
        }
    return issues


def fetch_issues(url, token):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    ctx = None
    if url.startswith('https://127.0.0.1') or url.startswith('https://localhost'):
        # The local gunicorn listener uses a self-signed certificate.
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SECONDS, context=ctx) as resp:
            return parse_issues(resp.read().decode('utf-8', 'replace'))
    except Exception as e:
        code, summary = fetch_failure(e)
        return {f'{code}:': {'severity': 'critical', 'summary': summary}}


def fetch_failure(e):
    """(issue code, summary) for a failed /metrics fetch, by cause."""
    if isinstance(e, urllib.error.HTTPError):
        if e.code in (401, 403):
            return 'metrics_auth_failed', f'App rejected METRICS_TOKEN (HTTP {e.code})'
        if e.code == 404:
            return 'metrics_disabled', 'App /metrics returned 404 (METRICS_TOKEN not set in the app?)'
        return 'metrics_http_error', f'App /metrics returned HTTP {e.code}'
    reason = getattr(e, 'reason', e)
    if isinstance(reason, ssl.SSLError):
        return 'metrics_tls_error', f'TLS error reaching app metrics: {reason}'
    if isinstance(reason, TimeoutError):
        return 'app_timeout', f'App metrics timed out after {FETCH_TIMEOUT_SECONDS}s'
    return 'app_unreachable', f'App metrics unreachable: {e}'


def build_message(current, previous, domain):
    new = [k for k in current if k not in previous]
    resolved = [k for k in previous if k not in current]
    lines = [f'ONE.GY monitoring ({domain})' if domain else 'ONE.GY monitoring']
    for k in new:
        lines.append(f'NEW {current[k]["severity"].upper()}: {current[k]["summary"]}')
    for k in resolved:
        lines.append(f'RESOLVED: {previous[k]["summary"]}')
    still = [k for k in current if k not in new]
    for k in still:
        lines.append(f'Still open ({current[k]["severity"]}): {current[k]["summary"]}')
    if not current:
        lines.append('All clear.')
    return '\n'.join(lines)


def post_webhook(url, message):
    body = json.dumps({'content': message[:1900], 'text': message}).encode()
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json',
                                                          'User-Agent': 'onegy-monitor-check'})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SECONDS):
        pass


def main():
    _load_env()
    token = (os.environ.get('METRICS_TOKEN') or '').strip()
    if not token:
        print('[MONITOR] ERROR: METRICS_TOKEN is not set')
        return 2
    url = (os.environ.get('MONITOR_METRICS_URL') or '').strip() or \
        f"https://127.0.0.1:{os.environ.get('WEB_PORT', '5000')}/metrics"
    webhook = (os.environ.get('MONITOR_WEBHOOK_URL') or '').strip()

    try:
        with open(STATE_PATH) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        state = {}
    previous = state.get('issues', {})
    current = fetch_issues(url, token)
    now = time.time()

    changed = set(current) != set(previous)
    remind = bool(current) and now - state.get('notified_at', 0) >= REMIND_AFTER_SECONDS
    delivered = True
    if changed or remind:
        message = build_message(current, previous, os.environ.get('DOMAIN', ''))
        print('[MONITOR] ' + message.replace('\n', '\n[MONITOR] '))
        if webhook:
            try:
                post_webhook(webhook, message)
                state['notified_at'] = now
            except Exception as e:
                print(f'[MONITOR] ERROR: webhook post failed: {e}')
                delivered = False
        else:
            state['notified_at'] = now
    # Keep the old issue set after a failed post so the change is announced again next run.
    state['issues'] = current if delivered else previous
    state['checked_at'] = now
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(state, fh)
    os.replace(tmp, STATE_PATH)
    if not delivered:
        return 3
    return 1 if any(i['severity'] == 'critical' for i in current.values()) else 0


if __name__ == '__main__':
    sys.exit(main())
