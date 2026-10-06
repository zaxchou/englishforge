# -*- coding: utf-8 -*-
"""逐字稿校对管线 (2026-10-06)
逐字稿(.doc 实为 docx) → 分块 AI 校对(英文词/词根对照讲义词表) → md + 词表清单 sidecar。
用法:
  python pipeline/proofread_scripts.py extract            # 抽取全部 .doc → raw txt (build/scripts-raw/)
  python pipeline/proofread_scripts.py run [--only NN]    # AI 校对全部(可单节) → 逐字稿/*.md + *.words.json
  python pipeline/proofread_scripts.py run --lesson 8
源素材只读原则: 只在 逐字稿/ 文件夹新增 .md/.words.json(用户明确要求), 不动 .doc 原件。
"""
import io, os, sys, json, re, zipfile, time, argparse

BASE = r'Z:\BaiduNetdiskWorkspace\myagent-work\zcode\JunEnglish'
COURSE_DIR = os.path.join(BASE, r'新D方\新D方新托福全套\01 托福词汇课 孙曦')
RAW_DIR = os.path.join(BASE, r'toefl-lab\build\scripts-raw')
HANDOUT = os.path.join(BASE, r'toefl-lab\build\courses\notes\ndf-01-h1.json')
API_BASE = os.environ.get('TFL_AI_BASE_URL', 'https://api.deepseek.com').rstrip('/')
API_KEY = os.environ.get('TFL_AI_KEY', '')
MODEL = os.environ.get('TFL_AI_MODEL', 'deepseek-chat')

def docx_text(path):
    """伪 .doc(实为 zip/docx) → 纯文本段落。"""
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8')
    xml = re.sub(r'</w:p>', '\n', xml)
    xml = re.sub(r'<[^>]+>', '', xml)
    return xml.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').strip()

def cmd_extract():
    os.makedirs(RAW_DIR, exist_ok=True)
    files = sorted(f for f in os.listdir(COURSE_DIR + '\\逐字稿') if f.lower().endswith('.doc'))
    for f in files:
        no = int(re.match(r'(\d+)', f).group(1))
        out = os.path.join(RAW_DIR, 'ndf-01-%02d.txt' % no)
        if os.path.exists(out):
            continue
        t = docx_text(os.path.join(COURSE_DIR, '逐字稿', f))
        io.open(out, 'w', encoding='utf-8').write(t)
        print(no, f, len(t), 'chars', flush=True)

def handout_text():
    d = json.load(io.open(HANDOUT, encoding='utf-8'))
    return '\n\n'.join('[第%d页]\n%s' % (p['page'], p['text']) for p in d['pages'] if (p.get('text') or '').strip())

