"""Independent literal-quote oracle using Python Unicode strings and hashlib.

This is a manual fixture-authoring tool, never run automatically by CI.
"""
import hashlib
import json
from pathlib import Path
import random


def units(text):
    return len(text.encode('utf-16-le')) // 2


def bounded_context(text, reverse=False):
    selected, size = [], 0
    for character in reversed(text) if reverse else text:
        count = units(character)
        if size + count > 40:
            break
        selected.append(character)
        size += count
    return ''.join(reversed(selected) if reverse else selected)


def case(source, quote, index):
    matches = []
    start = source.find(quote)
    while start >= 0:
        end = start + len(quote)
        matches.append({'start': units(source[:start]), 'end': units(source[:end]),
                        'before': bounded_context(source[:start], reverse=True),
                        'after': bounded_context(source[end:])})
        start = source.find(quote, start + 1)
    return {'id': f'quote-{index:03}',
            'input': {'version': 'quote-evidence-v1', 'source': {'id': f'synthetic-{index:03}', 'version': 'v1', 'text': source}, 'quote': quote},
            'expected': {'status': 'matched' if matches else 'not_found', 'matches': matches[:20],
                         'truncated': len(matches) > 20,
                         'hash': hashlib.sha256(source.encode('utf-8')).hexdigest()}}


pairs = [('abc', 'b'), ('料金は未確定。', '確定'), ('Ａ', 'A'),
         ('😀' * 30 + 'x根拠y' + '😀' * 30, '根拠'), ('a' * 50, 'aa'),
         ('👨\u200d👩\u200d👧\u200d👦' * 20, '👩')]
rng = random.Random(20261002)
alphabet = list('abcXYZ料金未確定日本語 \r\n') + ['😀', '🧪', '\u0301', '\u200d', '\ufe0f']
for index in range(94):
    source = ''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 150)))
    start = rng.randrange(len(source))
    quote = source[start:start + rng.randint(1, 8)] if index % 4 else '【absent】'
    pairs.append((source, quote))
result = {'version': 'quote-reference-v1', 'oracle': 'Python Unicode str.find + hashlib.sha256',
          'seed': 20261002, 'cases': [case(source, quote, index + 1) for index, (source, quote) in enumerate(pairs)]}
path = Path(__file__).resolve().parents[1] / 'fixtures/quote-evidence-v1/reference.json'
header = {key: value for key, value in result.items() if key != 'cases'}
text = json.dumps(header, ensure_ascii=False, indent=2)[:-2] + ',\n  "cases": [\n'
text += ',\n'.join('    ' + json.dumps(item, ensure_ascii=False) for item in result['cases'])
path.write_text(text + '\n  ]\n}\n')
print(f'{len(pairs)} independent quote cases written')
