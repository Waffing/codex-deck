import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { utils, write } from "xlsx";

const requireServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { ZipFile } = requireServer("yazl");

async function wordDocument() {
  const zip = new ZipFile();
  const add = (name, value) => zip.addBuffer(Buffer.from(value), name);
  add("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Default Extension="png" ContentType="image/png"/></Types>');
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  const types = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  add("_rels/.rels", rels + '<Relationship Id="rId1" Target="word/document.xml" Type="'+types+'officeDocument"/></Relationships>');
  add("word/_rels/document.xml.rels", rels + '<Relationship Id="rIdImage" Target="media/pixel.png" Type="'+types+'image"/></Relationships>');
  zip.addBuffer(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=","base64"),"word/media/pixel.png");
  add("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>发布确认单</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>检查完毕</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="pixel"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>');
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function viewerJourney({page, origin, workspaceId}) {
  const prefix = "g1-" + randomUUID().slice(0,8);
  const workbook = utils.book_new();
  for (const name of ["概要","验收"]) utils.book_append_sheet(workbook, utils.aoa_to_sheet([["负责人","状态"],["李青",name],["王明","排期"]]),name);
  const pdfPage = await page.context().newPage();
  await pdfPage.setContent("<h1>CodexDeck</h1>");
  const pdf = await pdfPage.pdf();
  await pdfPage.close();
  const diagram = "flowchart LR\n  A[入口] --> B[预览]";
  const source = {
    docx:await wordDocument(), csv:"名称,结果\n文件,通过\n脚本,排期",
    xls:write(workbook,{type:"buffer",bookType:"biff8"}),xlsx:write(workbook,{type:"buffer",bookType:"xlsx"}),
    pdf, html:'<!doctype html><meta charset="utf-8"><p>等待</p><script>document.querySelector("p").textContent="脚本已运行"</script>',
    svg:'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><text x="10" y="30">矢量标记</text></svg>',
    mmd:diagram,md:"# 交付流程\n\n```mermaid\n"+diagram+"\n```",
  };
  for (const [extension,value] of Object.entries(source)) {
    const upload = await page.request.post(origin+"/api/workspaces/"+workspaceId+"/files/upload",{
      multipart:{file:{name:prefix+"."+extension,mimeType:"application/octet-stream",buffer:Buffer.isBuffer(value)?value:Buffer.from(value)}},
    });
    assert.equal(upload.status(),201,extension);
  }
  await page.goto(origin+"/console/artifacts");
  await page.getByLabel("显示全部文件").check();
  for (const extension of Object.keys(source)) {
    const filename=prefix+"."+extension;
    await page.getByLabel("搜索文件名").fill(filename);
    await page.locator("button.hub-file").filter({has:page.locator("strong",{hasText:new RegExp(filename.replace(".","\\.")+"$")})}).first().click();
    const viewer=page.getByRole("region",{name:"文档预览"});
    if(extension==="docx") {
      await viewer.getByText("发布确认单",{exact:true}).waitFor();
      await viewer.getByRole("cell",{name:"检查完毕"}).waitFor();
      await viewer.locator("img[src^='data:image/png']").waitFor();
    } else if (["xls","xlsx","csv"].includes(extension)) {
      if(extension!=="csv") await viewer.getByLabel("工作表").selectOption("验收");
      await viewer.getByLabel("表内搜索").fill(extension==="csv"?"通过":"李青");
      await viewer.getByRole("cell",{name:extension==="csv"?"通过":"验收",exact:true}).waitFor();
      assert.equal(await viewer.getByRole("cell",{name:"排期",exact:true}).count(),0);
    } else if(extension==="pdf") {
      await viewer.getByText("1 / 1",{exact:true}).waitFor();
      await page.waitForFunction(()=>document.querySelector(".dv-pdf")?.width>300);
    } else if(extension==="html" || extension==="svg") {
      const frame=viewer.locator("iframe");
      assert.equal(await frame.getAttribute("sandbox"),"allow-scripts");
      await frame.contentFrame().getByText(extension==="html"?"脚本已运行":"矢量标记",{exact:true}).waitFor();
      const response = await page.request.get(origin+await frame.getAttribute("src"));
      assert.match(response.headers()["content-security-policy"],/sandbox allow-scripts;/);
      assert.doesNotMatch(response.headers()["content-security-policy"],/allow-same-origin/);
      if(extension==="html") {
        await viewer.getByRole("button",{name:"手机视口"}).click();
        await viewer.getByRole("button",{name:"源码",exact:true}).click();
        await viewer.locator("pre").filter({hasText:"<script>"}).waitFor();
      } else {
        await viewer.getByRole("button",{name:"棋盘格背景"}).click();
        assert.equal(await viewer.locator(".dv-checker").count(),0);
        await viewer.getByLabel("SVG 缩放").selectOption("2");
      }
    } else {
      if(extension==="md") await viewer.getByRole("heading",{name:"交付流程"}).waitFor();
      await viewer.locator('iframe[title="Mermaid 图表"]').contentFrame().locator("main svg").waitFor();
    }
    await page.getByRole("button",{name:"关闭抽屉",exact:true}).click();
  }
}
