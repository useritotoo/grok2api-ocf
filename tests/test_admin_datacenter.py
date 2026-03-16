from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.api.v1.admin.datacenter import (
    build_request_stats,
    read_log_tail,
    summarize_token_metrics,
)


UTC = timezone.utc


class DatacenterMetricsTests(unittest.TestCase):
    def test_summarize_token_metrics_aggregates_all_pools(self) -> None:
        stats = summarize_token_metrics(
            {
                "ssoBasic": {
                    "total": 2,
                    "active": 1,
                    "cooling": 1,
                    "expired": 0,
                    "disabled": 0,
                },
                "ssoSuper": {
                    "total": 3,
                    "active": 2,
                    "cooling": 0,
                    "expired": 1,
                    "disabled": 0,
                },
            }
        )

        self.assertEqual(
            stats,
            {
                "total": 5,
                "active": 3,
                "cooling": 1,
                "expired": 1,
                "disabled": 0,
                "total_calls": 0,
            },
        )

    def test_build_request_stats_groups_recent_entries_and_models(self) -> None:
        now = datetime(2026, 3, 16, 12, 30, tzinfo=UTC)
        records = [
            {
                "time": (now - timedelta(hours=1)).isoformat(),
                "path": "/v1/chat/completions",
                "status": 200,
                "method": "POST",
                "msg": "Response: POST /v1/chat/completions - 200",
            },
            {
                "time": (now - timedelta(minutes=30)).isoformat(),
                "path": "/v1/chat/completions",
                "status": 500,
                "method": "POST",
                "msg": "Response: POST /v1/chat/completions - 500",
            },
            {
                "time": (now - timedelta(hours=2)).isoformat(),
                "path": "/v1/images/generations",
                "status": 200,
                "method": "POST",
                "msg": "Response: POST /v1/images/generations - 200",
            },
            {
                "time": (now - timedelta(days=1)).isoformat(),
                "msg": "Chat completed: model=grok-4, effort=low",
            },
            {
                "time": (now - timedelta(days=2)).isoformat(),
                "msg": "Chat completed: model=grok-4, effort=high",
            },
            {
                "time": (now - timedelta(hours=3)).isoformat(),
                "path": "/v1/admin/tokens",
                "status": 200,
                "method": "GET",
                "msg": "Response: GET /v1/admin/tokens - 200",
            },
        ]

        stats = build_request_stats(records, now=now)

        self.assertEqual(stats["summary"]["total"], 3)
        self.assertEqual(stats["summary"]["success"], 2)
        self.assertEqual(stats["summary"]["failed"], 1)
        self.assertAlmostEqual(stats["summary"]["success_rate"], 66.7, places=1)
        self.assertEqual(len(stats["hourly"]), 24)
        self.assertEqual(len(stats["daily"]), 7)
        self.assertEqual(stats["hourly"][-2]["success"], 1)
        self.assertEqual(stats["hourly"][-1]["failed"], 1)
        self.assertEqual(stats["models"][0], {"model": "grok-4", "count": 2})
        self.assertEqual(stats["models"][1], {"model": "grok-imagine-1.0", "count": 1})


class DatacenterLogsTests(unittest.TestCase):
    def test_read_log_tail_uses_latest_file_and_formats_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            log_dir = Path(temp_dir)
            older = log_dir / "app_2026-03-15.log"
            newer = log_dir / "app_2026-03-16.log"
            older.write_text('{"time":"2026-03-15T00:00:00+00:00","level":"info","msg":"old"}\n', encoding="utf-8")
            newer.write_text(
                "\n".join(
                    [
                        '{"time":"2026-03-16T01:00:00+00:00","level":"info","msg":"first","path":"/v1/chat/completions","status":200}',
                        '{"time":"2026-03-16T02:00:00+00:00","level":"error","msg":"second","path":"/v1/chat/completions","status":500}',
                        "plain text line",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            result = read_log_tail(log_dir, file_name=None, lines=2)

            self.assertEqual(result["file"], "app_2026-03-16.log")
            self.assertEqual(len(result["lines"]), 2)
            self.assertIn("ERROR", result["lines"][0])
            self.assertIn("/v1/chat/completions", result["lines"][0])
            self.assertEqual(result["lines"][1], "plain text line")


if __name__ == "__main__":
    unittest.main()
