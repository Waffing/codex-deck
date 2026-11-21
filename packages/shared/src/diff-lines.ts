export interface DiffLine {
  text:string;
  file:string|null;
  line:number|null;
  side:"old"|"new"|null;
}

// Git quotes non-ASCII paths with octal UTF-8 bytes when core.quotePath is on.
function headerPath(field:string) {
  let value=field.split("\t",1)[0];
  if(value.startsWith('"') && value.endsWith('"')) {
    const escapes:Record<string,string>={t:"\t",n:"\n",r:"\r",a:"\x07",b:"\b",f:"\f",v:"\v"};
    value=value.slice(1,-1).replace(/(?:\\[0-7]{3})+|\\(.)/g,(encoded:string,character?:string)=>{
      if(character!==undefined) return escapes[character]??character;
      return new TextDecoder().decode(Uint8Array.from(encoded.match(/[0-7]{3}/g)!,s=>parseInt(s,8)));
    });
  }
  return value==="/dev/null"?null:value.replace(/^[ab]\//,"");
}

export function parseDiffLines(patch:string):DiffLine[] {
  let previous:string|null=null,current:string|null=null,hunk=false,oldLine=0,newLine=0;
  return patch.split("\n").map(text=>{
    const row:DiffLine={text,file:null,line:null,side:null};
    if(text.startsWith("diff --git ")) {previous=null;current=null;hunk=false;}
    else if(text.startsWith("@@ ")) {
      const match=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      hunk=Boolean(match);
      if(match) {oldLine=Number(match[1]);newLine=Number(match[2]);}
    } else if(!hunk && text.startsWith("--- ")) previous=headerPath(text.slice(4));
    else if(!hunk && text.startsWith("+++ ")) current=headerPath(text.slice(4));
    else if(hunk) {
      if(text.startsWith("+")) return {...row,file:current,line:newLine++,side:"new"};
      if(text.startsWith("-")) return {...row,file:previous,line:oldLine++,side:"old"};
      if(text.startsWith(" ")) {newLine++;oldLine++;}
    }
    return {...row,file:current??previous};
  });
}
