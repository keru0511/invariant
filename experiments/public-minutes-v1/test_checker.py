"""Hand-authored mechanics fixtures only: not trial answers or accuracy evidence."""
import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path
from checker import check

CASE = {'source_id': 'mechanics', 'case_id': 'UNIT', 'paragraphs': [
    {'paragraph_id': 'P1', 'text': '担当班が案を作ります。'},
    {'paragraph_id': 'P2', 'text': '来月を目標とします。'},
    {'paragraph_id': 'P3', 'text': 'いったん保留します。'}]}

def evidence(pid='P1', quote='担当班が案を作ります。'):
    return [{'paragraph_id': pid, 'quote': quote}]


def fixture():
    return {'source_id': 'mechanics', 'case_id': 'UNIT', 'candidates': [{
        'candidate_id': 'C1', 'action': '案を作成', 'evidence': evidence(),
        'events': [{'type': 'acceptance', 'evidence': evidence()}],
        'final_status': 'committed',
        'owner': {'value': '担当班', 'basis': 'accepted_self', 'evidence': evidence()},
        'deadline': {'raw_text': None, 'normalized_date': None, 'basis': 'unstated',
                     'modality': 'unspecified', 'evidence': []},
        'uncertainty': []}]}


class CheckerTest(unittest.TestCase):
    def run_change(self, change):
        answer = fixture()
        change(answer['candidates'][0])
        return check(CASE, answer)

    def assert_rule(self, rule, change):
        result = self.run_change(change)
        self.assertIn(rule, [e['rule_id'] for e in result['errors']])
        self.assertFalse(result['checker_pass'])

    def test_positive_and_pure(self):
        answer = fixture()
        original = copy.deepcopy(answer)
        result = check(CASE, answer)
        self.assertTrue(result['checker_pass'], result)
        self.assertFalse(result['semantic_guarantee'])
        self.assertEqual(answer, original)
        self.assertEqual(result, check(CASE, answer))

    def test_no_literal_action_matching(self):
        self.assertTrue(self.run_change(lambda c: c.update(action='候補の意味は機械検査できない'))['checker_pass'])

    def test_exact_evidence_and_ids(self):
        self.assert_rule('quote_absent', lambda c: c.update(evidence=evidence(quote='担当班は案を作ります。')))
        self.assert_rule('unknown_paragraph', lambda c: c.update(evidence=evidence(pid='P9')))
        self.assert_rule('empty_evidence', lambda c: c.update(evidence=[]))
        self.assert_rule('schema', lambda c: c.update(extra=True))
        self.assert_rule('schema', lambda c: c['events'][0].update(type='invented'))

    def test_unknown_identity_and_duplicate(self):
        answer = fixture()
        answer['case_id'] = 'wrong'
        answer['candidates'].append(copy.deepcopy(answer['candidates'][0]))
        rules = [x['rule_id'] for x in check(CASE, answer)['errors']]
        self.assertIn('case_identity', rules)
        self.assertIn('duplicate_id', rules)

    def test_owner(self):
        self.assert_rule('owner_null', lambda c: c['owner'].update(basis='unstated'))
        self.assert_rule('owner_name_absent', lambda c: c['owner'].update(value='別班'))
        self.assertTrue(self.run_change(lambda c: c['events'][0].update(type='decision'))['checker_pass'])
        result = self.run_change(lambda c: c['owner'].update(basis='merely_addressed'))
        self.assertTrue(result['checker_pass'])
        self.assertIn('addressee_not_owner', [w['rule_id'] for w in result['warnings']])

    def test_deadline(self):
        self.assert_rule('deadline_normalization', lambda c: c['deadline'].update(normalized_date='2026-01-01'))
        self.assert_rule('deadline_null', lambda c: c['deadline'].update(raw_text='来月'))
        self.assert_rule('empty_evidence', lambda c: c['deadline'].update(raw_text='来月', basis='explicit_relative'))
        def target(c):
            c['deadline'].update(raw_text='来月を目標', basis='explicit_relative', modality='target',
                                 evidence=evidence('P2', '来月を目標とします。'))
        result = self.run_change(target)
        self.assertTrue(result['checker_pass'], result)
        self.assertIn('target_not_deadline', [w['rule_id'] for w in result['warnings']])

    def test_state_and_order(self):
        self.assert_rule('declared_state', lambda c: c.update(final_status='withdrawn'))
        def add_hold(c):
            c['events'].append({'type': 'hold', 'evidence': evidence('P3', 'いったん保留します。')})
            c['final_status'] = 'on_hold'
        self.assertTrue(self.run_change(add_hold)['checker_pass'])
        def reverse(c):
            add_hold(c)
            c['events'].reverse()
        self.assert_rule('event_order', reverse)
        def request_after(c):
            c['events'].append({'type': 'request', 'evidence': evidence('P3', 'いったん保留します。')})
        result = self.run_change(request_after)
        self.assertTrue(result['checker_pass'])  # Incorrect semantic labels cannot be caught.
        self.assertIn('later_proposal_request', [w['rule_id'] for w in result['warnings']])
        self.assertTrue(self.run_change(lambda c: c.update(final_status='unresolved', uncertainty=['対象対応不明']))['checker_pass'])

    def test_ambiguous_quote(self):
        case = copy.deepcopy(CASE)
        case['paragraphs'][0]['text'] *= 2
        self.assertIn('quote_ambiguous', [e['rule_id'] for e in check(case, fixture())['errors']])

    def test_bad_types_never_crash(self):
        for field in fixture()['candidates'][0]:
            for value in (None, 1, True, [], {}):
                self.run_change(lambda c: c.update({field: value}))
        for field in ('value', 'basis', 'evidence'):
            self.run_change(lambda c: c['owner'].update({field: []}))
        for field in ('raw_text', 'basis', 'modality', 'evidence'):
            self.run_change(lambda c: c['deadline'].update({field: []}))

    def test_only_newlines_are_normalized(self):
        case = copy.deepcopy(CASE)
        case['paragraphs'][0]['text'] += '\n続き'
        answer = fixture()
        answer['candidates'][0]['evidence'] = evidence(quote='担当班が案を作ります。\r\n続き')
        self.assertTrue(check(case, answer)['checker_pass'])
        answer['candidates'][0]['evidence'] = evidence(quote='担当班が案を作ります。 続き')
        self.assertFalse(check(case, answer)['checker_pass'])

    def test_cli(self):
        process = subprocess.run([sys.executable, str(Path(__file__).with_name('checker.py'))],
                                 input=json.dumps({'case': CASE, 'extraction': fixture()}),
                                 text=True, capture_output=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertTrue(json.loads(process.stdout)['checker_pass'])


if __name__ == '__main__':
    unittest.main()
