import {lookup} from "node:dns/promises";
import type {Server} from "node:http";
import {connect,type Socket} from "node:net";
import {privateAddress} from "../gateway/transport.js";

// Clients in a namespace can request public HTTPS connections through the same
// session-owned Unix socket; the workspace never joins the control network.
export function enableNamespaceHttps(relay:Server) {
  const active=new Set<Socket>();
  relay.on("connect",async(req,client,head)=>{
    const authority=/^([a-z0-9.-]+|\[[a-f0-9:]+\]):443$/i.exec(req.url??"");
    if(!authority || active.size>=16) {client.end("HTTP/1.1 403 Forbidden\r\n\r\n");return;}
    const local=client as Socket;
    active.add(local);
    local.once("close",()=>active.delete(local));
    local.on("error",()=>local.destroy());
    try {
      const addresses=await lookup(authority[1].replace(/^\[|\]$/g,""),{all:true});
      if(!addresses.length || addresses.some(entry=>privateAddress(entry.address))) {
        local.end("HTTP/1.1 403 Forbidden\r\n\r\n");return;
      }
      if(local.destroyed) return;
      const upstream=connect({host:addresses[0].address,port:443,family:addresses[0].family});
      local.once("close",()=>upstream.destroy());
      upstream.once("error",()=>local.destroy());
      upstream.setTimeout(120_000,()=>upstream.destroy());
      upstream.once("close",()=>local.destroy());
      upstream.once("connect",()=>{
        local.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if(head.length) upstream.write(head);
        local.pipe(upstream).pipe(local);
      });
    } catch {local.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");}
  });
  return ()=>{for(const socket of active) socket.destroy();};
}
