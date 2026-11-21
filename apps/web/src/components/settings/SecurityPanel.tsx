import {useEffect,useState} from "react";
import {QRCodeSVG} from "qrcode.react";
import type {SecurityConfig,SecurityPatch} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {Feedback,useAction,timeLabel} from "./common";

const alerts={new_device:"新 IP 或设备登录",login_ban:"登录失败触发封禁",totp_changed:"双重验证变更",guest_online:"访客首次上线",guest_exhausted:"访客额度用尽"};
type Device={session_id:string;ip:string;user_agent:string;last_active_at:string;current?:boolean};
type Ban={ip:string;banned_until:number};
export function SecurityPanel() {
  const [config,setConfig]=useState<SecurityConfig>(),[draft,setDraft]=useState<SecurityPatch>({});
  const [devices,setDevices]=useState<Device[]>([]),[bans,setBans]=useState<Ban[]>([]),[myIp,setIp]=useState("");
  const [enroll,setEnroll]=useState<{otpauth_uri:string;manual_key:string}>(),[codes,setCodes]=useState<string[]>([]),[otp,setOtp]=useState("");
  const [ranges,setRanges]=useState(""),[confirmReset,setReset]=useState(false);
  const action=useAction();
  const change=(patch:SecurityPatch)=>setDraft(current=>({...current,...patch}));
  async function load(){
    const [value,sessions,blocks,client]=await Promise.all([api<SecurityConfig>("/api/security/config"),api<Device[]>("/api/security/sessions"),
      api<Ban[]>("/api/security/bans"),api<{ip:string}>("/api/security/my-ip")]);
    setConfig(value);setRanges(value.ip_ranges.join("\n"));setDevices(sessions);setBans(blocks);setIp(client.ip);setDraft({});
  }
  useEffect(()=>{void action.run(load);},[]);
  const value={...config,...draft} as SecurityConfig;
  return <><Feedback {...action}/>{config && <>
    <form className="ad-card settings-form" onSubmit={e=>{e.preventDefault();
      if(config.public_enabled && draft.public_enabled===false && !window.confirm("关闭公网准入会立即断开远程访问，可在 SSH 中用 cdx public on 恢复。继续关闭？"))return;
      void action.run(async()=>{await api("/api/security/config",json("PATCH",draft));await load();
    },"安全策略已保存");}}>
      <h2>访问策略</h2>
      {([["public_enabled","允许公网访问","关闭后仅允许本机管理。仅本机安装的实例，首次开放端口需在 SSH 中运行 cdx public on。"],
        ["entry_enabled","启用安全入口","访客需要从指定路径进入管理员登录页。"],
        ["brute_force_enabled","封禁连续登录失败的 IP","连续失败达到阈值后暂时阻止登录。"],
        ["captcha_enabled","登录图形验证码","登录时额外验证图片上的字符。"],
        ["single_session","仅允许一台设备登录","新登录成功后退出其他设备。"],
        ["basic_enabled","外层 HTTP Basic 认证","浏览器会先要求输入独立的外层凭据。"]] as const).map(([key,label,hint])=>
        <label key={key}><span>{label}<small>{hint}</small></span><input aria-label={label} type="checkbox" checked={value[key]} onChange={e=>change({[key]:e.target.checked})}/></label>)}
      <label>安全入口路径<input value={value.entry_path} minLength={9} maxLength={65} onChange={e=>change({entry_path:e.target.value})}/></label>
      <button className="ad-button" type="button" onClick={()=>change({entry_path:"/"+Array.from(crypto.getRandomValues(new Uint8Array(8)),n=>"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-"[n%64]).join("")})}>随机入口</button>
      <label>未授权访问页<select value={value.disguise} onChange={e=>change({disguise:e.target.value as SecurityConfig["disguise"]})}><option value="nginx_404">Nginx 404</option><option value="blank_200">白页 200</option><option value="forbidden_403">拒绝访问 403</option></select></label>
      <label>连续失败次数<input type="number" min="1" max="100" required value={value.max_failures} onChange={e=>change({max_failures:e.target.valueAsNumber})}/></label>
      <label>封禁分钟数<input type="number" min="1" max="10080" required value={value.ban_minutes} onChange={e=>change({ban_minutes:e.target.valueAsNumber})}/></label>
      <label>会话有效期<select value={value.session_hours} onChange={e=>change({session_hours:Number(e.target.value) as SecurityConfig["session_hours"]})}>{([2,24,168,720] as const).map((n,i)=><option key={n} value={n}>{["2 小时","24 小时","7 天","30 天"][i]}</option>)}</select></label>
      <label>IP 访问规则<select value={value.ip_mode} onChange={e=>change({ip_mode:e.target.value as SecurityConfig["ip_mode"]})}><option value="off">关闭</option><option value="allow">白名单</option><option value="deny">黑名单</option></select></label>
      <label>IP 或 CIDR 网段<textarea value={ranges} placeholder="每行一个 IP 或网段" onChange={e=>{setRanges(e.target.value);change({ip_ranges:e.target.value.split(/[\s,]+/).filter(Boolean)});}}/></label>
      <button type="button" className="ad-button" onClick={()=>{const list=[...new Set([...value.ip_ranges,myIp])];setRanges(list.join("\n"));change({ip_ranges:list});}}>填入我当前 IP · {myIp}</button>
      {value.ip_mode==="allow"&&<small>保存前请确认列表包含当前 IP，避免自己失去访问权限。</small>}
      {value.basic_enabled&&<><label>外层用户名<input required value={value.basic_user} onChange={e=>change({basic_user:e.target.value})}/></label>
        <label>外层密码<input type="password" minLength={12} autoComplete="new-password" placeholder="留空保留现有密码" value={draft.basic_password??""} onChange={e=>change({basic_password:e.target.value||undefined})}/></label></>}
      <h2>通知渠道订阅</h2>
      {(Object.keys(alerts) as (keyof typeof alerts)[]).map(key=><label key={key}>{alerts[key]}<input type="checkbox" checked={value.alerts.includes(key)} onChange={e=>change({alerts:e.target.checked?[...value.alerts,key]:value.alerts.filter(k=>k!==key)})}/></label>)}
      <button className="ad-primary" disabled={action.busy}>保存安全策略</button>
    </form>
    <section className="ad-card settings-form"><h2>双重验证</h2>
      {!config.totp_enabled && !enroll && <button className="ad-button" onClick={()=>void action.run(async()=>{setEnroll(await api("/api/security/totp/enroll",json("POST",{})));setCodes([]);})}>设置身份验证器</button>}
      {enroll && <><QRCodeSVG value={enroll.otpauth_uri} size={168} marginSize={4} title="身份验证器二维码"/><small>扫描二维码，或手动输入密钥</small><code>{enroll.manual_key}</code></>}
      {(enroll || config.totp_enabled)&&<form onSubmit={e=>{e.preventDefault();void action.run(async()=>{
        if(enroll) {const r=await api<{recovery_codes:string[]}>("/api/security/totp/activate",json("POST",{otp}));setCodes(r.recovery_codes);setEnroll(undefined);}
        else {await api("/api/security/totp/disable",json("POST",{otp}));setCodes([]);}
        setOtp("");await load();
      });}}><label>动态口令或恢复码<input required value={otp} autoComplete="one-time-code" onChange={e=>setOtp(e.target.value)}/></label>
        <button className="ad-button" disabled={action.busy}>{enroll?"校验并启用":"验证并关闭双重验证"}</button></form>}
      {!!codes.length&&<div><strong>保存这 8 个一次性恢复码</strong><pre>{codes.join("\n")}</pre><button className="ad-button" onClick={()=>setCodes([])}>已安全保存</button></div>}
    </section>
    <section className="ad-card settings-form"><h2>活跃设备</h2>{devices.map(d=><div key={d.session_id} className="settings-row"><span>{d.ip} {d.current?"· 当前设备":""}<small>{d.user_agent} · {timeLabel(d.last_active_at)}</small></span><button className="ad-button" onClick={()=>void action.run(async()=>{await api("/api/security/sessions/"+encodeURIComponent(d.session_id),{method:"DELETE"});if(d.current)location.reload();else await load();})}>退出设备</button></div>)}
      <h2>封禁 IP</h2>{!bans.length&&<small>当前没有被封禁的 IP。</small>}{bans.map(b=><div className="settings-row" key={b.ip}>{b.ip} · {timeLabel(new Date(b.banned_until).toISOString())}<button className="ad-button" onClick={()=>void action.run(async()=>{await api("/api/security/bans/"+encodeURIComponent(b.ip),{method:"DELETE"});await load();})}>解封</button></div>)}
      {confirmReset&&<p role="alert">恢复后仅允许本机访问，并清除双重验证、恢复码、外层认证和 IP 封禁。请先确认能通过 SSH 运行 cdx。</p>}
      <button className="ad-button" onClick={()=>{if(!confirmReset){setReset(true);return;}void action.run(async()=>{await api("/api/security/reset",json("POST",{}));setReset(false);await load();});}}>{confirmReset?"确认恢复安全默认值":"恢复安全默认值"}</button>
    </section></>}</>;
}
