#!/usr/bin/env python3
"""Fetch official pages only when invoked; reject changed case text.

Requires Python 3.9+ and lxml. No model calls. Run --help for usage.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.request


def extract_blocks(raw):
    from lxml import html
    root = html.fromstring(raw)
    for br in root.xpath('//br'):
        br.tail = '\n' + (br.tail or '')
    articles = root.xpath('//article')
    body = articles[0] if articles else root
    blocks = []
    for element in body.xpath('.//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::p or self::li]'):
        if element.xpath('ancestor::li'):
            continue
        text = ''.join(element.itertext()).strip()
        if text:
            blocks.append({'tag': element.tag, 'text': text,
                           'xpath': root.getroottree().getpath(element)})
    return blocks


def build_case(spec, source, blocks):
    pos = spec['position']
    first, last = pos['block_start_0based'], pos['block_end_0based_inclusive']
    selected = blocks[first:last + 1]
    if len(selected) != last - first + 1:
        raise ValueError(f"{spec['case_id']}: selected blocks are missing")
    text = '\n\n'.join(block['text'] for block in selected)
    if 'line_start_0based' in pos:
        lines = text.splitlines()
        start, end = pos['line_start_0based'], pos['line_end_0based_exclusive']
        if len(lines) < end:
            raise ValueError(f"{spec['case_id']}: selected lines are missing")
        text = '\n'.join(lines[start:end])
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
    if digest != spec['text_sha256']:
        raise ValueError(f"{spec['case_id']}: case text SHA-256 mismatch; expected "
                         f"{spec['text_sha256']}, got {digest}. "
                         "Official content/extraction changed. No replacement corpus was written.")
    headings = []
    for block in blocks[:first]:
        if block['tag'].startswith('h'):
            level = int(block['tag'][1:])
            headings = [h for h in headings if h[0] < level] + [(level, block['text'])]
    return {
        'case_id': spec['case_id'], 'source_id': spec['source_id'],
        'source_url': source['source_url'], 'meeting_date': spec['meeting_date'],
        'heading': headings[-1][1] if headings else None,
        'speakers_as_published': list(dict.fromkeys(re.findall(r'^([^\n：]{1,30})：', text, re.M))),
        'position': dict(pos), 'text': text, 'character_count': len(text),
        'text_sha256': digest,
        'source_raw_html_sha256': source['raw_html_sha256'],
        'paragraphs': [{'paragraph_id': f"{spec['case_id']}-P{i:03d}", 'text': line}
                       for i, line in enumerate([line for line in text.splitlines() if line.strip()], 1)]
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True, type=Path,
                        help='Local output folder; must not already exist')
    args = parser.parse_args(argv)
    if args.output_dir.exists():
        parser.error('output directory already exists; choose a new directory')
    metadata = json.loads(Path(__file__).with_name('sources.json').read_text(encoding='utf-8'))
    collected, fetched = {}, []
    try:
        for source in metadata['sources']:
            with urllib.request.urlopen(source['source_url'], timeout=60) as response:
                raw = response.read()
            digest = hashlib.sha256(raw).hexdigest()
            collected[source['id']] = extract_blocks(raw)
            fetched.append({'source_url': source['source_url'],
                            'retrieved_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                            'raw_html_sha256': digest,
                            'original_raw_html_sha256': source['raw_html_sha256']})
            if digest != source['raw_html_sha256']:
                print('WARNING: HTML hash changed; selected case text must still match: '
                      + source['source_url'], file=sys.stderr)
        sources = {s['id']: s for s in metadata['sources']}
        cases = [build_case(spec, sources[spec['source_id']], collected[spec['source_id']])
                 for spec in metadata['cases']]
        # Do not write any corpus until every original case hash has matched.
        args.output_dir.mkdir(parents=True, exist_ok=False)
        (args.output_dir / 'cases.json').write_text(
            json.dumps(cases, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (args.output_dir / 'fetch-manifest.json').write_text(
            json.dumps(fetched, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    except Exception as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1
    print(f'Verified {len(cases)} original case text hashes; local output: {args.output_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
