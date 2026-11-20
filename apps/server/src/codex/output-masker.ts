import type { SecretMasker } from "../security/secret-masker.js";

type Frame = {method:string; payload:Record<string,unknown>; ready:boolean};
type Channel = {text:string;frames:Frame[];field:string;discard:boolean};
const prefixes = ["sk-","bearer ","ghp_","gho_","ghu_","ghs_","ghr_","github_pat_","akIA","asia",
  "xoxb-","xoxa-","xoxp-","xoxr-","xoxs-","cdk_live_","cdlease_","token","api_key","api-key","apikey","authorization"];
const tokenTail = /(?:\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|cdk_live_|cdlease_)[\w-]*|\bBearer\s+[\w.+/=-]*|\b(?:token|api[_-]?key|authorization)\s*(?:[:=]\s*["']?[^,\s"'}]*)?)$/i;
const suffixes = new Set(prefixes.flatMap(prefix=>Array.from({length:prefix.length},(_,i)=>prefix.slice(0,i+1).toLowerCase())));

export class OutputMasker {
  private readonly queue:Frame[]=[];
  private readonly channels=new Map<string,Channel>();
  private bytes=0;
  constructor(private masker:SecretMasker, private emit:(method:string,payload:Record<string,unknown>)=>void) {}

  push(method:string,payload:Record<string,unknown>) {
    const field = typeof payload.delta==="string" ? "delta" : method==="stderr" ? "text" : "";
    if (!field || typeof payload[field]!=="string") {
      if (method==="turn/completed" || method==="item/completed") this.flush(method==="item/completed" ? String((payload.item as {id?:string})?.id ?? "") : undefined);
      this.queue.push({method,payload,ready:true});
    } else {
      const key=JSON.stringify([String(payload.itemId ?? ""),method,payload.stream ?? ""]);
      const channel=this.channels.get(key) ?? {text:"",frames:[],field,discard:false};
      const part={method,payload:{...payload},ready:false};
      this.queue.push(part); channel.frames.push(part);
      let value=String(payload[field]);
      if (channel.discard) {
        const boundary=value.search(/[\s,'"}]/);
        if (boundary<0) value="";
        else { value=value.slice(boundary); channel.discard=false; }
      }
      channel.text+=value;
      this.channels.set(key,channel);
      if (!this.ambiguous(channel.text)) this.release(key,channel);
    }
    this.bytes+=JSON.stringify(payload).length;
    if (this.bytes>1024*1024) {
      // Drop undecidable fragments under pressure instead of disclosing a partial credential.
      for (const [key,channel] of this.channels) {
        channel.text="[REDACTED]"; channel.discard=true; this.release(key,channel);
      }
    }
    this.drain();
  }
  flush(item?:string) {
    for (const [key,channel] of this.channels)
      if (item===undefined || JSON.parse(key)[0]===item) { this.release(key,channel); this.channels.delete(key); }
    this.drain();
  }
  private ambiguous(text:string) {
    if (this.masker.endsWithSecretPrefix(text) || tokenTail.test(text)) return true;
    const tail=text.slice(-14).toLowerCase();
    for (let i=0;i<tail.length;i++) if(suffixes.has(tail.slice(i))) return true;
    return false;
  }
  private release(key:string,channel:Channel) {
    const masked=this.masker.maskString(channel.text);
    const rewritten=channel.discard || masked!==channel.frames.map(f=>f.payload[channel.field]).join("");
    for (const [index,frame] of channel.frames.entries()) {
      if (rewritten) frame.payload[channel.field]=index===0 ? masked : "";
      frame.ready=true;
    }
    channel.frames=[]; channel.text="";
    if (!channel.discard) this.channels.delete(key);
  }
  private drain() {
    while(this.queue[0]?.ready) {
      const frame=this.queue.shift()!;
      this.emit(frame.method,frame.payload);
    }
    if (!this.queue.length) this.bytes=0;
  }
}
