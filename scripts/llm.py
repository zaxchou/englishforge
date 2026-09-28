#!/usr/bin/env python3
"""零依赖 DeepSeek 客户端 —— 沿用 molin-wiki 项目的接口约定。

约定来源：`molin-wiki/backend/app/llm/{providers,client}.py`
  · POST {base_url}/chat/completions
  · Authorization: Bearer <key>
  · body 带 `thinking: {"type": "disabled"}`（推理模型关思考，防 max_tokens 被 reasoning 吃光）
  · 仅 429/5xx/网络错误指数退避重试；4xx 立即失败

**密钥不复制、不落库**：按优先级从下面三处读，第一处命中即用。
  1) 环境变量 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_TEXT_MODEL
  2) <zcode>/molin-wiki/backend/.env          （原地读，避免多一份密钥副本）
  3) <zcode>/vgallery/.env.local
本仓库是公开仓库：**任何情况下都不要把密钥写进仓库内文件。**

自检：python scripts/llm.py --check
"""
from __future__ import annotations

import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

RETRYABLE = {429, 500, 502, 503, 504}
DEFAULT_TIMEOUT = 120.0
ROOT = Path(__file__).resolve().parents[2]          # .../JunEnglish
ZCODE = ROOT.parent                                  # .../zcode

SOURCES = [
    (ZCODE / 'molin-wiki' / 'backend' / '.env', 'DEEPSEEK'),
    (ZCODE / 'vgallery' / '.env.local', 'DEEPSEEK'),
]


class LLMError(RuntimeError):
    pass


def _read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    text = path.read_text(encoding='utf-8', errors='replace')
    return {k: v.strip().strip('"').strip("'")
            for k, v in re.findall(r'^([A-Z0-9_]+)\s*=\s*(.*)$', text, re.M)}


def config() -> dict[str, str]:
    """解析出 (api_key, base_url, model)。"""
    for var in ('DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_TEXT_MODEL'):
        if os.environ.get(var):
            pass
    key = os.environ.get('DEEPSEEK_API_KEY', '')
    base = os.environ.get('DEEPSEEK_BASE_URL', '')
    model = os.environ.get('DEEPSEEK_TEXT_MODEL', '')
    if not (key and base and model):
        for path, _prefix in SOURCES:
            kv = _read_env_file(path)
            key = key or kv.get('DEEPSEEK_API_KEY', '')
            base = base or kv.get('DEEPSEEK_BASE_URL', '')
            model = model or kv.get('DEEPSEEK_TEXT_MODEL', '')
            if key and base and model:
                break
    if not (key and base and model):
        raise LLMError('未找到 DEEPSEEK_API_KEY / BASE_URL / TEXT_MODEL：'
                       '请设环境变量，或确认 molin-wiki/backend/.env 存在')
    return {'api_key': key, 'base_url': base.rstrip('/'), 'model': model}


def _backoff(attempt: int) -> float:
    return 0.5 * (2 ** attempt) + random.uniform(0, 0.25)


def chat(messages: list[dict[str, str]], *, model: str | None = None,
         max_tokens: int = 2000, temperature: float = 0.1,
         retries: int = 2, timeout: float = DEFAULT_TIMEOUT) -> str:
    """一次 Chat Completions，返回 message.content。"""
    cfg = config()
    body = {
        'model': model or cfg['model'],
        'messages': messages,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'thinking': {'type': 'disabled'},
    }
    req = urllib.request.Request(
        cfg['base_url'] + '/chat/completions',
        data=json.dumps(body).encode('utf-8'), method='POST',
        headers={'Authorization': f"Bearer {cfg['api_key']}",
                 'Content-Type': 'application/json'})

    last = 'unknown'
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode('utf-8'))
            return data['choices'][0]['message']['content']
        except urllib.error.HTTPError as e:
            last = f'HTTP {e.code}: {e.read().decode("utf-8", "replace")[:200]}'
            if e.code not in RETRYABLE:
                break                      # 4xx 鉴权/参数错误不重试
        except Exception as e:              # noqa: BLE001 网络类错误
            last = f'{type(e).__name__}: {str(e)[:200]}'
        if attempt < retries:
            time.sleep(_backoff(attempt))
    raise LLMError(f'LLM 调用失败（{model or cfg["model"]}）: {last}')


def parse_json_loose(text: str) -> Any:
    """从模型输出里取 JSON：容忍 ```json 围栏与前后缀文字。"""
    if not text:
        raise ValueError('empty text')
    t = text.strip()
    if t.startswith('```'):
        t = t.strip('`')
        if t.lower().startswith('json'):
            t = t[4:]
    start = min([i for i in (t.find('{'), t.find('[')) if i != -1], default=-1)
    if start == -1:
        raise ValueError('no JSON found: ' + text[:200])
    end = max(t.rfind('}'), t.rfind(']'))
    return json.loads(t[start:end + 1])


def chat_json(messages: list[dict[str, str]], **kw: Any) -> Any:
    return parse_json_loose(chat(messages, **kw))


def main() -> int:
    if '--check' not in sys.argv:
        print(__doc__)
        return 0
    cfg = config()
    print(f"base_url={cfg['base_url']}  model={cfg['model']}  "
          f"key={cfg['api_key'][:7]}…(len={len(cfg['api_key'])})")
    out = chat([{'role': 'user', 'content': 'Reply with JSON only: {"ok":true}'}], max_tokens=20)
    print('响应:', out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
