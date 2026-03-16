from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import verify_app_key
from app.core.logger import LOG_DIR
from app.services.grok.utils.cache import CacheService
from app.services.token.manager import get_token_manager


router = APIRouter()

_CHAT_MODEL_RE = re.compile(r"model=([^,\s]+)")
_SUPPORTED_LOG_SUFFIX = ".log"
_REQUEST_PATH_PREFIX = "/v1/"
_REQUEST_PATH_EXCLUDES = ("/v1/admin/",)
_FIXED_PATH_MODELS = {
    "/v1/images/generations": "grok-imagine-1.0",
    "/v1/images/edits": "grok-imagine-1.0-edit",
    "/v1/videos": "grok-imagine-1.0-video",
    "/v1/video/extend": "grok-imagine-1.0-video",
}
_METRICS_CACHE: dict[str, Any] = {
    "signature": None,
    "stats": None,
}


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.astimezone()
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.astimezone()


def _iter_log_paths(log_dir: Path) -> list[Path]:
    if not log_dir.exists() or not log_dir.is_dir():
        return []
    return sorted(
        (path for path in log_dir.iterdir() if path.is_file() and path.suffix.lower() == _SUPPORTED_LOG_SUFFIX),
        key=lambda item: (item.stat().st_mtime_ns, item.name),
        reverse=True,
    )


def _read_json_line(line: str) -> dict[str, Any] | None:
    text = line.strip()
    if not text:
        return None
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _is_counted_request_path(path: str) -> bool:
    if not path or not path.startswith(_REQUEST_PATH_PREFIX):
        return False
    return not any(path.startswith(prefix) for prefix in _REQUEST_PATH_EXCLUDES)


def _extract_model(record: dict[str, Any]) -> str | None:
    message = str(record.get("msg") or "")
    if "Chat completed:" in message:
        match = _CHAT_MODEL_RE.search(message)
        if match:
            return match.group(1)

    path = str(record.get("path") or "")
    status = record.get("status")
    if isinstance(status, int) and status < 400:
        return _FIXED_PATH_MODELS.get(path)
    return None


def summarize_token_metrics(pool_stats: dict[str, dict[str, Any]]) -> dict[str, int]:
    summary = {
        "total": 0,
        "active": 0,
        "cooling": 0,
        "expired": 0,
        "disabled": 0,
        "total_calls": 0,
    }
    for stats in (pool_stats or {}).values():
        if not isinstance(stats, dict):
            continue
        summary["total"] += int(stats.get("total") or 0)
        summary["active"] += int(stats.get("active") or 0)
        summary["cooling"] += int(stats.get("cooling") or 0)
        summary["expired"] += int(stats.get("expired") or 0)
        summary["disabled"] += int(stats.get("disabled") or 0)
    return summary


