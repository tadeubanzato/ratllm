"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Radar } from "lucide-react";
export function DiscoveryButton(){const[message,setMessage]=useState("");const[busy,setBusy]=useState(false);const router=useRouter();async function run(){setBusy(true);setMessage("Running discovery across all enabled sources…");try{const response=await fetch("/api/discovery/run",{method:"POST"});const body=await response.json();if(!response.ok)throw new Error(body.error?.message??"Discovery failed");setMessage(`${body.discovered} source observations saved`);router.refresh()}catch(error){setMessage(error instanceof Error?error.message:"Discovery failed")}finally{setBusy(false)}}return <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:10,color:"var(--muted)"}}>{message}</span><button className="button primary" type="button" onClick={run} disabled={busy}><Radar size={14}/>{busy?"Discovering…":"Run discovery"}</button></div>}
