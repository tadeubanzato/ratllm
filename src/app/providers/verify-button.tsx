"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function VerifyProviderButton({providerId,disabled=false}:{providerId:string;disabled?:boolean}){
  const [busy,setBusy]=useState(false); const router=useRouter();
  async function verify(){setBusy(true);try{await fetch(`/api/providers/${providerId}/verify`,{method:"POST"});router.refresh();}finally{setBusy(false)}}
  return <button className="button" type="button" onClick={verify} disabled={disabled||busy}>{busy?"Checking…":"Verify"}</button>;
}