def build_request_stats(records: Iterable[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    current = now or datetime.now().astimezone()
    bucket_tz = current.tzinfo
    hour_end = current.astimezone(bucket_tz).replace(minute=0, second=0, microsecond=0)
    hour_start = hour_end - timedelta(hours=23)
    day_end = current.astimezone(bucket_tz).replace(hour=0, minute=0, second=0, microsecond=0)
    day_start = day_end - timedelta(days=6)

    hourly_buckets = [hour_start + timedelta(hours=index) for index in range(24)]
    daily_buckets = [day_start + timedelta(days=index) for index in range(7)]
    hourly = {
        bucket: {"hour": bucket.strftime("%H:00"), "success": 0, "failed": 0}
        for bucket in hourly_buckets
    }
    daily = {
        bucket: {"date": bucket.strftime("%m-%d"), "success": 0, "failed": 0}
        for bucket in daily_buckets
    }
    models: dict[str, int] = {}
    summary_total = 0
    summary_success = 0
    summary_failed = 0

    for record in records:
        timestamp = _parse_time(record.get("time"))
        if timestamp is None:
            continue
        timestamp = timestamp.astimezone(bucket_tz)

        model_name = _extract_model(record)
        if model_name and timestamp >= day_start:
            models[model_name] = models.get(model_name, 0) + 1

        path = str(record.get("path") or "")
        status = record.get("status")
        if not isinstance(status, int) or not _is_counted_request_path(path):
            continue
        if timestamp < day_start:
            continue

        summary_total += 1
        is_success = status < 400
        if is_success:
            summary_success += 1
        else:
            summary_failed += 1

        day_bucket = timestamp.replace(hour=0, minute=0, second=0, microsecond=0)
        if day_bucket in daily:
            daily[day_bucket]["success" if is_success else "failed"] += 1

        hour_bucket = timestamp.replace(minute=0, second=0, microsecond=0)
        if hour_bucket in hourly:
            hourly[hour_bucket]["success" if is_success else "failed"] += 1

    success_rate = round((summary_success / summary_total) * 100, 1) if summary_total else 0.0
    top_models = sorted(models.items(), key=lambda item: (-item[1], item[0]))[:10]
    return {
        "summary": {
            "total": summary_total,
            "success": summary_success,
            "failed": summary_failed,
            "success_rate": success_rate,
        },
        "hourly": list(hourly.values()),
        "daily": list(daily.values()),
        "models": [{"model": name, "count": count} for name, count in top_models],
    }


def list_log_files(log_dir: Path) -> list[dict[str, Any]]:
    files = []
    for path in _iter_log_paths(log_dir):
        stat = path.stat()
        files.append(
            {
                "name": path.name,
                "size_bytes": stat.st_size,
                "modified_at": int(stat.st_mtime * 1000),
            }
        )
    return files


def _format_log_line(line: str) -> str:
    parsed = _read_json_line(line)
    if not parsed:
        return line.rstrip("\r\n")

    timestamp = _parse_time(parsed.get("time"))
    time_text = timestamp.strftime("%Y-%m-%d %H:%M:%S") if timestamp else "-"
    level = str(parsed.get("level") or "info").upper()
    message = str(parsed.get("msg") or "").strip()
    extras = []
    for key in ("method", "path", "status", "caller", "duration_ms", "traceID"):
        value = parsed.get(key)
        if value is not None and value != "":
            extras.append(f"{key}={value}")

    suffix = f" | {' '.join(extras)}" if extras else ""
    return f"[{time_text}] {level} {message}{suffix}".rstrip()


def read_log_tail(log_dir: Path, file_name: str | None = None, lines: int = 500) -> dict[str, Any]:
    available = _iter_log_paths(log_dir)
    if not available:
        return {"file": "", "lines": []}

    if file_name:
        if Path(file_name).name != file_name or "/" in file_name or "\\" in file_name:
            raise ValueError("Invalid log file name")
        target = log_dir / file_name
        if not target.exists() or not target.is_file() or target.suffix.lower() != _SUPPORTED_LOG_SUFFIX:
            raise FileNotFoundError(file_name)
    else:
        target = available[0]

    raw_lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    tail = raw_lines[-max(1, int(lines)) :]
    return {
        "file": target.name,
        "lines": [_format_log_line(line) for line in tail],
    }


def _collect_request_stats(log_dir: Path) -> dict[str, Any]:
    log_paths = _iter_log_paths(log_dir)
    signature = tuple((path.name, path.stat().st_mtime_ns, path.stat().st_size) for path in log_paths)
    cached_signature = _METRICS_CACHE.get("signature")
    cached_stats = _METRICS_CACHE.get("stats")
    if cached_signature == signature and cached_stats is not None:
        return cached_stats

    records = []
    for path in reversed(log_paths):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            parsed = _read_json_line(line)
            if parsed:
                records.append(parsed)

    stats = build_request_stats(records)
    _METRICS_CACHE["signature"] = signature
    _METRICS_CACHE["stats"] = stats
    return stats


@router.get("/metrics", dependencies=[Depends(verify_app_key)])
async def get_metrics():
    manager = await get_token_manager()
    token_summary = summarize_token_metrics(manager.get_stats())
    token_summary["total_calls"] = sum(
        int(getattr(token, "use_count", 0) or 0)
        for pool in manager.pools.values()
        for token in pool.list()
    )

    cache_service = CacheService()
    return {
        "tokens": token_summary,
        "cache": {
            "local_image": cache_service.get_stats("image"),
            "local_video": cache_service.get_stats("video"),
        },
        "request_stats": _collect_request_stats(LOG_DIR),
    }


@router.get("/logs/files", dependencies=[Depends(verify_app_key)])
async def get_log_files():
    return {"files": list_log_files(LOG_DIR)}


@router.get("/logs/tail", dependencies=[Depends(verify_app_key)])
async def get_log_tail(
    file: str | None = Query(default=None),
    lines: int = Query(default=500, ge=1, le=5000),
):
    try:
        return read_log_tail(LOG_DIR, file_name=file, lines=lines)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Log file not found: {exc.args[0]}") from exc


__all__ = [
    "router",
    "build_request_stats",
    "list_log_files",
    "read_log_tail",
    "summarize_token_metrics",
]
