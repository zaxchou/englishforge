"""Offline regressions using the actual reviewed library. No service or record writes."""
import copy, hashlib, json, unittest
from pathlib import Path
from audit_generated_quizzes import audit, check, contains
BASE=Path(__file__).resolve().parents[1]/'docs/quiz-review-2026-10-07'
RAW=(BASE/'production-snapshot.json').read_bytes()
ITEMS=json.loads(RAW.decode('utf-8-sig'))['items']
def question(lesson,qid):
    return copy.deepcopy(next(q for q in ITEMS[f'ndf-01-{lesson:02}']['questions'] if q['id']==qid))
class AuditTests(unittest.TestCase):
    def test_all_questions_accounted_without_input_mutation(self):
        before=hashlib.sha256(RAW).hexdigest();r=audit(RAW)
        self.assertEqual(len(r['questions']),sum(len(v['questions']) for v in ITEMS.values()))
        self.assertEqual(before,r['inputSha256'])
        self.assertTrue(all(q['semanticStatus']=='not_certified' for q in r['questions']))
        self.assertEqual(hashlib.sha256((BASE/'production-snapshot.json').read_bytes()).hexdigest(),before)
    def test_chinese_definition_leak(self):
        self.assertIn('answer_text_in_stem_review',check(question(1,'q12'))[1])
    def test_preanswer_tag_leak(self):
        self.assertIn('preanswer_tag_equals_answer',check(question(2,'q23'))[1])
    def test_target_word_in_meaning_question_is_not_blanket_rejected(self):
        q=question(2,'q51');q['stem']='What does deceptive mean?'
        errors,flags=check(q);self.assertFalse(errors)
        self.assertNotIn('answer_text_in_stem_review',flags)
    def test_electric_charge_is_context_not_matching_substring_leak(self):
        self.assertNotIn('answer_text_in_stem_review',check(question(2,'q52'))[1])
        self.assertFalse(contains('deception','cept'))
    def test_taught_not_wrong_language_reason(self):
        self.assertIn('scope_as_wrong_reason_review',check(question(6,'q16'))[1])
    def test_to_ing(self):
        self.assertIn('to_ing_grammar_review',check(question(46,'q5'))[1])
    def test_exact_answer_key_not_first_character(self):
        q=question(2,'q1');q['answer']='C because'
        self.assertIn('answer_must_be_exact_ABCD',check(q)[0])
    def test_four_options_and_note_required(self):
        q=question(2,'q1');q['options']['E']={'t':'extra','note':'extra'}
        self.assertIn('exactly_four_ABCD_options_required',check(q)[0])
        q=question(2,'q1');q['options']['A']['note']=''
        self.assertIn('each_option_needs_note',check(q)[0])
    def test_unicode_duplicate(self):
        q=question(2,'q1');q['options']['A']['t']='ＳＡＦＥＴＹ'
        self.assertIn('duplicate_option_text',check(q)[0])
    def test_label_order_preserved(self):
        q=question(2,'q1');q['options']=dict(reversed(list(q['options'].items())))
        self.assertFalse(check(q)[0]);self.assertEqual(q['options'][q['answer']]['t'],'safety')
    def test_stale_review_cannot_certify_changed_question(self):
        fs=json.loads((BASE/'confirmed-findings.json').read_text(encoding='utf-8'))
        original=audit(RAW,fs);self.assertEqual(original['summary']['confirmedProblemQuestions'],len(fs))
        d=json.loads(RAW.decode('utf-8-sig'));d['items']['ndf-01-01']['questions'][10]['stem']='Changed'
        with self.assertRaisesRegex(ValueError,'Stale'):audit(json.dumps(d).encode(),fs)
if __name__=='__main__':unittest.main()
