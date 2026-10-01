"""Offline fault-injection checks in an isolated committed-tree copy.

Requires Python 3.12+, Git, Node, and the repository's installed node_modules.
It never changes the checkout's calculator or its expected answers.
"""
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TESTS = [
    'src/domain/calculation.test.ts',
    'src/domain/calculation-reference.test.ts',
    'src/domain/calculation-verify.test.ts',
]
MUTATIONS = [
    ('float-addition',
     'fraction(a.n * b.d + b.n * a.d, a.d * b.d)',
     "decimal(String(Number(a.n) / Number(a.d) + Number(b.n) / Number(b.d)), 'mutant')"),
    ('wrong-tie-rounding',
     'remainder * 2n === value.d && quotient % 2n !== 0n',
     'remainder * 2n === value.d'),
    ('wrong-percentage-divisor',
     "div(step('multiply', mul(a, b)), fraction(100n, 1n))",
     "div(step('multiply', mul(a, b)), fraction(10n, 1n))"),
    ('accept-wrong-numeric-claim',
     'asserted.n.toString() === expected.result.numerator && asserted.d.toString() === expected.result.denominator',
     'true'),
    ('ignore-function-identity',
     'matches = matches && fields.functionId === expected.functionId;',
     'matches = matches;'),
]


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def run_tests(lab, name):
    report = lab / (name + '.json')
    process = subprocess.run(
        ['node', str(ROOT / 'node_modules/vitest/vitest.mjs'), 'run', *TESTS,
         '--reporter=json', '--outputFile=' + str(report)],
        cwd=lab, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, timeout=60,
    )
    (lab / (name + '.log')).write_text(process.stdout)
    if not report.is_file():
        raise RuntimeError(f'No test report for {name}; inspect {lab / (name + ".log")}')
    result = json.loads(report.read_text())
    failures = [assertion['fullName']
                for file in result['testResults']
                for assertion in file['assertionResults']
                if assertion['status'] == 'failed']
    return {'exitCode': process.returncode, 'total': result['numTotalTests'],
            'failed': result['numFailedTests'], 'assertionFailures': failures}


def main():
    if git('status', '--porcelain'):
        raise RuntimeError('Commit or preserve pending work first; this experiment tests exactly HEAD.')
    if not (ROOT / 'node_modules/vitest/vitest.mjs').is_file():
        raise RuntimeError('Install the locked repository dependencies before running this experiment.')
    commit, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
    lab = Path(tempfile.mkdtemp(prefix='invariant-calculation-mutation-'))
    archive = subprocess.check_output(['git', 'archive', commit], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(lab, filter='data')
    os.symlink(ROOT / 'node_modules', lab / 'node_modules', target_is_directory=True)
    baseline = run_tests(lab, 'baseline')
    if baseline['exitCode'] != 0 or baseline['failed'] != 0:
        raise RuntimeError(f'Baseline failed; no mutation claim is valid. Inspect {lab}')
    target = lab / 'src/domain/calculation.ts'
    original = target.read_text()
    results = []
    for name, before, after in MUTATIONS:
        if original.count(before) != 1:
            raise RuntimeError(f'{name}: source changed; review the mutation explicitly before updating it.')
        try:
            target.write_text(original.replace(before, after))
            outcome = run_tests(lab, name)
            # A transform error alone is not evidence that a regression assertion caught the fault.
            caught = outcome['exitCode'] != 0 and bool(outcome['assertionFailures'])
            results.append({'name': name, 'caught': caught, **outcome})
        finally:
            target.write_text(original)
    if git('rev-parse', 'HEAD') != commit or git('status', '--porcelain'):
        raise RuntimeError('The caller checkout changed during the experiment; results are not a current-tree gate.')
    result = {'sourceCommit': commit, 'sourceTree': tree, 'baseline': baseline,
              'mutations': results, 'logDirectory': str(lab)}
    output = ROOT / '_build/calculation-mutations'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=output, delete=False) as temporary:
        json.dump(result, temporary, ensure_ascii=False, indent=2)
        temporary.write('\n')
        temporary_path = temporary.name
    os.replace(temporary_path, output / 'latest.json')
    print(json.dumps({'sourceTree': tree, 'baselineTests': baseline['total'],
                      'mutations': [{'name': item['name'], 'caught': item['caught'],
                                     'failedTests': item['failed']} for item in results],
                      'report': str(output / 'latest.json')}, ensure_ascii=False))
    if not all(item['caught'] for item in results):
        raise RuntimeError('At least one selected fault survived. Inspect the report; do not mark the gate passed.')


if __name__ == '__main__':
    main()
