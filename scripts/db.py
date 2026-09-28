#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""直接查询 EnglishForge 进度数据库（只读）。

用途：练习进度不再只躺在浏览器里 —— 开发者（或用户自己）可以随时把真实数据捞出来看：
谁练了多少、哪个知识点在推进、错因集中在哪、今天的题到底有没有落库。

零依赖（标准库 sqlite3）。

  python scripts/db.py                      # 总览
  python scripts/db.py accounts             # 账户列表
  python scripts/db.py objectives [--acct ID]
  python scripts/db.py errors               # 错因分布
  python scripts/db.py days                 # 每日练习
  python scripts/db.py questions            # 每道题的作答情况
  python scripts/db.py sessions             # 练习记录
  python scripts/db.py snapshots            # 存档快照
  python scripts/db.py attempts -n 30       # 最近作答事件
  python scripts/db.py sql "SELECT ..."     # 任意只读 SQL
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DB = HERE.parent.parent / "data" / "englishforge" / "englishforge.db"
DB_PATH = Path(os.environ.get("ENGLISHFORGE_DB") or DEFAULT_DB)


def connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        sys.exit(
            f"还没有数据库：{DB_PATH}\n"
            "启动一次应用（start.bat 或 npm run dev）并做一道题，这里就会自动生成。"
        )
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def table(rows, cols=None, empty="（无数据）") -> str:
    rows = list(rows)
    if not rows:
        return empty
    if cols is None:
        cols = list(rows[0].keys())
    out = []
    widths = [len(c) for c in cols]
    body = []
    for r in rows:
        line = []
        for i, c in enumerate(cols):
            v = r[c] if not isinstance(r, dict) else r.get(c)
            s = "" if v is None else str(v)
            line.append(s)
            widths[i] = max(widths[i], len(s))
        body.append(line)
    out.append("  ".join(c.ljust(widths[i]) for i, c in enumerate(cols)))
    out.append("  ".join("-" * w for w in widths))
    for line in body:
        out.append("  ".join(s.ljust(widths[i]) for i, s in enumerate(line)))
    return "\n".join(out)


def ts(v) -> str:
    if not v:
        return "—"
    return datetime.fromtimestamp(int(v) / 1000).strftime("%m-%d %H:%M")


def fmt_day(v) -> str:
    return str(v) if v else "—"


def pick_account(conn, acct: str | None) -> sqlite3.Row:
    rows = conn.execute("SELECT * FROM accounts ORDER BY created_at").fetchall()
    if not rows:
        sys.exit("数据库里还没有账户。")
    if acct:
        for r in rows:
            if r["id"] == acct or r["name"] == acct:
                return r
        sys.exit(f"找不到账户：{acct}")
    return rows[0]


# ---------------------------------------------------------------- 各子命令

def cmd_summary(conn, args):
    accts = conn.execute("SELECT * FROM accounts ORDER BY created_at").fetchall()
    print(f"数据库：{DB_PATH}")
    print(f"账户数：{len(accts)}")
    if not accts:
        print("\n（还没有账户：启动一次应用就会自动建立「默认账户」，并把浏览器里已有的进度搬进来。）")
        return
    for a in accts:
        meta = conn.execute("SELECT * FROM meta WHERE account_id = ?", (a["id"],)).fetchone()
        n_att = conn.execute("SELECT COUNT(*) FROM attempts WHERE account_id = ?", (a["id"],)).fetchone()[0]
        n_first = conn.execute(
            "SELECT COUNT(*) FROM attempts WHERE account_id = ? AND first_attempt = 1", (a["id"],)).fetchone()[0]
        n_ok = conn.execute(
            "SELECT COUNT(*) FROM attempts WHERE account_id = ? AND first_attempt = 1 AND outcome = 'correct'",
            (a["id"],)).fetchone()[0]
        n_q = conn.execute("SELECT COUNT(*) FROM question_states WHERE account_id = ? AND total > 0", (a["id"],)).fetchone()[0]
        n_rev = conn.execute("SELECT COUNT(*) FROM content_reviews WHERE account_id = ?", (a["id"],)).fetchone()[0]
        due = conn.execute(
            "SELECT COUNT(*) FROM question_states WHERE account_id = ? AND due_at <= ?",
            (a["id"], int(datetime.now().timestamp() * 1000))).fetchone()[0]
        active = conn.execute("SELECT 1 FROM active_sessions WHERE account_id = ?", (a["id"],)).fetchone()
        rate = f"{round(n_ok / n_first * 100)}%" if n_first else "—"
        print()
        print(f"── {a['name']}  ({a['id']})")
        print(f"   建库 {ts(a['created_at'])} · 最近活动 {ts(a['last_seen_at'])} · 状态版本 rev {meta['revision'] if meta else '—'}")
        print(f"   XP {meta['xp'] if meta else 0} · 连续 {meta['streak'] if meta else 0} 天 · 最近训练日 {fmt_day(meta['last_active_date'] if meta else '')}")
        print(f"   作答事件 {n_att} 条（首发 {n_first} · 首发答对 {n_ok} · 正确率 {rate}）")
        n_items = conn.execute("SELECT COUNT(*) FROM items WHERE account_id = ?", (a["id"],)).fetchone()[0]
        print(f"   练过的题 {n_q} 道 · 当前到期 {due} 道 · 审核标记 {n_rev} 条 · 未完成会话 {'有' if active else '无'}")
        print(f"   题库 {n_items} 道（账户内容，见 `items` 子命令）")
    print()
    print("提示：`python scripts/db.py objectives` 看知识点推进，`errors` 看错因，`sql \"...\"` 任意查询。")


