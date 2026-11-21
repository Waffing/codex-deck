import { useMemo, useState } from "react";
import type { WorkBook } from "xlsx";
import { utils } from "xlsx";

export default function SpreadsheetView({ workbook }: { workbook: WorkBook }) {
  const [sheet, pickSheet] = useState(workbook.SheetNames[0]);
  const [query, search] = useState("");
  const [page, setPage] = useState(0);
  const cells = workbook.Sheets[sheet];
  const grid = useMemo(() => {
    if (!cells) return { error: "此文件没有可显示的工作表。" };
    const range = utils.decode_range(cells["!ref"] || "A1");
    const rows = range.e.r - range.s.r + 1, cols = range.e.c - range.s.c + 1;
    if (cols > 512 || rows > 100_000 || rows * cols > 2_000_000)
      return { error: "此工作表超过预览上限，请下载原文件。" };
    const values = utils.sheet_to_json<unknown[]>(cells, { header: 1, raw: false, defval: "", blankrows: false });
    return { values: values.map(row => row.map(cell => String(cell ?? ""))) };
  }, [cells]);
  if (!grid.values) return <p role="alert">{grid.error}</p>;
  const [header = [], ...body] = grid.values;
  const needle = query.trim().toLocaleLowerCase();
  const rows = needle ? body.filter(row => row.some(cell => cell.toLocaleLowerCase().includes(needle))) : body;
  const pages = Math.max(1, Math.ceil(rows.length / 100));
  return <>
    <div className="dv-tools"><label>工作表 <select aria-label="工作表" value={sheet} onChange={e => {pickSheet(e.target.value); setPage(0);}}>{workbook.SheetNames.map(name=><option key={name}>{name}</option>)}</select></label>
      <input aria-label="表内搜索" type="search" placeholder="搜索表格内容" value={query} onChange={e=>{search(e.target.value); setPage(0);}} /></div>
    <div className="dv-table-scroll"><table><thead><tr>{header.map((h,i)=><th key={i} scope="col">{h || utils.encode_col(i)}</th>)}</tr></thead><tbody>
      {rows.slice(page * 100, (page + 1) * 100).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>
    <div className="dv-tools"><small>{rows.length} 行</small>{pages > 1 && <><button disabled={!page} onClick={()=>setPage(page - 1)}>上一页</button><small>{page + 1} / {pages}</small><button disabled={page + 1 >= pages} onClick={()=>setPage(page + 1)}>下一页</button></>}</div>
  </>;
}
