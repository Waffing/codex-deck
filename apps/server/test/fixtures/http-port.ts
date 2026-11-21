import {randomInt} from "node:crypto";
import {once} from "node:events";
import type {Server} from "node:http";

// Some Windows hosts allocate ports from 1024; Fetch rejects several otherwise valid ports there.
export async function withTestHttpPort<T>(listen:(port:number)=>Promise<T>):Promise<T> {
  for(let attempt=0;;attempt++) {
    try {return await listen(randomInt(49152,65536));}
    catch(error) {
      if(attempt>=15 || !["EADDRINUSE","EACCES"].includes((error as NodeJS.ErrnoException).code??"")) throw error;
    }
  }
}
export function listenHttpFixture(server:Server):Promise<number> {
  return withTestHttpPort(async port=>{
    const listening=once(server,"listening");
    server.listen(port,"127.0.0.1");
    await listening;
    return port;
  });
}
