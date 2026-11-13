"""Generate a public, synthetic two-column/two-page PDF; no personal content."""
import sys
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

writer=PdfWriter()
for number in (1,2):
    page=writer.add_blank_page(width=612,height=792)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})})
    # Draw each column in its reading order. Test the same ordering with AT.
    lines=[]
    for x,label in [(45,'LEFT'),(325,'RIGHT')]:
        for row in range(5):
            text=f'PAGE {number} {label} paragraph {row+1}.'
            lines.append(f'BT /F1 12 Tf {x} {720-row*45} Td ({text}) Tj ET')
    stream=DecodedStreamObject();stream.set_data('\n'.join(lines).encode('ascii'))
    page[NameObject('/Contents')]=writer._add_object(stream)
writer.add_metadata({'/Title':'EasyRead synthetic two-column accessibility sample','/Author':'Synthetic fixture'})
path=Path(sys.argv[1]);path.parent.mkdir(parents=True,exist_ok=True)
with path.open('wb') as out:writer.write(out)
print(path)
