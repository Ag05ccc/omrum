from __future__ import annotations
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

Period = Literal["day", "week", "month", "year", "range"]
PERIODS: tuple[Period, ...] = ("day", "week", "month", "year", "range")


@dataclass(frozen=True)
class Window:
    period: Period
    anchor: str          # canonical YYYY-MM-DD (for range: "start..end")
    label: str           # human-readable label
    start_ts: float
    end_ts: float
    prev_anchor: str
    next_anchor: str


def _parse_date(s: str | None, fallback: date | None = None) -> date:
    if not s:
        return fallback or date.today()
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return fallback or date.today()


def _midnight(d: date) -> float:
    return datetime(d.year, d.month, d.day).timestamp()


def _fmt_range_label(start: date, end_inclusive: date) -> str:
    if start == end_inclusive:
        return start.strftime("%b %-d, %Y")
    if start.year == end_inclusive.year:
        if start.month == end_inclusive.month:
            return f"{start.strftime('%b %-d')} – {end_inclusive.strftime('%-d, %Y')}"
        return f"{start.strftime('%b %-d')} – {end_inclusive.strftime('%b %-d, %Y')}"
    return f"{start.strftime('%b %-d, %Y')} – {end_inclusive.strftime('%b %-d, %Y')}"


def resolve(period: str | None,
            anchor: str | None = None,
            start: str | None = None,
            end: str | None = None) -> Window:
    p: Period = period if period in PERIODS else "day"  # type: ignore[assignment]

    if p == "range":
        # The request passes inclusive start + end dates.
        s = _parse_date(start)
        e = _parse_date(end, fallback=s)
        if e < s:
            s, e = e, s
        length = (e - s).days + 1
        end_exclusive = e + timedelta(days=1)
        prev_s = s - timedelta(days=length)
        prev_e = s - timedelta(days=1)
        next_s = end_exclusive
        next_e = end_exclusive + timedelta(days=length - 1)
        return Window(
            period="range",
            anchor=f"{s.isoformat()}..{e.isoformat()}",
            label=_fmt_range_label(s, e),
            start_ts=_midnight(s),
            end_ts=_midnight(end_exclusive),
            prev_anchor=f"{prev_s.isoformat()}..{prev_e.isoformat()}",
            next_anchor=f"{next_s.isoformat()}..{next_e.isoformat()}",
        )

    d = _parse_date(anchor)

    if p == "day":
        start_d = d
        end_d = start_d + timedelta(days=1)
        prev_d = start_d - timedelta(days=1)
        next_d = end_d
        label = start_d.strftime("%a %b %-d, %Y")

    elif p == "week":
        start_d = d - timedelta(days=d.weekday())  # Monday
        end_d = start_d + timedelta(days=7)
        prev_d = start_d - timedelta(days=7)
        next_d = end_d
        iso_year, iso_week, _ = start_d.isocalendar()
        label = f"Week {iso_week:02d}, {iso_year} ({start_d.strftime('%b %-d')}–{(end_d - timedelta(days=1)).strftime('%b %-d')})"

    elif p == "month":
        start_d = date(d.year, d.month, 1)
        last = monthrange(start_d.year, start_d.month)[1]
        end_d = start_d + timedelta(days=last)
        prev_d = (start_d - timedelta(days=1)).replace(day=1)
        next_d = end_d
        label = start_d.strftime("%B %Y")

    else:  # year
        start_d = date(d.year, 1, 1)
        end_d = date(d.year + 1, 1, 1)
        prev_d = date(d.year - 1, 1, 1)
        next_d = end_d
        label = str(start_d.year)

    return Window(
        period=p,
        anchor=start_d.isoformat(),
        label=label,
        start_ts=_midnight(start_d),
        end_ts=_midnight(end_d),
        prev_anchor=prev_d.isoformat(),
        next_anchor=next_d.isoformat(),
    )
