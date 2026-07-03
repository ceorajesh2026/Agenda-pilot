# -*- coding: utf-8 -*-
"""Load + clean + consolidate the WNS 2026 faculty contact directory from the two xlsx files.
Returns a list of normalized Person dicts (deduped)."""
import openpyxl, re
from collections import defaultdict

EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
_TITLE_TOKENS = {'DR', 'PROF', 'MR', 'MRS', 'MS', 'COL', 'LT', 'MAJ', 'GEN', 'BRIG', 'CAPT', 'SURG', 'WG', 'CDR', 'GP'}

ALIASES = {
    'title':      ['title'],
    'category':   ['cat.', 'cat'],
    'name':       ['name'],
    'speciality': ['speciality', 'specialty'],
    'email':      ['email id', 'email'],
    'phone':      ['contact no', 'contactno', 'mobno.', 'mob no.', 'mobno'],
    'designation':['designation'],
    'institution':['organiziation', 'organization', 'institution'],
    'city':       ['city'],
    'country':    ['nationality', 'country/state', 'national'],
    'status':     ['status'],
    'commitment': ['commitment'],
}


def norm_name(raw):
    s = str(raw).upper().strip()
    s = re.sub(r'[().]', ' ', s)
    toks = [t for t in re.split(r'\s+', s) if t]
    while toks and toks[0] in _TITLE_TOKENS:
        toks.pop(0)
    return ' '.join(toks)


def slugify(key):
    return 'p-' + re.sub(r'[^a-z0-9]+', '-', key.lower()).strip('-')


def clean_emails(cell):
    if not cell:
        return []
    return list(dict.fromkeys(m.group(0).lower() for m in EMAIL_RE.finditer(str(cell))))


def clean_phones(cell):
    if not cell:
        return []
    s = str(cell).replace('`', '')
    out = []
    for p in re.split(r'[,/\n]| or ', s):
        keep = re.sub(r'[^\d+]', '', p.strip())
        if len(re.sub(r'\D', '', keep)) >= 7:
            out.append(keep)
    return list(dict.fromkeys(out))


def whatsapp_likely(phones):
    for ph in phones:
        d = re.sub(r'\D', '', ph)
        if len(d) == 10 and d[0] in '6789':
            return True
        if len(d) == 12 and d.startswith('91') and d[2] in '6789':
            return True
        if ph.startswith('+') and len(d) >= 10:
            return True
        if len(d) >= 11:
            return True
    return False


def _find_header(rows):
    for i, r in enumerate(rows[:6]):
        cells = [str(c).strip().lower() if c else '' for c in r]
        if any(c == 'name' for c in cells) and any(('email' in c or 'mob' in c or 'contact' in c) for c in cells):
            return i
    return None


def _colmap(hdr):
    cells = [str(c).strip().lower() if c else '' for c in hdr]
    cmap = {}
    for field, al in ALIASES.items():
        for a in al:
            for j, c in enumerate(cells):
                if c == a:
                    cmap[field] = j
                    break
            if field in cmap:
                break
    return cmap


def _extract(base, fn, sheet, seg):
    wb = openpyxl.load_workbook(base + fn, data_only=True, read_only=True)
    ws = wb[sheet]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    hi = _find_header(rows)
    if hi is None:
        return []
    cmap = _colmap(rows[hi])
    recs = []
    for r in rows[hi + 1:]:
        def g(f):
            j = cmap.get(f)
            return r[j] if (j is not None and j < len(r)) else None
        nm = g('name')
        if not nm or not str(nm).strip():
            continue
        phones = clean_phones(g('phone'))
        recs.append({
            'name': str(nm).strip(),
            'name_key': norm_name(nm),
            'category': (str(g('category')).strip() if g('category') else ''),
            'speciality': (str(g('speciality')).strip() if g('speciality') else ''),
            'emails': clean_emails(g('email')),
            'phones': phones,
            'whatsapp_likely': whatsapp_likely(phones),
            'designation': (str(g('designation')).strip() if g('designation') else ''),
            'institution': (str(g('institution')).strip() if g('institution') else ''),
            'city': (str(g('city')).strip() if g('city') else ''),
            'country': (str(g('country')).strip() if g('country') else ''),
            'status': (str(g('status')).strip() if g('status') else ''),
            'commitment': (str(g('commitment')).strip() if g('commitment') else ''),
            'segment': seg,
        })
    return recs


def load_directory(base):
    NR = 'WNS 26 - NR-Faculty List- 2 July 26 - Copy.xlsx'
    NS = 'WNS 26 - NS-Faculty List-3 July 26.xlsx'
    raw = []
    raw += _extract(base, NR, 'Master List', 'NR-National')
    raw += _extract(base, NR, 'INT', 'NR-International')
    raw += _extract(base, NS, 'National', 'NS-National')
    raw += _extract(base, NS, 'International', 'NS-International')
    declined_keys = {r['name_key'] for r in _extract(base, NS, 'DeclinedCancelled', 'x')}
    wrong_keys = {r['name_key'] for r in _extract(base, NS, 'Wrong Email', 'x')}

    groups = defaultdict(list)
    for r in raw:
        groups[r['name_key']].append(r)

    people = []
    for key, rs in groups.items():
        base_rec = max(rs, key=lambda x: (len(x['emails']) > 0, len(x['phones']) > 0,
                                          len(x['institution']), len(x['designation'])))
        emails = list(dict.fromkeys(sum([x['emails'] for x in rs], [])))
        phones = list(dict.fromkeys(sum([x['phones'] for x in rs], [])))
        m = {
            'id': slugify(key),
            'name': base_rec['name'].title(),
            'name_key': key,
            'category': base_rec['category'],
            'speciality': base_rec['speciality'],
            'emails': emails,
            'phones': phones,
            'whatsapp_likely': whatsapp_likely(phones),
            'designation': base_rec['designation'],
            'institution': base_rec['institution'],
            'city': base_rec['city'],
            'country': base_rec['country'],
            'status': base_rec['status'],
            'commitment': base_rec['commitment'],
            'segments': sorted({x['segment'] for x in rs}),
            'declined': key in declined_keys,
            'wrong_email': key in wrong_keys,
            'reachable_email': len(emails) > 0 and key not in wrong_keys,
            'reachable_wa_sms': len(phones) > 0,
        }
        people.append(m)
    return people
