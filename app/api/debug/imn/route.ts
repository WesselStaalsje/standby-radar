import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(){
  const r=await fetch("https://www.stichtingimn.nl/rayons.php",{cache:"no-store",headers:{"user-agent":"StandbyRadar/0.6"}});
  const b=Buffer.from(await r.arrayBuffer());
  const text=b.toString("latin1");
  const snippets:Record<string,string>={};
  for(const code of ["NB296","NB321","GL249","GL270","U224"]){const p=text.indexOf(code);snippets[code]=p>=0?text.slice(Math.max(0,p-800),p+9000):"NOT FOUND";}
  return NextResponse.json({status:r.status,length:text.length,snippets});
}