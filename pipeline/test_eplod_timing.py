"""已复核时间轴必须在重建后保留，来源变化须拒绝，不能半写入。"""
import copy
import hashlib
import json
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PIPELINE = Path(__file__).resolve().parent
B = runpy.run_path(str(PIPELINE / "build_eplod.py"))
apply = B["apply_timing_overrides"]


class TimingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.audio = self.root / "dg.mp3"
        self.audio.write_bytes(b"synthetic audio")
        self.data = {
            "ep": 9999, "durations": {"dg": 8},
            "dialogue": [{"spk": "A", "text": "First synthetic line.", "t0": None, "t1": None},
                         {"spk": "B", "text": "Second synthetic line.", "t0": 5, "t1": 5.2}],
            "sentencesZh": ["first", "second"], "chunks": [{"qi": 1}],
            "explanation": [{"t0": 1, "t1": 2}],
        }
        self.entry = {
            "audioSha256": hashlib.sha256(self.audio.read_bytes()).hexdigest(),
            "dialogueSha256": hashlib.sha256("\n".join(x["text"] for x in self.data["dialogue"]).encode()).hexdigest(),
            "bounds": [[1, 3.1], [3, 6]],
        }
        self.rules = self.root / "timing.json"
        self.save_rules()

    def save_rules(self):
        self.rules.write_text(json.dumps({"version": 1, "episodes": {"9999": self.entry}}), encoding="utf-8")

    def test_rebuild_reapplies_all_bounds_without_changing_content(self):
        before = copy.deepcopy(self.data)
        self.assertEqual(apply(self.data, self.audio, self.rules), 2)
        expected = copy.deepcopy(before)
        for line, pair in zip(expected["dialogue"], self.entry["bounds"]):
            line["t0"], line["t1"] = pair
        self.assertEqual(self.data, expected)
        self.assertEqual(apply(self.data, self.audio, self.rules), 2)
        self.assertEqual(self.data, expected)

    def test_changed_audio_rejected_before_any_mutation(self):
        self.audio.write_bytes(b"replacement audio")
        before = copy.deepcopy(self.data)
        with self.assertRaisesRegex(ValueError, "原文或音频"):
            apply(self.data, self.audio, self.rules)
        self.assertEqual(self.data, before)

    def test_changed_text_or_order_rejected(self):
        for change in (lambda d: d[0].update(text="Changed"), lambda d: d.reverse()):
            data = copy.deepcopy(self.data)
            change(data["dialogue"])
            before = copy.deepcopy(data)
            with self.assertRaisesRegex(ValueError, "原文或音频"):
                apply(data, self.audio, self.rules)
            self.assertEqual(data, before)

    def test_invalid_later_bound_rejected_without_partial_write(self):
        for pair in ([2.8, 6], [3, 9], [3, 3], [-1, 6], [True, 6], [float("nan"), 6], [3], [3, float("inf")]):
            with self.subTest(pair=pair):
                self.entry["bounds"][1] = pair
                self.save_rules()
                before = copy.deepcopy(self.data)
                with self.assertRaises(ValueError):
                    apply(self.data, self.audio, self.rules)
                self.assertEqual(self.data, before)

    def test_sentence_count_mismatch_rejected(self):
        self.entry["bounds"].pop()
        self.save_rules()
        with self.assertRaisesRegex(ValueError, "句数"):
            apply(self.data, self.audio, self.rules)

    def test_other_episode_does_not_touch_audio_or_data(self):
        self.data["ep"] = 9998
        before = copy.deepcopy(self.data)
        self.assertEqual(apply(self.data, self.root / "missing.mp3", self.rules), 0)
        self.assertEqual(self.data, before)

    def test_heuristic_does_not_replace_reviewed_speaker_boundaries(self):
        # 复制修复器到隔离目录，使用合成音频指纹，不读取任何真实教材。
        tool = self.root / "fix_eplod_anchors.mjs"
        tool.write_bytes((PIPELINE / tool.name).read_bytes())
        (self.root / "eplod-timing-overrides.json").write_bytes(self.rules.read_bytes())
        build = self.root / "project" / "build"
        episode_dir = build / "eplod"
        episode_dir.mkdir(parents=True)
        audio = self.root / "EnglishPod音频库" / "9999" / "dg.mp3"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(self.audio.read_bytes())
        apply(self.data, self.audio, self.rules)
        episode = episode_dir / "9999.json"
        episode.write_text(json.dumps(self.data), encoding="utf-8")
        before = episode.read_bytes()
        result = subprocess.run(["node", str(tool), str(build)], capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(episode.read_bytes(), before)
        self.data["dialogue"][0]["t0"] = 1.2
        episode.write_text(json.dumps(self.data), encoding="utf-8")
        changed = episode.read_bytes()
        result = subprocess.run(["node", str(tool), str(build)], capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertEqual(episode.read_bytes(), changed)

    def test_generator_uses_reviewed_bounds_before_writing(self):
        # 真实 run_episode 主体，替换文件解析和 ASR，验证不是只测独立帮助函数。
        source = self.root / "source"
        source.mkdir()
        for name in ("x.pdf", "xdg.mp3", "xpb.mp3", "xrv.mp3"):
            (source / name).write_bytes(self.audio.read_bytes())
        data = copy.deepcopy(self.data)
        data.update(level="Synthetic", title="Synthetic", code="X9999", keyvocab=[], suppvocab=[])
        duration = lambda _: 8
        segs = [{"text": "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen", "t0": 0, "t1": 20}]
        def reviewed(d, audio):
            return apply(d, audio, self.rules)
        def recognize(audio, **kwargs):
            if audio.name.endswith("dg.mp3"):
                raise AssertionError("Reviewed dialogue must not depend on ASR succeeding again")
            return segs
        replacements = {
            "AUDIO_LIB": self.root / "playback",
            "find_ep_dir": lambda _: source, "parse_pdf": lambda _: copy.deepcopy(data),
            "apply_errata": lambda _: None, "load_txt": lambda _: [{"spk": "", "text": "Synthetic explanation."}],
            "whisper_segments": recognize,
            "global_align": lambda lines, _: [[1, 2] for _ in lines],
            "build_units": lambda *a: [], "audio_urls": lambda _: {}, "ffprobe_sec": duration,
            "apply_timing_overrides": reviewed,
        }
        run = B["run_episode"]
        with patch.dict(run.__globals__, replacements):
            generated = run("9999", do_chunks=False, do_apply=False, keep_ai=False, log=lambda _: None)
        self.assertEqual([[x["t0"], x["t1"]] for x in generated["dialogue"]], self.entry["bounds"])
        playback = replacements["AUDIO_LIB"] / "9999" / "dg.mp3"
        playback.parent.mkdir(parents=True)
        playback.write_bytes(b"different playback copy")
        with patch.dict(run.__globals__, replacements):
            with self.assertRaisesRegex(ValueError, "播放音频"):
                run("9999", do_chunks=False, do_apply=True, keep_ai=False, log=lambda _: None)


if __name__ == "__main__":
    unittest.main()
