import { inflateRawSync } from "node:zlib";

/**
 * Enough of .xlsx to read a MYOB report: the first worksheet, as rows of
 * strings.
 *
 * An .xlsx is a zip of XML, and both halves of that are hand-rolled here for the
 * same reason as the CSV parser — a spreadsheet library is a large dependency to
 * carry into a request handler for one screen, and only a sliver of the format
 * is in play. Shared strings, inline strings and plain numbers; nothing else is
 * supported, and anything unsupported reads as empty rather than as a wrong
 * value.
 *
 * Cells are placed by their `r` reference, so a row that omits an empty cell —
 * which is how spreadsheets are usually written — keeps every later value in its
 * own column instead of sliding one to the left.
 */

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

export class XlsxError extends Error {}

// ------------------------------------------------------------------ zip ---

type Entry = { name: string; method: number; size: number; offset: number };

/** Central-directory listing. The directory is authoritative about sizes. */
function directory(buffer: Buffer): Entry[] {
  const end = findEndOfCentralDirectory(buffer);
  let at = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  const entries: Entry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x0201_4b50) throw new XlsxError("Damaged zip directory.");
    const nameLength = buffer.readUInt16LE(at + 28);
    entries.push({
      method: buffer.readUInt16LE(at + 10),
      size: buffer.readUInt32LE(at + 20),
      name: buffer.toString("utf8", at + 46, at + 46 + nameLength),
      offset: buffer.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is last but carries a variable-length comment, so it is found by
  // scanning back rather than by arithmetic. 64 KB is the most a comment can be.
  const floor = Math.max(0, buffer.length - 0x1_0000 - 22);
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x0605_4b50) return at;
  }
  throw new XlsxError("That is not a spreadsheet — no zip directory was found.");
}

function read(buffer: Buffer, entry: Entry): Buffer {
  if (entry.offset === 0xffff_ffff || entry.size === 0xffff_ffff) {
    throw new XlsxError("That spreadsheet uses ZIP64, which this reader does not handle.");
  }
  if (buffer.readUInt32LE(entry.offset) !== 0x0403_4b50) throw new XlsxError("Damaged zip entry.");
  const start = entry.offset + 30
    + buffer.readUInt16LE(entry.offset + 26)
    + buffer.readUInt16LE(entry.offset + 28);
  const raw = buffer.subarray(start, start + entry.size);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new XlsxError(`Unsupported compression in ${entry.name}.`);
}

// ------------------------------------------------------------------ xml ---

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

/** Every `<t>` inside a fragment, joined — a rich-text run is many of them. */
function textRuns(fragment: string): string {
  const runs = fragment.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? [];
  return runs.map((run) => decode(run.replace(/^<t(?:\s[^>]*)?>/, "").replace(/<\/t>$/, ""))).join("");
}

/** `BC` → 54. Spreadsheet columns are base-26 with no zero. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1] ?? "";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

// --------------------------------------------------------------- public ---

/** The first worksheet of an .xlsx, as rows of cell strings. */
export function readXlsx(source: Buffer | ArrayBuffer | Uint8Array): string[][] {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source as ArrayBuffer);
  const entries = directory(buffer);
  const find = (name: string) => entries.find((entry) => entry.name === name);

  const shared: string[] = [];
  const sharedEntry = find("xl/sharedStrings.xml");
  if (sharedEntry) {
    const xml = read(buffer, sharedEntry).toString("utf8");
    for (const item of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(textRuns(item));
  }

  // sheet1.xml is what these reports produce; the alphabetical fallback covers a
  // workbook whose first sheet is named otherwise, without parsing the rels.
  const sheetEntry = find("xl/worksheets/sheet1.xml")
    ?? entries.filter((entry) => /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (!sheetEntry) throw new XlsxError("That workbook has no worksheets.");

  const sheet = read(buffer, sheetEntry).toString("utf8");
  if (!sheet.includes(SHEET_NS)) throw new XlsxError("That worksheet is not in the expected format.");

  const rows: string[][] = [];
  for (const rowXml of sheet.match(/<row[\s\S]*?(?:\/>|<\/row>)/g) ?? []) {
    const cells: string[] = [];
    let next = 0;
    for (const cellXml of rowXml.match(/<c(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const reference = /\sr="([A-Z]+\d+)"/.exec(cellXml)?.[1];
      const at = reference ? columnIndex(reference) : next;
      while (cells.length < at) cells.push("");
      const kind = /\st="([^"]+)"/.exec(cellXml)?.[1];
      let value = "";
      if (kind === "inlineStr") {
        value = textRuns(cellXml);
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? "";
        value = kind === "s" && raw ? shared[Number(raw)] ?? "" : decode(raw);
      }
      cells[at] = value;
      next = at + 1;
    }
    rows.push(cells);
  }
  return rows;
}
