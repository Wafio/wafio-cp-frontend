import qrcode from 'qrcode-generator';

// Draws the otpauth URL the server issued as an SVG string that is about `size` px wide.
// Error correction M and a 2 module quiet zone, as authenticator apps expect.
export function qrSvg(text: string, size = 200, margin = 2): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const cell = Math.max(1, Math.floor(size / (qr.getModuleCount() + 2 * margin)));
  return qr.createSvgTag({ cellSize: cell, margin: margin * cell });
}
