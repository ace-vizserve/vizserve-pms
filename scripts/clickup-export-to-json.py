"""
P7-67 — the ClickUp xlsx export, as JSON the import scripts can read.

    python scripts/clickup-export-to-json.py <export.xlsx> <out.json> [--space VizBytes]

⚠️ PYTHON, IN A REPO THAT IS OTHERWISE JAVASCRIPT, and deliberately. Reading an
xlsx means unzipping it and parsing SpreadsheetML; node has no zip reader in its
standard library, so doing this in JS means a dependency added to `package.json`
for a one-off migration. Python's `zipfile` and `ElementTree` are already there.
This is a migration tool, not application code — it imports nothing from the app
and nothing in the app imports it.

⚠️ IT EMITS ONLY WHAT THE IMPORT NEEDS. Task id, title, space, attachments and
comments. The export has 34 columns; carrying the other 29 into a file that gets
passed around would be spreading staff emails and time-tracking data for no
reason.

Column map, for anyone holding a different export: A task id · D title ·
O attachments (JSON) · U space · Y comments (JSON).
"""

import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
TEXT = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"


def read_rows(path):
    """Every row as {column letter: value}, shared strings already resolved."""
    book = zipfile.ZipFile(path)

    strings = [
        "".join(node.text or "" for node in item.iter(TEXT))
        for item in ET.fromstring(book.read("xl/sharedStrings.xml")).findall("m:si", NS)
    ]

    sheet = ET.fromstring(book.read("xl/worksheets/sheet1.xml"))
    rows = []

    for row in sheet.find("m:sheetData", NS):
        cells = {}
        for cell in row.findall("m:c", NS):
            column = re.match(r"[A-Z]+", cell.get("r")).group()
            value = cell.find("m:v", NS)

            if cell.get("t") == "s" and value is not None:
                cells[column] = strings[int(value.text)]
            elif cell.get("t") == "inlineStr":
                cells[column] = "".join(node.text or "" for node in cell.iter(TEXT))
            else:
                cells[column] = value.text if value is not None else ""
        rows.append(cells)

    return rows[1:]  # drop the header


def parse_json_cell(raw):
    """`[]`, empty and whitespace all mean 'none'; anything else must parse."""
    raw = (raw or "").strip()
    if raw in ("", "[]"):
        return []
    return json.loads(raw)


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip().splitlines()[2].strip())
        return 1

    source, destination = sys.argv[1], sys.argv[2]
    space = None
    if "--space" in sys.argv:
        space = sys.argv[sys.argv.index("--space") + 1]

    out = []
    for row in read_rows(source):
        if space and (row.get("U") or "").strip() != space:
            continue

        attachments = parse_json_cell(row.get("O"))

        # A task with no files has nothing for the image import to do. Comments
        # without attachments are the date backfill's business, not this one.
        if not attachments:
            continue

        out.append(
            {
                "clickup_id": row.get("A"),
                "title": row.get("D"),
                "space": row.get("U"),
                "list": row.get("S"),
                "attachments": attachments,
                "comments": parse_json_cell(row.get("Y")),
            }
        )

    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(out, handle)

    files = sum(len(entry["attachments"]) for entry in out)
    print(f"{len(out)} task(s) with {files} attachment(s) -> {destination}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
