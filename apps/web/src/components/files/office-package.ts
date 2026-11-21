// Office documents store the expanded sizes in their ZIP directory. Check it before invoking a parser.
export function checkOfficePackage(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let footer = view.byteLength - 22; footer >= minimum; footer--) {
    if (view.getUint32(footer, true) !== 0x06054b50 || footer + 22 + view.getUint16(footer + 20, true) !== view.byteLength) continue;
    const count = view.getUint16(footer + 10, true);
    let cursor = view.getUint32(footer + 16, true);
    let total = 0;
    if (count > 8000) throw new Error("Office 文件包含过多组件，请下载查看。");
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > footer || view.getUint32(cursor, true) !== 0x02014b50) break;
      const expanded = view.getUint32(cursor + 24,true);
      total += expanded;
      if (expanded > 48 * 1024 * 1024 || total > 128 * 1024 * 1024)
        throw new Error("Office 文件解压后超过预览上限，请下载查看。");
      cursor += 46 + view.getUint16(cursor + 28,true) + view.getUint16(cursor + 30,true) + view.getUint16(cursor + 32,true);
      if (i === count - 1 && cursor === footer) return;
    }
    break;
  }
  throw new Error("无法读取 Office 文件目录，请确认文件完整且未加密。");
}