def cmd_accounts(conn, args):
    print(table(conn.execute(
        """SELECT a.id, a.name, a.created_at, a.last_seen_at, COALESCE(m.xp,0) AS xp,
                  COALESCE(m.streak,0) AS streak, COALESCE(m.revision,0) AS rev,
                  (SELECT COUNT(*) FROM attempts t WHERE t.account_id = a.id) AS attempts
           FROM accounts a LEFT JOIN meta m ON m.account_id = a.id ORDER BY a.created_at"""
    ).fetchall(), ["id", "name", "created_at", "last_seen_at", "xp", "streak", "rev", "attempts"]))


def cmd_objectives(conn, args):
    acct = pick_account(conn, args.acct)
    rows = conn.execute(
        """SELECT objective_id, questions, attempts, first_attempts, first_correct, days, variant_groups,
                  CASE WHEN first_attempts > 0 THEN ROUND(first_correct * 100.0 / first_attempts) ELSE NULL END AS rate,
                  first_at, last_at
           FROM v_objective_stats WHERE account_id = ? ORDER BY attempts DESC""",
        (acct["id"],)).fetchall()
    out = []
    for r in rows:
        out.append({
            "知识点": r["objective_id"], "题数": r["questions"], "作答": r["attempts"],
            "首发": r["first_attempts"], "首发对": r["first_correct"],
            "正确率%": r["rate"] if r["rate"] is not None else "—",
            "跨天数": r["days"], "变式家族": r["variant_groups"],
            "首次": ts(r["first_at"]), "最近": ts(r["last_at"]),
        })
    print(f"账户：{acct['name']} · {len(out)} 个知识点")
    print(table(out))


def cmd_errors(conn, args):
    acct = pick_account(conn, args.acct)
    rows = conn.execute(
        "SELECT error_tags, COUNT(*) AS n FROM attempts WHERE account_id = ? AND error_tags IS NOT NULL GROUP BY error_tags",
        (acct["id"],)).fetchall()
    tally: dict[str, int] = {}
    for r in rows:
        try:
            for t in json.loads(r["error_tags"]):
                tally[t] = tally.get(t, 0) + r["n"]
        except (json.JSONDecodeError, TypeError):
            continue
    if not tally:
        print(f"账户：{acct['name']} · 还没有记录到错因（答错时才会写 optionTags）")
        return
    print(f"账户：{acct['name']} · 错因分布（按出现次数）")
    print(table([{"错因": k, "次数": v} for k, v in sorted(tally.items(), key=lambda x: (-x[1], x[0]))]))


def cmd_days(conn, args):
    acct = pick_account(conn, args.acct)
    rows = conn.execute(
        """SELECT d.local_date, d.attempts, d.first_correct, d.questions,
                  COALESCE(x.xp, 0) AS xp
           FROM v_daily d LEFT JOIN daily_xp x ON x.account_id = d.account_id AND x.local_date = d.local_date
           WHERE d.account_id = ? ORDER BY d.local_date DESC LIMIT ?""",
        (acct["id"], args.n)).fetchall()
    print(f"账户：{acct['name']} · 最近 {len(rows)} 个训练日")
    print(table([{
        "训练日": r["local_date"], "作答": r["attempts"], "首发答对": r["first_correct"],
        "涉及题目": r["questions"], "XP": r["xp"],
    } for r in rows]))


