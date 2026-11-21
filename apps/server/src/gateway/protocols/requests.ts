import { responseRequestSchema, type ResponseRequest } from "@codexdeck/shared";
import { toChatRequest, chatTools, chatToolName } from "../transforms.js";

export type Wire = "responses" | "chat" | "messages";
export type Obj = Record<string, unknown>;

export function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
}
function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}
function list(value: unknown, name: string): Obj[] {
  if (!Array.isArray(value) || !value.every(v => v && typeof v === "object" && !Array.isArray(v))) return invalid("Invalid " + name + ".");
  return value as Obj[];
}
function text(value: unknown, name: string): string {
  return typeof value === "string" ? value : invalid("Invalid " + name + ".");
}
function pick(source: Obj, keys: string[]): Obj {
  return Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}

// Ordered Responses input items form the canonical IR. Wire-specific options are
// kept out of the upstream body unless its protocol understands them.
export interface CanonicalRequest {
  request: ResponseRequest;
  options: { thinking?: unknown; stop?: unknown; streamUsage?: boolean };
}
function contentPart(block: Obj, role: unknown): Obj {
  if (block.type === "text") return { type: role === "assistant" ? "output_text" : "input_text", text: text(block.text, "text") };
  if (block.type === "image_url") {
    const image = object(block.image_url);
    return {type:"input_image",image_url:text(image.url,"image URL"),...pick(image,["detail"])};
  }
  if (block.type === "image") {
    const source = object(block.source);
    const url = source.type === "base64" ? "data:" + text(source.media_type,"image type") + ";base64," + text(source.data,"image data") : text(source.url,"image URL");
    return {type:"input_image",image_url:url};
  }
  return invalid("Unsupported content block.");
}
function history(messages: Obj[], wire: Wire) {
  const items: Obj[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "tool" && wire === "chat") {
      items.push({type:"function_call_output",call_id:text(message.tool_call_id,"tool call ID"),output:message.content});
      continue;
    }
    const roles = wire === "messages" ? ["user","assistant"] : ["system","developer","user","assistant"];
    if (!roles.includes(String(role))) invalid("Invalid message role.");
    let pending: Obj[] = [];
    const flush = () => { if (pending.length) items.push({ role, content:pending }); pending = []; };
    if (typeof message.content === "string") items.push({role,content:message.content});
    else if (message.content != null) {
      for (const block of list(message.content, "content")) {
        if (block.type === "tool_use" && role === "assistant") {
          flush();
          items.push({type:"function_call",call_id:text(block.id,"tool ID"),name:text(block.name,"tool name"),arguments:JSON.stringify(object(block.input))});
        } else if (block.type === "tool_result" && role === "user") {
          flush();
          const output = typeof block.content === "string" ? block.content : list(block.content ?? [],"tool result").map(part=>contentPart(part,role));
          items.push({type:"function_call_output",call_id:text(block.tool_use_id,"tool ID"),output,...(block.is_error ? {status:"incomplete"} : {})});
        } else if ((block.type === "thinking" || block.type === "redacted_thinking") && role === "assistant") {
          flush();
          items.push({type:"reasoning",summary:block.type === "thinking" ? [{type:"summary_text",text:text(block.thinking,"thinking")}] : [],
            encrypted_content: block.type === "thinking" ? block.signature : block.data});
        } else pending.push(contentPart(block,role));
      }
      flush();
    }
    if (message.tool_calls) {
      for (const tool of list(message.tool_calls,"tool calls")) {
        const fn = object(tool.function);
        items.push({type:"function_call",call_id:text(tool.id,"call ID"),name:text(fn.name,"function name"),arguments:text(fn.arguments,"arguments")});
      }
    }
  }
  return items;
}
export function decodeRequest(wire: Wire, raw: unknown): CanonicalRequest {
  const body = object(raw);
  let source: Obj = body;
  if (wire !== "responses") {
    if (wire === "messages" && body.max_tokens === undefined) invalid("Messages requests require max_tokens.");
    if (wire === "chat" && body.n !== undefined && body.n !== 1) invalid("This gateway supports one completion per request.");
    const input = history(list(body.messages, "messages"), wire);
    if (!input.length) invalid("A message is required.");
    source = {...pick(body,["model","stream","temperature","top_p","metadata"]),input,max_output_tokens: body.max_completion_tokens ?? body.max_tokens};
    if (body.system) source.instructions = typeof body.system === "string" ? body.system : list(body.system,"system").map(part=>text(part.text,"system text")).join("\n");
    if (body.reasoning_effort) source.reasoning = {effort:body.reasoning_effort};
    if (body.response_format) {
      const format=object(body.response_format);
      source.text={format: format.type==="json_schema" ? {type:"json_schema",...object(format.json_schema)} : format};
    }
    if (body.tools) source.tools = list(body.tools,"tools").map(tool => {
      if (wire === "chat") {
        if(tool.type !== "function") invalid("Unsupported Chat tool.");
        return {type:"function",...object(tool.function)};
      }
      return {type:"function",name:text(tool.name,"tool name"),description:tool.description,parameters:tool.input_schema};
    });
    if (body.tool_choice !== undefined) {
      const choice = object(body.tool_choice);
      source.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : wire === "chat" ? {type:"function",name:object(choice.function).name}
        : choice.type === "tool" ? {type:"function",name:choice.name} : choice.type === "any" ? "required" : choice.type;
      if (choice.disable_parallel_tool_use !== undefined) source.parallel_tool_calls = !choice.disable_parallel_tool_use;
    }
    if (body.parallel_tool_calls !== undefined) source.parallel_tool_calls=body.parallel_tool_calls;
  }
  const result = responseRequestSchema.safeParse(source);
  if (!result.success) invalid("Invalid " + wire + " request.");
  return { request:result.data, options:{thinking:wire === "messages" ? body.thinking : undefined,
    stop:wire==="messages"?body.stop_sequences:wire==="chat"?body.stop:undefined, streamUsage:object(body.stream_options).include_usage === true} };
}
function anthropicContent(value: unknown): Obj[] {
  if (typeof value === "string") return [{type:"text",text:value}];
  return list(value,"message content").map(part => {
    if (["input_text","output_text","text"].includes(String(part.type))) return {type:"text",text:text(part.text,"text")};
    if (part.type === "input_image") {
      const url=text(part.image_url,"image URL"), data=/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(url);
      return {type:"image",source:data?{type:"base64",media_type:data[1],data:data[2]}:{type:"url",url}};
    }
    return invalid("Unsupported message content for Anthropic.");
  });
}
function argumentsObject(value: unknown): Obj {
  try {
    const parsed:unknown=JSON.parse(text(value,"tool arguments"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Obj;
  } catch { /* Report a client input error without disclosing arguments. */ }
  return invalid("Tool arguments must be a JSON object.");
}
export function encodeRequest(wire: Wire, ir: CanonicalRequest, model: string): Obj {
  const request=ir.request;
  if (wire === "responses") {
    if(ir.options.stop) invalid("This Responses upstream does not support stop sequences.");
    const body:Obj={...request,model};
    if(!body.reasoning && ir.options.thinking) {
      const config=object(ir.options.thinking);
      if(config.type==="enabled" || config.type==="adaptive"){
        const budget=Number(config.budget_tokens??0);
        body.reasoning={effort:budget>=8192?"high":budget>0 && budget<=2048?"low":"medium",summary:"auto"};
      }
    }
    return body;
  }
  if (wire === "chat") return {...toChatRequest(request,model), ...(ir.options.stop ? {stop:ir.options.stop} : {})};
  if (request.previous_response_id || request.conversation) invalid("Messages translation requires the full input history.");
  const messages:{role:string;content:Obj[]}[]=[], system:string[]=[];
  if (request.instructions) system.push(request.instructions);
  const add=(role:string,content:Obj[])=>{
    const last=messages.at(-1);
    if (last?.role===role) last.content.push(...content);
    else messages.push({role,content});
  };
  const items:Obj[]=typeof request.input==="string"?[{role:"user",content:request.input}]:request.input;
  for (const item of items) {
    if (item.type==="function_call") add("assistant",[{type:"tool_use",id:item.call_id,name:chatToolName(text(item.name,"function name"),item.namespace),input:argumentsObject(item.arguments)}]);
    else if (item.type==="function_call_output") add("user",[{type:"tool_result",tool_use_id:item.call_id,content:anthropicContent(item.output),...(item.status==="incomplete"&&{is_error:true})}]);
    else if (item.type==="reasoning") {
      const summary=Array.isArray(item.summary)?item.summary.map(p=>object(p).text).join(""):"";
      if (item.encrypted_content) add("assistant",[summary?{type:"thinking",thinking:summary,signature:item.encrypted_content}:{type:"redacted_thinking",data:item.encrypted_content}]);
    } else if (item.role==="system" || item.role==="developer") {
      for (const p of anthropicContent(item.content)) system.push(text(p.text,"system text"));
    } else if(item.role==="assistant" || item.role==="user") add(item.role,anthropicContent(item.content));
    else invalid("Unsupported Responses input item for Messages.");
  }
  const body:Obj={model,messages,max_tokens:request.max_output_tokens,stream:request.stream,...pick(request,["temperature","top_p"])};
  if(system.length) body.system=system.join("\n");
  if(ir.options.thinking) body.thinking=ir.options.thinking;
  else if(["low","medium","high","xhigh"].includes(String(object(request.reasoning).effort)) && (request.max_output_tokens??0)>1024){
    const budgets:Record<string,number>={low:1024,medium:4096,high:8192,xhigh:16384};
    body.thinking={type:"enabled",budget_tokens:Math.min(request.max_output_tokens!-1,budgets[String(object(request.reasoning).effort)]!)};
  }
  if(ir.options.stop) body.stop_sequences=Array.isArray(ir.options.stop)?ir.options.stop:[ir.options.stop];
  if(request.tools) body.tools=chatTools(request.tools).declarations.map(tool=>{
    const fn=object(tool.function);
    return {name:fn.name,description:fn.description,input_schema:fn.parameters??{type:"object",properties:{}}};
  });
  if(request.tool_choice || request.parallel_tool_calls===false) {
    const c=request.tool_choice??"auto";
    body.tool_choice={...(typeof c==="string"?{type:c==="required"?"any":c}:{type:"tool",name:chatToolName(text(c.name,"tool name"),c.namespace)}),...(request.parallel_tool_calls===false?{disable_parallel_tool_use:true}:{})};
  }
  return body;
}
