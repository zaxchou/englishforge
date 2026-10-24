"""Regression tests: PDF entry boundaries and preserving scheduling keys."""
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import build_vocab as m

class Page:
    def __init__(self, text): self.text = text
    def get_text(self): return self.text
class Doc(list):
    def __enter__(self): return self
    def __exit__(self, *args): pass

def main():
    with tempfile.TemporaryDirectory() as tmp:
        fixture = Doc([Page('1\n第一课\ncross – We cross rivers.\n我们过河。\ncross ‑\ncountry –\nThe cross ‑\ncountry race ends.\n越野赛结束。\nreader\n–\nThe reader reads\n'), Page('2\nthe book.\n读者读书。\nreadiness – Ready now.\n准备好了。\nready‑ made –The meal is ready.\n饭好了。\nvis-à-vis – Compare these.\n比较两者。\nmystery heading\nUnknown stray English.\n')])
        with patch.object(m.pymupdf, 'open', return_value=fixture), patch.object(m, 'OUT', Path(tmp)/'bank.json'):
            result=m.parse_sentences()[1]
        assert result['cross']['zh']=='我们过河。'
        assert result['cross-country']['en']=='The cross-country race ends.'
        assert result['reader']['en']=='The reader reads the book.'
        assert result['reader']['zh']=='读者读书。'
        assert result['readiness']['zh']=='准备好了。'
        assert result['ready-made']['en']=='The meal is ready.'
        assert result['vis-à-vis']['en']=='' # stray English quarantines rather than contaminates
        assert json.loads((Path(tmp)/'sentence-parse-audit.json').read_text('utf-8'))['quarantine']
    bank=json.loads(m.OUT.read_text('utf-8'))
    cards={c['w'].lower().replace(' ',''):c for b in bank['batches'] for c in b['words']}
    assert len(cards)==13151
    for key in ['cross','crossbreed','crossroads','readiness']:
        assert cards[key]['sen'] and cards[key]['senZh']
        assert not m.SENT_HEAD.search(cards[key]['senZh'])
    print('PASS vocabulary content: compound/split headers, dash spacing, page continuation, unknown quarantine, 13151 compatible keys')

if __name__=='__main__': main()