def ai(messages, max_tokens=8000, timeout=300):
    import urllib.request
    key = os.environ.get('TFL_AI_KEY', '')
    base = os.environ.get('TFL_AI_BASE_URL', 'https://api.deepseek.com').rstrip('/')
    model = os.environ.get('TFL_AI_MODEL', 'deepseek-chat')
    body = json.dumps({'model': model, 'messages': messages, 'max_tokens': max_tokens,
                       'temperature': 0.2, 'stream': False}).encode('utf-8')
    req = urllib.request.Request(base + '/chat/completions', data=body,
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    last = None
    for attempt in range(4):   # 网络韧性: IncompleteRead/超时 重试
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                j = json.loads(r.read().decode('utf-8'))
            return j['choices'][0]['message']['content'].strip()
        except Exception as e:
            last = e
            print('  retry', attempt + 1, type(e).__name__, str(e)[:60], flush=True)
            time.sleep(5 + attempt * 5)
    raise last

def chunks(text, size=6000):
    paras = text.split('\n')
    out, cur = [], ''
    for p in paras:
        if len(cur) + len(p) > size and cur:
            out.append(cur.strip()); cur = ''
        cur += p + '\n'
    if cur.strip():
        out.append(cur.strip())
    return out

PROOF_SYS = (
    '你是字幕校对编辑。下面是一段托福词汇课的课堂逐字稿(语音转写)和课程讲义词表。'
    '任务：修正转写错误，输出校对后的讲稿。规则：\n'
    '1. 英文单词、词根、词缀是重点：语音同音错误必须纠正(如 projection→production、pronouns→pronounce、'
    '被听成单个字母的词缀如 e→-er，结合上下文与讲义词表判断)。讲义里出现的词是权威拼写。\n'
    '2. 中文口语保持原味，只修明显的转写错字；老师的口语风格、重复、语气词保留，不要润色改写。\n'
    '3. 删除纯转写垃圾(如"of不了不了"这类无意义音节碎片)，若上下文能判断原词则改正。\n'
    '4. 内容顺序不变，不增删知识点。若某英文词实在无法判断原词，保留原样并在其后标注〔?〕。\n'
    '5. 输出纯文本讲稿本身(可按话题加少量 ## 小标题)，不要任何说明、前后缀或代码块标记。'
)

INV_SYS = (
    '从这段托福词汇课逐字稿中，提取本节课"教到"的全部语言点清单。只统计老师明确讲解/列举的，'
    '顺口带过未讲解的不算。输出严格 JSON：{"words":["单词(纠错后拼写)"],"affixes":["-er","de-"等带方向写法],"roots":["ceive"等],"phrases":["重要搭配"]}'
    '。不要输出 JSON 之外的任何内容。'
)

def cmd_run(only=None, force=False):
    if not os.environ.get('TFL_AI_KEY'):
        load_env_local()
    assert os.environ.get('TFL_AI_KEY'), '需要 TFL_AI_KEY 环境变量(.env.local)'
    hand = handout_text()
    files = sorted(f for f in os.listdir(COURSE_DIR + '\\逐字稿') if f.lower().endswith('.doc'))
    for f in files:
        no = int(re.match(r'(\d+)', f).group(1))
        if only and no != only:
            continue
        stem = 'ndf-01-%02d' % no
        md_path = os.path.join(COURSE_DIR, '逐字稿', f.rsplit('.', 1)[0] + '.md')
        inv_path = os.path.join(COURSE_DIR, '逐字稿', stem + '.words.json')
        if not force and os.path.exists(md_path) and os.path.exists(inv_path):
            print(stem, 'skip(已存在)', flush=True)
            continue
        raw = io.open(os.path.join(RAW_DIR, stem + '.txt'), encoding='utf-8').read()
        t0 = time.time()
        # 校对(分块, 防输出截断)
        parts = []
        for i, ck in enumerate(chunks(raw)):
            user = '[课程讲义词表(权威拼写来源)]\n%s\n\n[逐字稿第 %d/%d 段]\n%s' % (hand, i + 1, len(chunks(raw)), ck)
            parts.append(ai([{'role': 'system', 'content': PROOF_SYS}, {'role': 'user', 'content': user}]))
            time.sleep(1)
        md = ('\n\n'.join(parts)).strip()
        md = re.sub(r'^```.*\n|```$', '', md, flags=re.M).strip()
        head = '---\nlesson: %s\ntitle: %s\nsource: 逐字稿 AI 校对(对照讲义词表)\n---\n\n' % (stem, f.rsplit('.', 1)[0])
        io.open(md_path, 'w', encoding='utf-8').write(head + md + '\n')
        # 词表清单(覆盖检查用)
        inv_raw = ai([{'role': 'system', 'content': INV_SYS},
                      {'role': 'user', 'content': '[校对后讲稿]\n' + md[:24000]}], max_tokens=3000)
        m = re.search(r'\{[\s\S]*\}', inv_raw)
        inv = json.loads(m.group(0)) if m else {}
        inv = {k: sorted(set(v)) for k, v in inv.items() if isinstance(v, list)}
        inv.update({'lesson': stem, 'title': f.rsplit('.', 1)[0], 'at': int(time.time() * 1000)})
        io.open(inv_path, 'w', encoding='utf-8').write(json.dumps(inv, ensure_ascii=False, indent=1))
        print(stem, 'OK md', len(md), 'chars | words', len(inv.get('words', [])),
              'affixes', len(inv.get('affixes', [])), 'roots', len(inv.get('roots', [])),
              '| %.0fs' % (time.time() - t0), flush=True)

def load_env_local():
    p = os.path.join(BASE, r'toefl-lab\.env.local')
    if os.path.exists(p):
        for line in io.open(p, encoding='utf-8'):
            m = re.match(r'\s*([A-Z_]+)\s*=\s*(.+)', line)
            if m and not os.environ.get(m.group(1)):
                os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['extract', 'run'])
    ap.add_argument('--lesson', type=int, default=None)
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    if a.cmd == 'extract':
        cmd_extract()
    else:
        load_env_local()
        cmd_run(only=a.lesson, force=a.force)
