/**
 * Code 128 (subset B), for the job docket (Darshan's review, brief 3.4).
 *
 * A docket carries its job number as a barcode so the Laundry board's scan box
 * (brief 3.3) can mark the job ready with one pull of a handheld scanner. Code
 * 128 B covers every printable ASCII character, which is more than a job number
 * needs and is what every scanner reads out of the box.
 *
 * Pure and dependency-free: a few dozen lines of table are cheaper than a
 * barcode package in the bundle, and the encoding is fully specified (ISO/IEC
 * 15417). The rule for each symbol is its widths — bar, space, bar, space, bar,
 * space, in modules — and the tests hold the table to the properties the
 * standard guarantees, so a typo in it cannot pass.
 */

/** Widths of symbols 0–105 (six elements, 11 modules each). 106 is the stop. */
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
  // 106: the stop symbol, seven elements and 13 modules.
  "2331112",
];

export const START_B = 104;
export const STOP = 106;

/** Whether a string can be written in subset B: printable ASCII only. */
export function encodableInCode128B(text: string): boolean {
  return text.length > 0 && /^[\x20-\x7e]+$/.test(text);
}

/**
 * The symbol values for `text`: start B, one per character, the check symbol,
 * stop. The check is the start value plus each character's value times its
 * position (from 1), modulo 103.
 */
export function code128BValues(text: string): number[] {
  if (!encodableInCode128B(text)) {
    throw new Error("Code 128 B carries printable ASCII only");
  }
  const values = [...text].map((character) => character.charCodeAt(0) - 32);
  const checksum = (START_B + values.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
  return [START_B, ...values, checksum, STOP];
}

/** One bar to draw: where it starts and how wide it is, in modules. */
export type Bar = { x: number; width: number };

/**
 * The bars for `text`, in modules from the left edge of the symbol (no quiet
 * zone), and the symbol's total width. Spaces are the gaps between bars.
 */
export function code128BBars(text: string): { bars: Bar[]; width: number } {
  const bars: Bar[] = [];
  let x = 0;
  for (const value of code128BValues(text)) {
    const widths = CODE128_PATTERNS[value]!;
    for (let index = 0; index < widths.length; index += 1) {
      const width = Number(widths[index]);
      if (index % 2 === 0) bars.push({ x, width });
      x += width;
    }
  }
  return { bars, width: x };
}
