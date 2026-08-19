import { NextResponse } from "next/server";
export const dynamic="force-dynamic";
async function getJson(url:string){const r=await fetch(url,{cache:"no-store",headers:{"user-agent":"StandbyRadar/0.6"}});const text=await r.text();let json:unknown=null;try{json=JSON.parse(text);}catch{}return{status:r.status,json,text:json?null:text.slice(0,4000)};}
export async function GET(){
 const base="https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/vild/FeatureServer";
 const q=(layer:number)=>`${base}/${layer}/query?where=roadnumber%20LIKE%20'A%25'&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=5&f=geojson`;
 const [rest,service,fuel,parking]=await Promise.all([18,19,23,20].map(async layer=>({layer,...await getJson(q(layer))})));
 return NextResponse.json({rest,service,fuel,parking});
}