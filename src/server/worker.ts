import { tickScheduler } from "@/server/automation/service";
const interval=Number(process.env.WORKER_POLL_MS??10_000);let running=false;
async function tick(){if(running)return;running=true;try{const results=await tickScheduler();for(const result of results)if(result.status==="rejected")console.error("automation run failed",result.reason);console.info(`scheduler tick: ${results.length} due job(s)`);}catch(error){console.error("scheduler tick failed",error);}finally{running=false;}}
console.info("RATLLM worker started; database scheduler enabled");void tick();setInterval(()=>void tick(),interval);
