import http from "node:http";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import WebSocket from "ws";
import type { ServerContext } from "../app.js";
import { authenticated } from "../auth.js";
import {scopedGuest} from "../temp-access/routes.js";
import type { Deployer } from "./deployer.js";
import { fail } from "./probe.js";

export function registerPreview(app: FastifyInstance, ctx:ServerContext, deployer:Deployer) {
  void app.register(async sub=>{
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser("*",(_req,payload,done)=>done(null,payload));
    const targets=new WeakMap<FastifyRequest,{host:string;port:number;path:string}>();
    async function prepare(req:FastifyRequest,reply:FastifyReply) {
      const params=req.params as {port?:string;workspace?:string;"*":string};
      const guest=scopedGuest(req);
      if(params.port !== undefined && !guest && !authenticated(ctx,req)) return reply.code(401).send({error:"Authentication required."});
      const scope=params.port!==undefined && guest ? deployer.rows().find(row=>deployer.dto(row).port===Number(params.port) && guest.link.workspace_ids.includes(row.workspace_id))?.workspace_id : params.workspace;
      if(guest && (!scope || !guest.link.workspace_ids.includes(scope))) throw fail(403,"Workspace outside invitation scope.");
      const port=params.port !== undefined ? await deployer.runningPort(Number(params.port),scope) : await deployer.livePort(params.workspace!);
      const route=req.url.replace(/^\/(preview|live)\/[^/]+/,"");
      if(!route.startsWith("/") || route.startsWith("//") || route.includes("\\")) throw fail(400,"Invalid preview path.");
      targets.set(req,{...deployer.upstream(port),path:route});
    }
    async function httpProxy(req:FastifyRequest,reply:FastifyReply) {
      const target=targets.get(req)!;
      const headers:Record<string,string>={};
      for(const name of ["accept","accept-language","content-type","range","if-modified-since","if-none-match"]) {
        const value=req.headers[name];if(typeof value==="string") headers[name]=value;
      }
      const response=await new Promise<http.IncomingMessage>((resolve,reject)=>{
        const out=http.request({hostname:target.host,port:target.port,path:target.path,method:req.method,headers,timeout:15000},resolve);
        out.once("error",()=>reject(fail(502,"Preview upstream is unavailable.")));
        out.once("timeout",()=>out.destroy());
        reply.raw.once("close",()=>out.destroy());
        if(req.body instanceof Readable) req.body.pipe(out); else out.end();
      });
      reply.code(response.statusCode ?? 502);
      for(const name of ["content-type","content-length","content-range","etag","last-modified","accept-ranges"]) {
        const value=response.headers[name]; if(value) reply.header(name,value);
      }
      const location=response.headers.location;
      if(location && location.startsWith("/") && !location.startsWith("//") && !location.includes("\\")) {
        reply.header("location",req.url.split("/").slice(0,3).join("/")+location);
      }
      reply.header("content-security-policy","sandbox allow-scripts allow-forms; base-uri 'none'; object-src 'none'; worker-src 'none'; frame-ancestors 'self'");
      reply.header("x-content-type-options","nosniff"); reply.header("cache-control","no-store");
      return reply.send(response);
    }
    function wsProxy(client:WebSocket,req:FastifyRequest) {
      const target=targets.get(req)!;
      const upstream=new WebSocket("ws://"+target.host+":"+target.port+target.path,{followRedirects:false,maxPayload:2*1024*1024,handshakeTimeout:5000});
      const stop=()=>{client.terminate();upstream.terminate();};
      upstream.on("error",stop);client.on("error",stop);
      upstream.on("close",()=>client.close()); client.on("close",()=>{if(upstream.readyState===WebSocket.OPEN) upstream.close(); else upstream.terminate();});
      const waiting:{data:WebSocket.RawData;binary:boolean}[]=[];
      let size=0;
      client.on("message",(data,binary)=>{
        if(upstream.readyState===WebSocket.OPEN) upstream.send(data,{binary});
        else {
          size+=Array.isArray(data)?data.reduce((n,v)=>n+v.length,0):data.byteLength;
          if(size>2*1024*1024) stop();else waiting.push({data,binary});
        }
      });
      upstream.on("open",()=>{for(const {data,binary} of waiting) upstream.send(data,{binary});waiting.length=0;});
      upstream.on("message",(data,binary)=>{if(client.readyState===WebSocket.OPEN) client.send(data,{binary});});
    }
    for(const url of ["/preview/:port/*","/live/:workspace/*"]) {
      sub.route({method:"GET",url,preHandler:prepare,handler:httpProxy,wsHandler:wsProxy});
      sub.route({method:["POST","PUT","PATCH","DELETE","OPTIONS"],url,preHandler:prepare,handler:httpProxy});
    }
  });
}
