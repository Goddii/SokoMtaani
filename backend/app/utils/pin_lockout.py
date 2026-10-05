"""
PIN brute-force protection.

PINs are only 4 digits, so every PIN check (login and till verify-pin) shares
one per-attendant failure counter stored on the attendant row — it holds across
gunicorn workers and restarts. After MAX_FAILED_ATTEMPTS consecutive failures
the attendant is locked for LOCKOUT_MINUTES; a correct PIN resets the counter.
"""
from datetime import datetime, timedelta, timezone

from app.extensions import db
from app.models.attendant import Attendant

MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: datetime) -> datetime:
    # SQLite round-trips timezone-aware columns as naive UTC.
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def seconds_locked(attendant: Attendant) -> int:
    """Seconds left on the lockout, or 0 when the attendant may try a PIN."""
    if attendant.locked_until is None:
        return 0
    remaining = (_as_utc(attendant.locked_until) - _now()).total_seconds()
    return int(remaining) + 1 if remaining > 0 else 0


def record_failure(attendant: Attendant) -> None:
    """Count a wrong PIN and start the lockout when the limit is reached."""
    attendant.failed_pin_attempts = (attendant.failed_pin_attempts or 0) + 1
    if attendant.failed_pin_attempts >= MAX_FAILED_ATTEMPTS:
        attendant.locked_until = _now() + timedelta(minutes=LOCKOUT_MINUTES)
        attendant.failed_pin_attempts = 0
    db.session.commit()


def record_success(attendant: Attendant) -> None:
    """Clear the failure counter after a correct PIN."""
    if attendant.failed_pin_attempts or attendant.locked_until is not None:
        attendant.failed_pin_attempts = 0
        attendant.locked_until = None
        db.session.commit()
