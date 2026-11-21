export async function api<T>(url:string,init?:RequestInit):Promise<T>{
  const res=await fetch(url,{...init,credentials:"same-origin"});
  if(!res.ok){
    const body=await res.json().catch(()=>({}));
    const id=res.headers.get("x-request-id");
    const detail=typeof body.error==="string"?body.error:"请求失败（"+res.status+"）";
    throw Object.assign(new Error(detail+(id?" · "+id:"")),{status:res.status,code:body.code});
  }
  return res.status===204?undefined as T:await res.json() as T;
}
export function json(method:string,data?:unknown):RequestInit{
  return data===undefined ? {method} : {method,headers:{"content-type":"application/json"},body:JSON.stringify(data)};
}
