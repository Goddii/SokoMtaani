"""
Shop business-time helpers.

All business-day calculations in SokoMtaani use the shop's local timezone
(Africa/Nairobi by default), NOT UTC. A sale at 00:30 EAT belongs to the
Kenyan business day that started a few hours earlier in UTC terms.

The database stores timestamps as UTC (naive UTC on SQLite). Boundaries are
computed in shop-local time and converted to UTC for querying.
"""
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.extensions import db

SHOP_TIMEZONE_NAME = "Africa/Nairobi"
SHOP_TZ = ZoneInfo(SHOP_TIMEZONE_NAME)


def shop_now() -> datetime:
    """Current wall-clock time in the shop timezone."""
    return datetime.now(SHOP_TZ)


def today_shop_date() -> str:
    """Today's business date in the shop timezone, YYYY-MM-DD."""
    return shop_now().strftime("%Y-%m-%d")


def business_day_bounds(date_str: str) -> tuple[datetime, datetime]:
    """Return (start_utc, end_utc_exclusive) covering one local business day.

    Raises ValueError when date_str is not YYYY-MM-DD.
    """
    d = datetime.strptime(date_str, "%Y-%m-%d").date()
    start_local = datetime.combine(d, time.min, tzinfo=SHOP_TZ)
    end_local = datetime.combine(d + timedelta(days=1), time.min, tzinfo=SHOP_TZ)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def shop_date_of(dt: datetime) -> str:
    """The Kenya business date (YYYY-MM-DD) of a stored UTC timestamp.

    Naive datetimes are assumed to be UTC (SQLite round-trips them that way).
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(SHOP_TZ).strftime("%Y-%m-%d")


def db_ready_utc(dt: datetime) -> datetime:
    """A datetime ready to bind against Sale.created_at for this engine.

    SQLite stores naive UTC and cannot bind tz-aware datetimes; PostgreSQL
    (DateTime(timezone=True)) expects them aware. Normalise per dialect.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if db.engine.dialect.name == "sqlite":
        return dt.replace(tzinfo=None)
    return dt
