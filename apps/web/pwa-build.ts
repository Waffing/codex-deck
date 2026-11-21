import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import type {Plugin} from "vite";

// Emit the worker after Rollup has assigned the final chunk names. No runtime
// URL patterns can accidentally admit a private response into Cache Storage.
export function staticShellWorker():Plugin {
  return {name:"codexdeck-static-shell",apply:"build",generateBundle(_,bundle){
    const icons=["codexdeck.svg","icon-192.png","icon-512.png","apple-touch-icon.png"];
    const urls=Object.keys(bundle).filter(name=>/^assets\/[^/]+\.(?:js|css|woff2?|ttf|otf)$/.test(name))
      .map(name=>"/"+name).concat(icons.map(name=>"/icons/"+name)).sort();
    const template=readFileSync(new URL("./service-worker.js",import.meta.url),"utf8");
    const hash=createHash("sha256").update(JSON.stringify(urls)).update(template);
    for(const file of icons)hash.update(readFileSync(new URL("./public/icons/"+file,import.meta.url)));
    this.emitFile({type:"asset",fileName:"sw.js",source:template
      .replace('"__BUILD__"',JSON.stringify(hash.digest("hex").slice(0,16)))
      .replace('"__STATIC_URLS__"',JSON.stringify(urls))});
  }};
}
