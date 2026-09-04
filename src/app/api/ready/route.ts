import { NextResponse } from "next/server";
import { databaseHealth } from "@/server/db/client";
import { env } from "@/server/config";
export async function GET(){if(env.DEMO_MODE)return NextResponse.json({status:"ready",mode:"demo",checks:{app:{status:"healthy"},database:{status:"healthy"}}});try{const database=await databaseHealth();return NextResponse.json({status:"ready",checks:{app:{status:"healthy"},database}})}catch{return NextResponse.json({status:"not_ready",checks:{app:{status:"healthy"},database:{status:"offline"}}},{status:503})}}