def cmd_questions(conn, args):
    acct = pick_account(conn, args.acct)
    rows = conn.execute(
        """SELECT question_id, objective_id, COUNT(*) AS attempts,
                  SUM(CASE WHEN first_attempt = 1 THEN 1 ELSE 0 END) AS firsts,
                  SUM(CASE WHEN first_attempt = 1 AND outcome = 'correct' THEN 1 ELSE 0 END) AS first_ok,
                  COUNT(DISTINCT local_date) AS days, MAX(timestamp) AS last_at
           FROM attempts WHERE account_id = ?
           GROUP BY question_id ORDER BY attempts DESC LIMIT ?""",
        (acct["id"], args.n)).fetchall()
    print(f"账户：{acct['name']} · 作答最多的 {len(rows)} 道题")
    print(table([{
        "题目": r["question_id"], "知识点": r["objective_id"], "作答": r["attempts"],
        "首发": r["firsts"], "首发对": r["first_ok"], "跨天数": r["days"], "最近": ts(r["last_at"]),
    } for r in rows]))


def cmd_sessions(conn, args):
    acct = pick_account(conn, args.acct)
    rows = conn.execute(
        "SELECT ts, label, lesson_no, total, first_try, acc, xp FROM practice_sessions WHERE account_id = ? ORDER BY ts DESC LIMIT ?",
        (acct["id"], args.n)).fetchall()
    print(f"账户：{acct['name']} · 最近 {len(rows)} 次练习")
    print(table([{
        "时间": ts(r["ts"]), "内容": r["label"], "任务": r["total"],
        "首发对": r["first_try"], "正确率%": r["acc"], "XP": r["xp"],
    } for r in rows]))


def cmd_snapshots(conn, args):
    acct = pick_account(conn, args.acct)
    rows = conn.execute(
        "SELECT id, created_at, reason, revision, LENGTH(payload) AS bytes FROM snapshots WHERE account_id = ? ORDER BY id DESC",
        (acct["id"],)).fetchall()
    print(f"账户：{acct['name']} · {len(rows)} 份快照（导入 / 清空 / 手动前自动留存）")
    print(table([{
        "id": r["id"], "时间": ts(r["created_at"]), "原因": r["reason"],
        "rev": r["revision"], "大小KB": round(r["bytes"] / 1024),
    } for r in rows]))


def cmd_attempts(conn, args):
    acct = pick_account(conn, args.acct)
    sql = "SELECT * FROM attempts WHERE account_id = ?"
    params: list = [acct["id"]]
    if args.objective:
        sql += " AND objective_id = ?"
        params.append(args.objective)
    sql += " ORDER BY timestamp DESC LIMIT ?"
    params.append(args.n)
    rows = conn.execute(sql, params).fetchall()
    print(f"账户：{acct['name']} · 最近 {len(rows)} 条作答事件")
    print(table([{
        "时间": ts(r["timestamp"]), "题目": r["question_id"], "首发": "是" if r["first_attempt"] else "重试",
        "结果": r["outcome"], "作答": (r["answer"] or "")[:24], "错因": r["error_tags"] or "",
        "间隔复习": "是" if r["is_due_review"] else "",
    } for r in rows]))


def cmd_sql(conn, args):
    sql = args.query.strip()
    if not sql.lower().startswith(("select", "with", "pragma", "explain")):
        sys.exit("只允许只读查询（select / with / pragma / explain）。")
    try:
        rows = conn.execute(sql).fetchall()
    except sqlite3.Error as e:
        sys.exit(f"SQL 出错：{e}")
    print(table(rows))
    print(f"\n（{len(rows)} 行）")


def cmd_items(conn, args):
    acct = pick_account(conn, args.acct)
    where = "account_id = ?"
    params: list = [acct["id"]]
    if args.skill:
        where += " AND skill = ?"
        params.append(args.skill)
    rows = conn.execute(
        f"""SELECT skill, source, review_status, COUNT(*) AS n, MIN(source_ref) AS sample
            FROM items WHERE {where} GROUP BY skill, source, review_status
            ORDER BY skill, source, review_status""", params).fetchall()
    total = conn.execute(f"SELECT COUNT(*) FROM items WHERE {where}", params).fetchone()[0]
    print(f"账户：{acct['name']} · 题库共 {total} 道")
    if not rows:
        print("（题库是空的：用 `python scripts/push-items.py` 把 out/ 里生成的题导进账户）")
        return
    print(table([{
        "思维点": r["skill"], "来源": r["source"], "信任级别": r["review_status"],
        "题数": r["n"], "示例出处": r["sample"] or "",
    } for r in rows]))
    print("\n信任级别：reviewed=计入掌握度 / draft=可练不认证 / quarantined=退出抽题")


