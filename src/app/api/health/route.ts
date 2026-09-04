import { NextResponse } from "next/server";
export async function GET(){return NextResponse.json({status:"healthy",checks:{app:{status:"healthy"}},timestamp:new Date().toISOString()})}
