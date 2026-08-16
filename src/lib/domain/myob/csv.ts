/**
 * RFC 4180 CSV, because MYOB's exports are RFC 4180 CSV.
 *
 * Hand-rolled rather than pulled from npm for the same reason the Python
 * importer used only the standard library: this runs inside a request handler in
 * a deployment nobody will rebuild to add a parser, and the format it has to
 * cope with is a hundred lines of code. Quoted fields, doubled quotes inside
 * them, commas and newlines inside them, and a byte-order mark.
 */

/** Split a CSV document into rows of raw cells. */
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // Excel and MYOB both stamp a BOM on UTF-8 exports; it would otherwise become
  // part of the first header name and every lookup against it would miss.
  let at = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (at < source.length) {
    const char = source[at];
    if (quoted) {
      if (char === '"') {
        if (source[at + 1] === '"') { field += '"'; at += 2; continue; }
        quoted = false; at += 1; continue;
      }
      field += char; at += 1; continue;
    }
    if (char === '"' && field === "") { quoted = true; at += 1; continue; }
    if (char === ",") { endField(); at += 1; continue; }
    if (char === "\r") { at += 1; continue; }
    if (char === "\n") { endRow(); at += 1; continue; }
    field += char; at += 1;
  }
  // A file that ends without a newline still has a last row; one that ends with
  // a newline does not have an extra empty one.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Rows as records keyed by the header line.
 *
 * Short rows read as empty strings rather than `undefined`, which keeps every
 * reader's `row["Some Column"]` honest — and matters here, because the bills
 * export's dropped-column bug is detected by a column being *empty*, not absent.
 */
export function parseCsvRecords(source: string): Record<string, string>[] {
  const rows = parseCsv(source).filter((row) => row.some((cell) => cell.trim() !== ""));
  if (rows.length === 0) return [];
  const header = (rows[0] ?? []).map((name) => name.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((name, index) => { record[name] = cells[index] ?? ""; });
    return record;
  });
}

/** The header line on its own, for working out which export a file is. */
export function csvHeader(source: string): string[] {
  const [first = []] = parseCsv(source);
  return first.map((name) => name.trim());
}