def cmd_batches(conn, args):
    acct = pick_account(conn, args.acct)
    rows = conn.execute(
        "SELECT id, created_at, skill, source, generator, note, item_count FROM item_batches "
        "WHERE account_id = ? ORDER BY created_at DESC LIMIT ?", (acct["id"], args.n)).fetchall()
    print(f"账户：{acct['name']} · 题库批次（每导一次/生成一次留一条，便于对照）")
    print(table([{
        "批次": r["id"], "时间": ts(r["created_at"]), "思维点": r["skill"] or "",
        "来源": r["source"], "生成方式": r["generator"] or "", "题数": r["item_count"], "备注": r["note"] or "",
    } for r in rows]))


def cmd_schema(conn, args):
    rows = conn.execute(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").fetchall()
    for r in rows:
        print(f"{r['type']:<6} {r['name']}")
    print("\n表：accounts / meta / skill_progress / question_states / attempts / practice_sessions /")
    print("    daily_xp / active_sessions / content_reviews / snapshots / run_log")
    print("视图：v_objective_stats（按知识点聚合）/ v_daily（按训练日聚合）")


def cmd_log(conn, args):
    """后台维护日志：流水线/补纠正每次自动执行的留痕。出问题从这里查起。"""
    n = max(1, min(200, args.n))
    rows = conn.execute(
        "SELECT kind, summary, error, created_at FROM run_log ORDER BY id DESC LIMIT ?", (n,)).fetchall()
    if not rows:
        print("还没有后台维护日志（流水线/补纠正跑过之后这里就有）。")
        return
    for kind, summary, error, ts in rows:
        t = datetime.fromtimestamp(ts / 1000).strftime("%m-%d %H:%M:%S")
        s = json.loads(summary) if summary else {}
        if kind == "pipeline":
            line = (f"审 {s.get('reviewed', 0)} · 毙 {s.get('killed', 0)} · 改写 {s.get('rewritten', 0)}"
                    f" · 还剩 {s.get('pending', '?')} · {s.get('reviewer', '?')} · {s.get('ms', 0) / 1000:.1f}s")
            print(f"[{t}] 流水线  {line}")
            if s.get("killedIds"):
                print(f"    毙掉: {', '.join(s['killedIds'])}")
            if s.get("rewrittenIds"):
                print(f"    改写: {', '.join(s['rewrittenIds'])}")
        elif kind == "enrich":
            line = (f"补 {s.get('enriched', 0)} · 丢弃 {s.get('rejected', 0)}（宁缺勿错）"
                    f" · 还剩 {s.get('remaining', '?')} · {s.get('model', '?')} · {s.get('ms', 0) / 1000:.1f}s")
            print(f"[{t}] 补纠正  {line}")
        else:
            print(f"[{t}] {kind}  {json.dumps(s, ensure_ascii=False)[:120]}")
        if error:
            print(f"    出错: {error}")


def main():
    p = argparse.ArgumentParser(description="EnglishForge 进度数据库查询（只读）")
    p.add_argument("cmd", nargs="?", default="summary",
                   choices=["summary", "accounts", "objectives", "errors", "days", "questions",
                            "sessions", "snapshots", "attempts", "items", "batches", "log", "schema", "sql"])
    p.add_argument("query", nargs="?", help="sql 子命令的 SQL")
    p.add_argument("--acct", help="账户 id 或名称（默认第一个）")
    p.add_argument("-n", type=int, default=20, help="限制行数（默认 20）")
    p.add_argument("--objective", help="attempts 子命令：只看某个知识点")
    p.add_argument("--skill", help="items 子命令：只看某个思维点（s2/s3/s4）")
    args = p.parse_args()

    conn = connect()
    try:
        {
            "summary": cmd_summary, "accounts": cmd_accounts, "objectives": cmd_objectives,
            "errors": cmd_errors, "days": cmd_days, "questions": cmd_questions,
            "sessions": cmd_sessions, "snapshots": cmd_snapshots, "attempts": cmd_attempts,
            "items": cmd_items, "batches": cmd_batches, "log": cmd_log,
            "schema": cmd_schema, "sql": cmd_sql,
        }[args.cmd](conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
