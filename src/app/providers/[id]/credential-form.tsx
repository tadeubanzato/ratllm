"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function CredentialForm({providerId,defaultEnv}:{providerId:string;defaultEnv:string}) {
  const [message,setMessage]=useState(""); const [busy,setBusy]=useState(false); const router=useRouter();
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element=event.currentTarget; const form=new FormData(element); setBusy(true);setMessage("Encrypting and saving…");
    try {
      const apiKey=String(form.get("apiKey")??"");
      const response=await fetch(`/api/providers/${providerId}/credential`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({environmentVariable:form.get("environmentVariable"),...(apiKey?{apiKey}:{})})});
      const body=await response.json(); if(!response.ok)throw new Error(body.error?.message??"Save failed");
      element.reset();setMessage("Credential saved securely. Test the credential to verify it.");router.refresh();
    }catch(error){setMessage(error instanceof Error?error.message:"Unable to save credential")}finally{setBusy(false)}
  }
  async function verify(){setBusy(true);setMessage("Checking provider…");try{const response=await fetch(`/api/providers/${providerId}/verify`,{method:"POST"});const body=await response.json();setMessage(body.message??body.error?.message??"Verification failed");router.refresh()}catch{setMessage("Connection failed. Check network connectivity and retry.")}finally{setBusy(false)}}
  return <form onSubmit={submit} className="settings-form"><label>Environment reference<input className="input" name="environmentVariable" defaultValue={defaultEnv} required pattern="[A-Z][A-Z0-9_]*"/></label><label>API key<input className="input" name="apiKey" type="password" autoComplete="new-password" placeholder="Enter replacement or leave blank to use environment reference" minLength={8}/><small>Stored encrypted. Leave blank only when the reference exists on the server.</small></label><div className="settings-actions"><button className="button primary" type="submit" disabled={busy}>Save credential</button><button className="button" type="button" onClick={verify} disabled={busy}>Test credential</button></div>{message&&<p role="status" className="settings-feedback">{message}</p>}</form>;
}
