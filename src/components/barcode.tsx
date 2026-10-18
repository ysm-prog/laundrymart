import { code128BBars, encodableInCode128B } from "@/lib/domain/code128";

/**
 * A Code 128 barcode as an SVG (brief 3.4). Server-rendered and printed by the
 * browser, so the docket needs no image file and no barcode package. Black on
 * white whatever the theme, with the ten-module quiet zone a scanner needs on
 * either side, and the text printed underneath for when the scanner is not to
 * hand.
 */
export function Code128({
  value, height = 64, moduleWidth = 2,
}: { value: string; height?: number; moduleWidth?: number }) {
  if (!encodableInCode128B(value)) return null;
  const quiet = 10;
  const { bars, width } = code128BBars(value);
  const total = (width + quiet * 2) * moduleWidth;
  return (
    <figure className="inline-block bg-white p-2 text-black">
      <svg role="img" aria-label={`Barcode ${value}`} width={total} height={height}
           viewBox={`0 0 ${total} ${height}`} shapeRendering="crispEdges">
        <rect width={total} height={height} fill="#fff" />
        {bars.map((bar) => (
          <rect key={bar.x} x={(bar.x + quiet) * moduleWidth} y={0}
                width={bar.width * moduleWidth} height={height} fill="#000" />
        ))}
      </svg>
      <figcaption className="mt-1 text-center font-mono text-sm tracking-widest">{value}</figcaption>
    </figure>
  );
}
