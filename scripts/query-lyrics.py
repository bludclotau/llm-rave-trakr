"""Print word-factory vocal rows as JSON.

Run with the word-factory virtualenv. The parent process supplies the
database environment. This script writes rows to stdout and never prints
a password, a connection string, or a Bark prompt.
"""

from __future__ import annotations

import json
import sys

from wordfactory.config import load_config
from wordfactory.db import connection


def main() -> int:
    cfg = load_config()
    sql = f"""
        SELECT s.id,
               w.text AS word,
               w.mood,
               w.explicit,
               t.name AS treatment,
               s.duration_sec,
               s.peak_dbfs,
               s.review_status,
               s.file_path
        FROM {cfg.table("samples")} AS s
        JOIN {cfg.table("words")} AS w ON w.id = s.word_id
        JOIN {cfg.table("treatments")} AS t ON t.id = s.treatment_id
        ORDER BY s.id
    """
    with connection(cfg) as conn:
        rows = conn.execute(sql).fetchall()
        conn.rollback()
    out = []
    for row in rows:
        duration = row["duration_sec"]
        peak = row["peak_dbfs"]
        out.append(
            {
                "id": int(row["id"]),
                "word": row["word"],
                "mood": row["mood"],
                "explicit": bool(row["explicit"]),
                "treatment": row["treatment"],
                "duration": float(duration) if duration is not None else None,
                "peak_dbfs": float(peak) if peak is not None else None,
                "review": row["review_status"],
                "file": row["file_path"],
            }
        )
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(0)
    except Exception as exc:
        print(type(exc).__name__, file=sys.stderr)
        raise SystemExit(1)
