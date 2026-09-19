import { randomUUID } from "node:crypto";
import { tickScheduler } from "@/server/automation/service";
import { writeWorkerHeartbeat } from "@/server/worker-heartbeat";
const interval=Number(process.env.WORKER_POLL_MS??10_000);let running=false;
async function tick(){if(running)return;running=true;try{const results=await tickScheduler();for(const result of results)if(result.status==="rejected")console.error("automation run failed",result.reason);console.info(`scheduler tick: ${results.length} due job(s)`);}catch(error){console.error("scheduler tick failed",error);}finally{running=false;}}
const workerId=`worker-${randomUUID().slice(0,8)}`;
// Independent of tick(): a tick awaits every due job, so it can be silent for minutes while the worker is perfectly healthy.
async function beat(){try{await writeWorkerHeartbeat(workerId);}catch(error){console.error("worker heartbeat failed",error);}}
console.info("RATLLM worker started; database scheduler enabled");void beat();setInterval(()=>void beat(),15_000);void tick();setInterval(()=>void tick(),interval);
