"""Summarize only synthetic utterance markers from a PRIVATE NVDA debug log."""
import json
import re
import sys
from pathlib import Path

lines = Path(sys.argv[1]).read_text(encoding='utf-8', errors='replace').splitlines()
ordered = []
for line in lines:
    markers = re.findall(r'PAGE ([12]) (LEFT|RIGHT) paragraph ([1-5])\.', line)
    # Exclude focus announcements containing the entire PDF as one string.
    if line.startswith('Speaking') and len(markers) == 1 and markers[0] not in ordered:
        ordered.append(markers[0])
expected = [(str(p), side, str(n)) for p in (1, 2)
            for side in ('LEFT', 'RIGHT') for n in range(1, 6)]
gesture = any('Input: kb(desktop):NVDA+downArrow' in line for line in lines)
print(json.dumps({'actualSayAllGesture': gesture, 'syntheticMarkers': ordered,
                  'completeOrderMatches': ordered == expected}, indent=2))
sys.exit(0 if gesture and ordered == expected else 1)
