"""Review-only oracle generation. CI reads the committed fixture; it never regenerates answers."""
from fractions import Fraction
from decimal import Decimal, localcontext, ROUND_HALF_EVEN
from pathlib import Path
import json
import random

rng = random.Random(20261002)
cases = []
def add_case(operation, fields, places=None):
    values = {key: Fraction(value) for key, value in fields.items()}
    if operation == 'add': answer = values['left'] + values['right']
    elif operation == 'subtract': answer = values['left'] - values['right']
    elif operation == 'multiply': answer = values['left'] * values['right']
    elif operation == 'divide': answer = values['left'] / values['right']
    elif operation == 'percentage_of': answer = values['amount'] * values['percent'] / 100
    else: answer = (values['to'] - values['from']) / values['from'] * 100
    denominator = answer.denominator
    while denominator % 2 == 0: denominator //= 2
    while denominator % 5 == 0: denominator //= 5
    with localcontext() as ctx:
        ctx.prec = 1000
        value = Decimal(answer.numerator) / Decimal(answer.denominator)
        text = format(value, 'f') if denominator == 1 else None
        if text is not None and '.' in text: text = text.rstrip('0').rstrip('.')
        expected = {'numerator': str(answer.numerator), 'denominator': str(answer.denominator), 'decimal': text}
        entry = {'id': f'case-{len(cases)+1:03}', 'input': {'version': 'calculation-v1', 'operation': operation, **fields}, 'expected': expected}
        if places is not None:
            display = value.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_EVEN)
            if display == 0: display = abs(display)
            entry['input']['decimalPlaces'] = places
            entry['display'] = {'value': format(display, 'f'), 'decimalPlaces': places, 'rounding': 'half_even', 'exact': Fraction(display) == answer}
        cases.append(entry)

add_case('add', {'left': '0.1', 'right': '0.2'})
add_case('add', {'left': '9007199254740993', 'right': '1'})
add_case('divide', {'left': '1', 'right': '3'}, 8)
for value in ['2.5','3.5','-2.5','-3.5']: add_case('add', {'left': value, 'right': '0'}, 0)
add_case('percentage_change', {'from': '80', 'to': '100'}, 4)
for operation in ['add','subtract','multiply','divide','percentage_of','percentage_change']:
    for _ in range(20):
        def number(positive=False):
            integer = rng.randint(1, 99999) if positive else rng.randint(-99999, 99999)
            with localcontext() as ctx:
                ctx.prec = 30
                return format(Decimal(integer).scaleb(-rng.randint(0, 5)), 'f')
        if operation == 'percentage_of': fields = {'amount': number(), 'percent': number()}
        elif operation == 'percentage_change': fields = {'from': number(True), 'to': number()}
        else: fields = {'left': number(), 'right': number(True)}
        add_case(operation, fields, rng.randint(0, 8))
output = {'version': 'calculation-reference-v1', 'oracle': 'Python fractions.Fraction + decimal.Decimal (ROUND_HALF_EVEN)', 'seed': 20261002, 'cases': cases}
path = Path(__file__).resolve().parents[1] / 'fixtures/calculation-v1/reference.json'
header = {key: value for key, value in output.items() if key != 'cases'}
text = json.dumps(header, ensure_ascii=False, indent=2)[:-2] + ',\n  \"cases\": [\n'
text += ',\n'.join('    ' + json.dumps(case, ensure_ascii=False) for case in cases)
path.write_text(text + '\n  ]\n}\n')
print(f'{len(cases)} reference cases written')
