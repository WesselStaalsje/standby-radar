import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
async function get(url:string){const r=await fetch(url,{cache:"no-store",headers:{"user-agent":"StandbyRadar/0.6"}});const b=Buffer.from(await r.arrayBuffer());return{status:r.status,text:b.toString("latin1")};}
export async function GET(){
  const [rayons,own]=await Promise.all([get("https://www.stichtingimn.nl/rayons.php"),get("https://www.stichtingimn.nl/kaart-own.php")]);
  const p=rayons.text.indexOf("NB296");
  return NextResponse.json({rayons:{status:rayons.status,length:rayons.text.length,snippet:p>=0?rayons.text.slice(p-300,p+3000):"NOT FOUND"},own:{status:own.status,length:own.text.length,html:own.text.slice(0,40000)}});
}