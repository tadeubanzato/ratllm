"use client";
import { useState } from "react";import { useRouter } from "next/navigation";
export function SyncButton(){const[state,setState]=useState("Sync inventory");const router=useRouter();async function sync(){setState("Syncing…");const response=await fetch("/api/litellm/sync",{method:"POST"});setState(response.ok?"Sync complete":"Sync failed");if(response.ok)router.refresh()}return <button className="button primary" onClick={sync} disabled={state==="Syncing…"}>{state}</button>}
