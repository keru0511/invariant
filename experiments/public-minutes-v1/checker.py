#!/usr/bin/env python3
"""Public deterministic consistency checks, not a semantic accuracy evaluator.

CLI: python checker.py < input.json
input.json contains {"case": PUBLIC_CASE, "extraction": MODEL_JSON}.
No oracle, network, model invocation, hidden task IDs, or trace writes.
"""
import json
import sys

EVENTS = {'proposal': 'proposed', 'request': 'requested',
          'acceptance': 'committed', 'decision': 'committed', 'hold': 'on_hold',
          'withdrawal': 'withdrawn', 'completion': 'completed', 'unclear': 'unresolved'}
OWNER_BASES = {'accepted_self', 'explicitly_assigned', 'merely_addressed', 'unstated', 'ambiguous'}
DEADLINE_BASES = {'explicit_absolute', 'explicit_relative', 'unstated', 'ambiguous'}


def normalize(text):
    return text.replace('\r\n', '\n').replace('\r', '\n')


def check(case, extraction):
    """Return deterministic diagnostics without modifying either input.

    Passing only establishes absence of implemented mechanical violations.
    Labels, same-action relations, omissions and semantic support remain unverified.
    """
    errors, warnings = [], []
    cid = None

    def emit(rule, path, message, warning=False):
        (warnings if warning else errors).append({
            'candidate_id': cid, 'rule_id': rule, 'severity': 'warning' if warning else 'error', 'path': path, 'message': message})

    def obj(value, keys, path):
        if not isinstance(value, dict):
            emit('schema', path, 'Expected object')
            return False
        if set(value) != set(keys):
            emit('schema', path, 'Required fields: ' + ', '.join(sorted(keys)) +
                 '; missing: ' + ', '.join(sorted(set(keys) - set(value))) +
                 '; unknown: ' + ', '.join(sorted(set(value) - set(keys))))
        return True

    def string(value, path, nullable=False):
        if nullable and value is None:
            return True
        if not isinstance(value, str) or not value.strip():
            emit('schema', path, 'Expected nonempty string' + (' or null' if nullable else ''))
            return False
        return True

    def enum(value, allowed, path):
        if not isinstance(value, str) or value not in allowed:
            emit('schema', path, 'Allowed values: ' + ', '.join(sorted(allowed)))
            return False
        return True

    paragraphs = {}
    if not isinstance(case, dict) or not isinstance(case.get('paragraphs'), list):
        emit('public_case', '$.case', 'Public case must contain ordered paragraphs')
    else:
        for index, paragraph in enumerate(case['paragraphs']):
            if (not isinstance(paragraph, dict) or
                not isinstance(paragraph.get('paragraph_id'), str) or
                not isinstance(paragraph.get('text'), str) or
                paragraph['paragraph_id'] in paragraphs):
                emit('public_case', '$.case.paragraphs', 'Invalid or duplicate paragraph')
            else:
                paragraphs[paragraph['paragraph_id']] = (index, normalize(paragraph['text']))

    def evidence(value, path, required=True):
        positions, quotes = [], []
        if not isinstance(value, list):
            emit('schema', path, 'Expected evidence array')
            return positions, quotes
        if required and not value:
            emit('empty_evidence', path, 'Claim requires nonempty evidence')
        for i, ev in enumerate(value):
            p = f'{path}[{i}]'
            if not obj(ev, {'paragraph_id', 'quote'}, p):
                continue
            pid, quote = ev.get('paragraph_id'), ev.get('quote')
            valid_pid = string(pid, p + '.paragraph_id')
            valid_quote = string(quote, p + '.quote')
            if not valid_pid or not valid_quote:
                continue
            if pid not in paragraphs:
                emit('unknown_paragraph', p, 'Unknown paragraph_id: ' + pid)
                continue
            index, text = paragraphs[pid]
            quote = normalize(quote)
            # Only CRLF/CR -> LF normalization; no fuzzy/semantic matching.
            starts = [j for j in range(len(text)) if text.startswith(quote, j)]
            if not starts:
                emit('quote_absent', p, 'Quote does not occur exactly in named paragraph')
            elif len(starts) != 1:
                emit('quote_ambiguous', p, 'Quote has multiple positions; use a longer unique quote')
            else:
                positions.append((index, starts[0], starts[0] + len(quote)))
                quotes.append(quote)
        return positions, quotes

    if not obj(extraction, {'source_id', 'case_id', 'candidates'}, '$.extraction'):
        return {'checker_pass': False, 'errors': errors, 'warnings': warnings,
                'semantic_guarantee': False}
    for field in ('source_id', 'case_id'):
        string(extraction.get(field), '$.' + field)
        if not isinstance(case, dict) or extraction.get(field) != case.get(field):
            emit('case_identity', '$.' + field, 'Identifier differs from public case')
    candidates = extraction.get('candidates')
    if not isinstance(candidates, list):
        emit('schema', '$.candidates', 'Expected array')
        candidates = []
    seen, spans = set(), []
    for i, candidate in enumerate(candidates):
        path = f'$.candidates[{i}]'
        cid = candidate.get('candidate_id') if isinstance(candidate, dict) else None
        if not obj(candidate, {'candidate_id', 'action', 'evidence', 'events',
                              'final_status', 'owner', 'deadline', 'uncertainty'}, path):
            continue
        if string(cid, path + '.candidate_id'):
            if cid in seen:
                emit('duplicate_id', path + '.candidate_id', 'Duplicate candidate_id')
            seen.add(cid)
        string(candidate.get('action'), path + '.action')
        action_positions, _ = evidence(candidate.get('evidence'), path + '.evidence')
        spans.append((cid, action_positions))
        enum(candidate.get('final_status'), set(EVENTS.values()), path + '.final_status')
        uncertainty = candidate.get('uncertainty')
        if not isinstance(uncertainty, list):
            emit('schema', path + '.uncertainty', 'Expected string array')
        else:
            for j, item in enumerate(uncertainty):
                string(item, f'{path}.uncertainty[{j}]')
        if candidate.get('final_status') == 'unresolved' and not uncertainty:
            emit('uncertainty_missing', path + '.uncertainty', 'Unresolved requires a reason')
        events = candidate.get('events')
        declared, last_position = [], None
        if not isinstance(events, list) or not events:
            emit('schema', path + '.events', 'Expected nonempty events array')
            events = []
        for j, event in enumerate(events):
            ep = f'{path}.events[{j}]'
            if not obj(event, {'type', 'evidence'}, ep):
                continue
            if enum(event.get('type'), set(EVENTS), ep + '.type'):
                declared.append(event['type'])
            positions, _ = evidence(event.get('evidence'), ep + '.evidence')
            if positions:
                position = min(positions)
                if last_position is not None and position[:2] < last_position[:2]:
                    emit('event_order', ep, 'Event evidence order contradicts paragraph/offset order')
                last_position = max(positions)
        state = None
        for event_type in declared:
            if event_type == 'unclear':
                if candidate.get('final_status') != 'unresolved' and not uncertainty:
                    emit('uncertainty_missing', path + '.uncertainty', 'Unclear event requires unresolved status or a specific reason')
            elif event_type in ('proposal', 'request') and state in ('committed', 'on_hold', 'withdrawn', 'completed'):
                emit('later_proposal_request', path + '.events', 'Later proposal/request does not automatically overwrite an established state; review same-action relation', True)
            else:
                if event_type in ('acceptance', 'decision') and state in ('on_hold', 'withdrawn', 'completed'):
                    emit('possible_restart', path + '.events', 'Later acceptance/decision may restart the action; verify same-action relation', True)
                if not (event_type == 'proposal' and state == 'requested'):
                    state = EVENTS[event_type]
        unresolved_with_reason = candidate.get('final_status') == 'unresolved' and bool(uncertainty)
        if state and candidate.get('final_status') != state and not unresolved_with_reason:
            emit('declared_state', path + '.final_status',
                 'Final status contradicts declared event state ' + state +
                 '; this checks labels, not their semantic truth')
        owner = candidate.get('owner')
        if obj(owner, {'value', 'basis', 'evidence'}, path + '.owner'):
            value, basis = owner.get('value'), owner.get('basis')
            string(value, path + '.owner.value', nullable=True)
            enum(basis, OWNER_BASES, path + '.owner.basis')
            positions, quotes = evidence(owner.get('evidence'), path + '.owner.evidence',
                                         required=value is not None or basis != 'unstated')
            if basis == 'unstated' and (value is not None or owner.get('evidence') != []):
                emit('owner_null', path + '.owner', 'Unstated owner requires null value and empty evidence')
            if basis in ('accepted_self', 'explicitly_assigned', 'merely_addressed') and value is None:
                emit('owner_null', path + '.owner', 'Declared named-owner basis requires value')
            if isinstance(value, str) and not any(normalize(value) in q for q in quotes):
                emit('owner_name_absent', path + '.owner', 'Owner value must occur exactly in owner evidence')
            if basis == 'accepted_self' and not any(t in declared for t in ('acceptance', 'decision')):
                emit('owner_acceptance', path + '.owner', 'Accepted-self basis without acceptance/decision may confuse request with accepted responsibility', True)
            if basis == 'merely_addressed' and candidate.get('final_status') == 'committed':
                emit('addressee_not_owner', path + '.owner',
                     'Named addressee is not an accepted owner; do not export as agreed responsibility', True)
        deadline = candidate.get('deadline')
        if obj(deadline, {'raw_text', 'normalized_date', 'modality', 'basis', 'evidence'}, path + '.deadline'):
            raw, basis = deadline.get('raw_text'), deadline.get('basis')
            string(raw, path + '.deadline.raw_text', nullable=True)
            enum(basis, DEADLINE_BASES, path + '.deadline.basis')
            enum(deadline.get('modality'), {'firm', 'target', 'unspecified'}, path + '.deadline.modality')
            _, quotes = evidence(deadline.get('evidence'), path + '.deadline.evidence',
                                 required=raw is not None or basis != 'unstated')
            if deadline.get('normalized_date') is not None:
                emit('deadline_normalization', path + '.deadline.normalized_date', 'Pilot requires null; no date conversion is authorized')
            if basis == 'unstated' and (raw is not None or deadline.get('evidence') != [] or deadline.get('modality') != 'unspecified'):
                emit('deadline_null', path + '.deadline', 'Unstated deadline requires null raw_text, unspecified modality, empty evidence')
            if basis in ('explicit_absolute', 'explicit_relative') and raw is None:
                emit('deadline_null', path + '.deadline', 'Explicit deadline requires raw_text')
            if isinstance(raw, str) and not any(normalize(raw) in q for q in quotes):
                emit('deadline_text_absent', path + '.deadline', 'raw_text must occur exactly in deadline evidence')
            if raw is None and deadline.get('modality') in ('firm', 'target'):
                emit('deadline_null', path + '.deadline', 'Firm/target timing requires raw_text')
            if isinstance(raw, str) and deadline.get('modality') == 'firm' and any(term in raw for term in ('目標', '目途')):
                emit('target_language', path + '.deadline', 'Target wording may conflict with firm modality; verify meaning, do not infer from keyword alone', True)
            if deadline.get('modality') == 'target':
                emit('target_not_deadline', path + '.deadline', 'Target is aspirational; do not export as firm deadline', True)
    for i, (left_id, left) in enumerate(spans):
        for right_id, right in spans[i+1:]:
            if any(a[0] == b[0] and (a[1] <= b[1] and a[2] >= b[2] or b[1] <= a[1] and b[2] >= a[2]) for a in left for b in right):
                cid = right_id
                emit('overlapping_evidence', '$.candidates', 'Evidence contains/is contained by candidate ' + str(left_id) + '; review duplication only', True)
    return {'checker_pass': not errors, 'errors': errors, 'warnings': warnings,
            'semantic_guarantee': False}


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or set(payload) != {'case', 'extraction'}:
            raise ValueError('Input must contain exactly case and extraction')
        result = check(payload['case'], payload['extraction'])
    except (ValueError, TypeError) as error:
        result = {'checker_pass': False, 'errors': [{'candidate_id': None,
                  'rule_id': 'input_json', 'severity': 'error', 'path': '$', 'message': str(error)}],
                  'warnings': [], 'semantic_guarantee': False}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result['checker_pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
